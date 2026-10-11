import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REPO } from '../src/lib/server/version.ts';
import { DOWNLOAD_PREFIX, allowedUrl, createUpdater, ownAppImage, replaceAppImage, replaceable } from './update.js';

// The "new version": big enough to arrive in several pieces.
const NEW = randomBytes(300_000);
const OLD = 'the old version';
const sha256 = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

// A local stand-in for GitHub: release files under the same path as the real ones, which
// redirect to a "file host" the way GitHub does.
let server;
let prefix;
let requests;
const routes = {
	'/files/wtfwid.AppImage': (res) => res.end(NEW),
	'/files/short.AppImage': (res) => res.end(NEW.subarray(0, 1000)),
	// starts, then never sends the rest
	'/files/stalls.AppImage': (res) => {
		res.writeHead(200, { 'Content-Length': NEW.length });
		res.write(NEW.subarray(0, 1000));
	},
	// never stops sending, until the other side hangs up
	'/files/endless.AppImage': (res) => {
		const more = setInterval(() => res.write(NEW.subarray(0, 50_000)), 2);
		res.on('close', () => clearInterval(more));
	}
};

beforeAll(async () => {
	server = http.createServer((req, res) => {
		requests.push({ url: req.url, headers: req.headers });
		const release = /^\/vargaking\/wtfwid\/releases\/download\/v9\.9\.9\/(.+)$/.exec(req.url);
		if (release && routes[`/files/${release[1]}`]) {
			res.writeHead(302, { Location: `/files/${release[1]}` });
			res.end();
		} else if (routes[req.url]) routes[req.url](res);
		else {
			res.statusCode = 404;
			res.end('Not Found');
		}
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	prefix = `http://127.0.0.1:${server.address().port}/vargaking/wtfwid/releases/download/`;
});
afterAll(() => {
	server.closeAllConnections();
	server.close();
});
beforeEach(() => (requests = []));

/** A folder with an "AppImage" in it, named after an old version as a real one is. */
async function installed() {
	const dir = await mkdtemp(join(tmpdir(), 'wtfwid-update-'));
	const file = join(dir, 'wtfwid-0.1.1-linux-x86_64.AppImage');
	await writeFile(file, OLD, { mode: 0o755 });
	return { dir, file };
}
const asset = (over = {}) => ({ url: `${prefix}v9.9.9/wtfwid.AppImage`, size: NEW.length, digest: sha256(NEW), ...over });
const replace = (file, over, options) => replaceAppImage(file, asset(over), { allowedPrefix: prefix, ...options });

/** After a failure: the old file is as it was, and nothing else is left in the folder. */
async function expectUntouched({ dir, file }) {
	expect(await readFile(file, 'utf8')).toBe(OLD);
	expect(await readdir(dir)).toEqual(['wtfwid-0.1.1-linux-x86_64.AppImage']);
}

describe('where a new version may come from', () => {
	it('S-82: only files of a release of this repository', () => {
		expect(DOWNLOAD_PREFIX).toBe(`https://github.com/${REPO}/releases/download/`);
		const real = 'https://github.com/vargaking/wtfwid/releases/download/v0.1.2/wtfwid-0.1.2-linux-x86_64.AppImage';
		expect(allowedUrl(real)).toBe(real);
		for (const other of [
			'https://github.com/someone-else/wtfwid/releases/download/v0.1.2/wtfwid-0.1.2-linux-x86_64.AppImage',
			'https://github.com/vargaking/wtfwid-fork/releases/download/v0.1.2/x.AppImage',
			'http://github.com/vargaking/wtfwid/releases/download/v0.1.2/x.AppImage',
			'https://github.com.example.com/vargaking/wtfwid/releases/download/v0.1.2/x.AppImage',
			'https://example.com/vargaking/wtfwid/releases/download/v0.1.2/x.AppImage',
			// tricks that read as allowed until the address is worked out
			'https://github.com/vargaking/wtfwid/releases/download/../../../../someone-else/x/releases/download/v1/x.AppImage',
			'https://github.com/vargaking/wtfwid/releases/download/%2e%2e/%2e%2e/%2e%2e/%2e%2e/someone-else/x.AppImage',
			'https://github.com/vargaking/wtfwid/releases/download/..\\..\\..\\..\\someone-else/x.AppImage',
			'https://github.com@example.com/vargaking/wtfwid/releases/download/v0.1.2/x.AppImage',
			'https://github.com:444/vargaking/wtfwid/releases/download/v0.1.2/x.AppImage',
			'file:///etc/passwd',
			'not a link',
			'',
			null,
			undefined
		]) {
			expect(allowedUrl(other), String(other)).toBeNull();
		}
	});

	it('S-82: a link from anywhere else is refused before anything is asked for', async () => {
		const app = await installed();
		const elsewhere = prefix.replace('/vargaking/', '/someone-else/');
		await expect(replace(app.file, { url: `${elsewhere}v9.9.9/wtfwid.AppImage` })).rejects.toThrow('The download link is not a wtfwid release.');
		await expect(replace(app.file, { url: `${prefix}../../../../../files/wtfwid.AppImage` })).rejects.toThrow('The download link is not a wtfwid release.');
		// with the app's own settings, the local server is "anywhere else" too
		await expect(replaceAppImage(app.file, asset())).rejects.toThrow('The download link is not a wtfwid release.');
		expect(requests).toEqual([]);
		await expectUntouched(app);
	});
});

describe('replacing the AppImage', () => {
	it('S-82: downloads, checks and swaps the file in place, keeping its name', async () => {
		const app = await installed();
		const progress = [];
		await replace(app.file, {}, { onProgress: (bytes) => progress.push(bytes) });

		expect(Buffer.compare(await readFile(app.file), NEW)).toBe(0);
		// same name as before, old version number and all, and nothing left beside it
		expect(await readdir(app.dir)).toEqual(['wtfwid-0.1.1-linux-x86_64.AppImage']);
		if (process.platform !== 'win32') expect((await stat(app.file)).mode & 0o777).toBe(0o755);

		// it arrived in pieces, counted as it came
		expect(progress.length).toBeGreaterThan(1);
		expect(progress).toEqual([...progress].sort((a, b) => a - b));
		expect(progress.at(-1)).toBe(NEW.length);

		// GitHub's redirect to its file host was followed, and nothing about you was sent
		expect(requests.map((r) => r.url)).toEqual(['/vargaking/wtfwid/releases/download/v9.9.9/wtfwid.AppImage', '/files/wtfwid.AppImage']);
		for (const { headers } of requests) {
			expect(headers.authorization).toBeUndefined();
			expect(headers.cookie).toBeUndefined();
			expect(headers['user-agent']).toBe('wtfwid');
		}
	});

	it('S-82: a download that is not the promised size leaves the old file untouched', async () => {
		const app = await installed();
		// shorter than promised
		await expect(replace(app.file, { url: `${prefix}v9.9.9/short.AppImage` })).rejects.toThrow('The download has the wrong size.');
		await expectUntouched(app);
		// longer than promised: stopped as soon as it runs over
		await expect(replace(app.file, { size: 5000, digest: null })).rejects.toThrow('The download has the wrong size.');
		await expectUntouched(app);
		// a file with no end is not left to fill the disk
		await expect(replace(app.file, { url: `${prefix}v9.9.9/endless.AppImage`, size: 5000, digest: null })).rejects.toThrow('The download has the wrong size.');
		await expectUntouched(app);
		// a size that is no size
		for (const size of [0, -1, 1.5, Number.NaN, undefined, '300000']) {
			await expect(replace(app.file, { size })).rejects.toThrow('GitHub did not say how big the download is.');
		}
		await expectUntouched(app);
	});

	it('S-82: a download that does not match its checksum leaves the old file untouched', async () => {
		const app = await installed();
		await expect(replace(app.file, { digest: sha256('something else') })).rejects.toThrow('The download does not match its checksum.');
		await expectUntouched(app);
		// a checksum that cannot be read is not the same as none: refused, and nothing is fetched
		requests = [];
		for (const digest of ['md5:d41d8cd98f00b204e9800998ecf8427e', 'sha256:abc', 'sha512:' + 'a'.repeat(128), sha256(NEW).slice(7), 42]) {
			await expect(replace(app.file, { digest })).rejects.toThrow('The checksum GitHub gave cannot be read.');
		}
		expect(requests).toEqual([]);
		await expectUntouched(app);
	});

	it('S-82: with no checksum from GitHub, the size alone is checked', async () => {
		const app = await installed();
		await replace(app.file, { digest: null });
		expect(Buffer.compare(await readFile(app.file), NEW)).toBe(0);
		// a checksum written in capitals is the same checksum
		const again = await installed();
		await replace(again.file, { digest: sha256(NEW).toUpperCase().replace('SHA256', 'sha256') });
		expect(Buffer.compare(await readFile(again.file), NEW)).toBe(0);
	});

	it('S-82: a download that fails or stops leaves the old file untouched', async () => {
		const app = await installed();
		await expect(replace(app.file, { url: `${prefix}v9.9.9/missing.AppImage` })).rejects.toThrow('The download failed: GitHub answered 404.');
		await expectUntouched(app);
		await expect(replace(app.file, { url: `${prefix}v9.9.9/stalls.AppImage` }, { stallMs: 150 })).rejects.toThrow('The download did not finish.');
		await expectUntouched(app);
		// offline
		const offline = () => Promise.reject(new TypeError('fetch failed'));
		await expect(replace(app.file, {}, { fetcher: offline })).rejects.toThrow('The download did not finish.');
		await expectUntouched(app);
	});

	it('S-82: what an earlier try left behind is not built on', async () => {
		const app = await installed();
		await writeFile(`${app.file}.download`, 'half of an earlier download');
		await replace(app.file);
		expect(Buffer.compare(await readFile(app.file), NEW)).toBe(0);
		expect(await readdir(app.dir)).toEqual(['wtfwid-0.1.1-linux-x86_64.AppImage']);
	});

	it.skipIf(process.platform === 'win32')('S-82: a link planted where the download goes is not written through', async () => {
		const app = await installed();
		const elsewhere = join(app.dir, 'someone-elses-file');
		await writeFile(elsewhere, 'precious');
		await symlink(elsewhere, `${app.file}.download`);
		await replace(app.file);
		expect(await readFile(elsewhere, 'utf8')).toBe('precious');
		expect(Buffer.compare(await readFile(app.file), NEW)).toBe(0);
	});
});

describe('which file is this app', () => {
	it('S-82: only an AppImage this program really runs from', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'wtfwid-own-'));
		const mount = join(dir, 'mount');
		await mkdir(mount);
		const appImage = join(dir, 'wtfwid-0.1.1-linux-x86_64.AppImage');
		await writeFile(appImage, OLD);
		const env = { APPIMAGE: appImage, APPDIR: mount };
		const own = { platform: 'linux', packaged: true, execPath: join(mount, 'wtfwid'), env };

		expect(ownAppImage(own)).toBe(appImage);
		// run from source, or not Linux
		expect(ownAppImage({ ...own, packaged: false })).toBeNull();
		expect(ownAppImage({ ...own, platform: 'darwin' })).toBeNull();
		expect(ownAppImage({ ...own, platform: 'win32' })).toBeNull();
		// not an AppImage at all
		expect(ownAppImage({ ...own, env: {} })).toBeNull();
		expect(ownAppImage({ ...own, env: { APPIMAGE: appImage } })).toBeNull();
		// started from a terminal that is itself an AppImage: its file, not ours
		expect(ownAppImage({ ...own, execPath: '/opt/wtfwid/wtfwid' })).toBeNull();
		expect(ownAppImage({ ...own, execPath: `${mount}-other/wtfwid` })).toBeNull();
		// the file or the folder is gone
		expect(ownAppImage({ ...own, env: { ...env, APPIMAGE: join(dir, 'gone.AppImage') } })).toBeNull();
		expect(ownAppImage({ ...own, env: { ...env, APPDIR: join(dir, 'gone') } })).toBeNull();
	});

	it('S-82: it can be replaced when it is a file in a folder that can be written to', async () => {
		const app = await installed();
		expect(replaceable(app.file)).toBe(true);
		expect(replaceable(null)).toBe(false);
		expect(replaceable(undefined)).toBe(false);
		expect(replaceable(join(app.dir, 'gone.AppImage'))).toBe(false);
		expect(replaceable(app.dir)).toBe(false);
	});

	// Root may write anywhere, so as root this cannot be tried and is skipped. It carries no
	// statement ID for that reason: `pnpm spec --strict` counts a skipped test as a failing one.
	it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('it cannot be replaced when its folder is read-only', async () => {
		const app = await installed();
		await chmod(app.dir, 0o555);
		expect(replaceable(app.file)).toBe(false);
		await chmod(app.dir, 0o755);
	});
});

