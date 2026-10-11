// Installing a new version (S-82), for the one case where the app can replace itself
// safely: it runs from a Linux AppImage, which is a single file. The new file is downloaded
// next to the old one, checked, and moved over it. Nothing here imports Electron, so the
// tests run all of it against a local server; main.js adds the restart.
import { createHash } from 'node:crypto';
import { accessSync, constants, createWriteStream, realpathSync, statSync } from 'node:fs';
import { chmod, rename, rm, stat } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * The only place a new version is ever downloaded from: a file of a release of this
 * repository. GitHub redirects such a link to its file host, and that redirect is followed;
 * the check is on the link GitHub's API gave.
 */
export const DOWNLOAD_PREFIX = 'https://github.com/vargaking/wtfwid/releases/download/';

/** If no data arrives for this long, the download is given up. */
const STALL_MS = 60_000;

/** A failure with a sentence that can be shown as it is. It sits in the header, so it is short. */
class UpdateError extends Error {}

const WRONG_SIZE = 'The download has the wrong size.';
const WRONG_DIGEST = 'The download does not match its checksum.';

/**
 * The link in the form it will be fetched, or null when it is not under `prefix`. Compared
 * after parsing, so `..`, a user name before the host or a look-alike host do not get through.
 */
export function allowedUrl(url, prefix = DOWNLOAD_PREFIX) {
	try {
		const href = new URL(url).href;
		return href.startsWith(prefix) ? href : null;
	} catch {
		return null;
	}
}

/** The hex SHA-256 to expect, null when GitHub gave none. Anything else it gave is refused. */
function wantedDigest(digest) {
	if (digest === null || digest === undefined || digest === '') return null;
	const m = typeof digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(digest) : null;
	if (!m) throw new UpdateError('The checksum GitHub gave cannot be read.');
	return m[1].toLowerCase();
}

/**
 * The AppImage this process runs from, or null. `APPIMAGE` alone is not proof: a wtfwid
 * started from a terminal or an editor that is itself an AppImage inherits theirs, and
 * replacing that file would break another program. The AppImage runtime also sets `APPDIR`,
 * the folder it unpacked itself into; only when this program's own file is inside it is
 * `APPIMAGE` ours.
 */
export function ownAppImage({ platform = process.platform, packaged, execPath = process.execPath, env = process.env }) {
	if (platform !== 'linux' || !packaged || !env.APPIMAGE || !env.APPDIR) return null;
	try {
		if (!execPath.startsWith(realpathSync(env.APPDIR) + sep)) return null;
		return realpathSync(env.APPIMAGE);
	} catch {
		return null;
	}
}

/** Whether `file` can be replaced: it is there, and its folder can be written to. */
export function replaceable(file) {
	if (!file) return false;
	try {
		if (!statSync(file).isFile()) return false;
		accessSync(dirname(file), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Downloads `asset` and puts it where `target` is. Resolves when the new file is in place.
 * On any failure it throws a sentence saying what failed, removes what it downloaded and
 * leaves `target` as it was.
 *
 * `asset` is what GitHub's API said about the file: `url`, `size` in bytes and
 * `digest` (`sha256:<hex>`). `fetcher` and `allowedPrefix` are parameters for the tests;
 * the app uses the defaults.
 */
export async function replaceAppImage(target, asset, { fetcher = fetch, allowedPrefix = DOWNLOAD_PREFIX, onProgress = () => {}, stallMs = STALL_MS } = {}) {
	const href = allowedUrl(asset.url, allowedPrefix);
	if (!href) throw new UpdateError('The download link is not a wtfwid release.');
	if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new UpdateError('GitHub did not say how big the download is.');
	// GitHub publishes a SHA-256 for every file uploaded since mid 2025. Without one there
	// is nothing to tell the real file from a swapped one, so nothing is installed: the
	// screen falls back to the link to the release page.
	const digest = wantedDigest(asset.digest);
	if (!digest) throw new UpdateError('GitHub published no checksum for this file.');

	// Next to the AppImage, so moving it into place stays on one disk and happens at once.
	const part = `${target}.download`;
	const stop = new AbortController();
	const stall = setTimeout(() => stop.abort(), stallMs);
	try {
		// No token and no cookie: the file is public.
		const res = await fetcher(href, { headers: { 'User-Agent': 'wtfwid' }, signal: stop.signal });
		if (!res.ok || !res.body) throw new UpdateError(`The download failed: GitHub answered ${res.status}.`);

		let bytes = 0;
		const hash = createHash('sha256');
		const count = new Transform({
			transform(chunk, _encoding, done) {
				bytes += chunk.length;
				// stop a file that is longer than promised before it fills the disk
				if (bytes > asset.size) return done(new UpdateError(WRONG_SIZE));
				hash.update(chunk);
				stall.refresh();
				onProgress(bytes);
				done(null, chunk);
			}
		});
		// Written straight to disk, never held in memory: the file is over 100 MB. `wx`
		// refuses a file that is already there, so a leftover is removed first; it is not
		// runnable until it has been checked.
		await rm(part, { force: true });
		await pipeline(Readable.fromWeb(res.body), count, createWriteStream(part, { flags: 'wx', mode: 0o600, flush: true }));

		if (bytes !== asset.size || (await stat(part)).size !== asset.size) throw new UpdateError(WRONG_SIZE);
		if (hash.digest('hex') !== digest) throw new UpdateError(WRONG_DIGEST);

		try {
			await chmod(part, 0o755);
			// One step: there is never a moment with half a file under the AppImage's name. The
			// running app is not disturbed, it keeps the old file open. The name stays the same,
			// old version number and all, so launchers that point at it keep working.
			await rename(part, target);
		} catch {
			throw new UpdateError('The new file could not be moved over the AppImage.');
		}
	} catch (error) {
		await rm(part, { force: true }).catch(() => {});
		if (error instanceof UpdateError) throw error;
		if (error?.code === 'ENOSPC') throw new UpdateError('There is not enough room on the disk.');
		if (['EACCES', 'EPERM', 'EROFS', 'EEXIST'].includes(error?.code)) throw new UpdateError('Could not write next to the AppImage.');
		throw new UpdateError('The download did not finish.');
	} finally {
		clearTimeout(stall);
	}
}

/**
 * What the server is given to install a version with (`globalThis.__wtfwidUpdate`).
 * `appImage` is the file to replace, null where the app cannot replace itself. `relaunch`
 * starts the app again; it is only ever called from `restart()`, after a finished install.
 */
export function createUpdater({ appImage, relaunch, ...options }) {
	let status = { state: 'idle' };
	return {
		canInstall: () => replaceable(appImage),
		status: () => status,
		/** Starts the download and returns at once: null when it started, else why it did not. */
		install(asset) {
			if (!replaceable(appImage)) return 'This copy of wtfwid cannot replace itself.';
			if (status.state === 'downloading') return 'The new version is already downloading.';
			if (status.state === 'ready') return 'The new version is already downloaded. Restart to finish.';
			status = { state: 'downloading', bytes: 0, total: asset.size };
			replaceAppImage(appImage, asset, { ...options, onProgress: (bytes) => (status = { state: 'downloading', bytes, total: asset.size }) }).then(
				() => (status = { state: 'ready' }),
				(error) => (status = { state: 'failed', message: error.message })
			);
			return null;
		},
		/** Restarts into the new version. Does nothing unless an install has finished. */
		restart() {
			if (status.state !== 'ready') return false;
			relaunch();
			return true;
		}
	};
}