describe('the installer the server is given', () => {
	const until = async (check) => {
		for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	};

	it('S-82: reports downloading, then ready, and only then restarts, and only when asked', async () => {
		const app = await installed();
		let relaunched = 0;
		const updater = createUpdater({ appImage: app.file, relaunch: () => relaunched++, allowedPrefix: prefix });
		expect(updater.canInstall()).toBe(true);
		expect(updater.status()).toEqual({ state: 'idle' });
		expect(updater.restart()).toBe(false);

		expect(updater.install(asset())).toBeNull();
		expect(updater.status()).toEqual({ state: 'downloading', bytes: 0, total: NEW.length });
		// not twice at once, and no restart into a half-finished download
		expect(updater.install(asset())).toBe('The new version is already downloading.');
		expect(updater.restart()).toBe(false);

		await until(() => updater.status().state !== 'downloading');
		expect(updater.status()).toEqual({ state: 'ready' });
		expect(Buffer.compare(await readFile(app.file), NEW)).toBe(0);
		// finishing the download does not restart anything by itself
		expect(relaunched).toBe(0);
		expect(updater.install(asset())).toBe('The new version is already downloaded. Restart to finish.');

		expect(updater.restart()).toBe(true);
		expect(relaunched).toBe(1);
	});

	it('S-82: a failed install says why, changes nothing and never restarts', async () => {
		const app = await installed();
		let relaunched = 0;
		const updater = createUpdater({ appImage: app.file, relaunch: () => relaunched++, allowedPrefix: prefix });
		expect(updater.install(asset({ digest: sha256('something else') }))).toBeNull();
		await until(() => updater.status().state !== 'downloading');
		expect(updater.status()).toEqual({ state: 'failed', message: 'The download does not match its checksum.' });
		expect(updater.restart()).toBe(false);
		expect(relaunched).toBe(0);
		await expectUntouched(app);
	});

	it('S-82: where the app does not run from an AppImage, nothing can be installed', async () => {
		let relaunched = 0;
		const updater = createUpdater({ appImage: null, relaunch: () => relaunched++, allowedPrefix: prefix });
		expect(updater.canInstall()).toBe(false);
		expect(updater.install(asset())).toBe('This copy of wtfwid cannot replace itself.');
		expect(updater.status()).toEqual({ state: 'idle' });
		expect(updater.restart()).toBe(false);
		expect(requests).toEqual([]);
		expect(relaunched).toBe(0);
	});
});
