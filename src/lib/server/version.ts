import { version } from '../../../package.json';
import type { UpdateStatus, VersionInfo } from '../update';
// for its reading of `.env`: the switch below may be set there
import './config';

/** The version that is running. */
export const CURRENT: string = version;

/** Where releases are published. The one place that says so on this side. */
export const REPO = 'vargaking/wtfwid';
export const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES = `https://github.com/${REPO}/releases`;

/** One file of a release, as GitHub lists it. */
export interface Asset {
	name: string;
	size: number;
	url: string;
	/** `sha256:<hex>`, when GitHub gave one. */
	digest: string | null;
}

export interface Release {
	version: string;
	/** The release's page, for a person to open. */
	url: string;
	assets: Asset[];
}

function parts(v: unknown): [number, number, number] | null {
	const m = typeof v === 'string' ? /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim()) : null;
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether version `a` is newer than `b`. A version that cannot be read is never newer. */
export function newer(a: string, b: string): boolean {
	const x = parts(a);
	const y = parts(b);
	if (!x || !y) return false;
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
	return false;
}

/**
 * Reads GitHub's answer. Anything unexpected is "nothing known". The link to the release's
 * page is built here from the tag, so nothing the network said becomes a link on screen
 * except a version number.
 */
export function toRelease(body: any): Release | null {
	const tag = body?.tag_name;
	if (!parts(tag) || body.draft || body.prerelease) return null;
	const assets: Asset[] = (Array.isArray(body.assets) ? body.assets : []).flatMap((a: any) =>
		typeof a?.name === 'string' && typeof a.browser_download_url === 'string' && Number.isSafeInteger(a.size)
			? [{ name: a.name, size: a.size, url: a.browser_download_url, digest: typeof a.digest === 'string' ? a.digest : null }]
			: []
	);
	return { version: tag.trim().replace(/^v/, ''), url: `${RELEASES}/tag/${tag.trim()}`, assets };
}

const REUSE_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 5000;

/** `WTFWID_NO_UPDATE_CHECK=1` turns the check off: nothing is ever fetched. */
const off = () => !!process.env.WTFWID_NO_UPDATE_CHECK && process.env.WTFWID_NO_UPDATE_CHECK !== '0';

let kept: { url: string; at: number; known: boolean; answer: Promise<Release | null> } | null = null;

/**
 * The newest release, or null when nothing is known. One request to GitHub's public API,
 * with no token: the user's GitHub token is for their repositories and is never sent here.
 * The answer is kept for 6 hours. Being offline or rate-limited is not an error: it means
 * "nothing known", and is asked again after 30 minutes.
 */
export function latestRelease(fetcher: typeof fetch = fetch, url = LATEST_URL, now = Date.now()): Promise<Release | null> {
	if (off()) return Promise.resolve(null);
	if (kept && kept.url === url && now - kept.at < (kept.known ? REUSE_MS : RETRY_MS)) return kept.answer;
	const asked = { url, at: now, known: false, answer: ask(fetcher, url) };
	asked.answer.then((release) => (asked.known = release !== null));
	kept = asked;
	return asked.answer;
}

async function ask(fetcher: typeof fetch, url: string): Promise<Release | null> {
	try {
		const res = await fetcher(url, {
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wtfwid' },
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		return res.ok ? toRelease(await res.json()) : null;
	} catch {
		return null;
	}
}

// How electron-builder names the files (`artifactName` in package.json):
// wtfwid-0.1.1-linux-x86_64.AppImage, wtfwid-0.1.1-mac-arm64.dmg, wtfwid-0.1.1-win-x64.exe
const SYSTEMS: Record<string, { os: string; ext: string }> = {
	linux: { os: 'linux', ext: 'AppImage' },
	darwin: { os: 'mac', ext: 'dmg' },
	win32: { os: 'win', ext: 'exe' }
};
const ARCHES: Record<string, string[]> = { x64: ['x64', 'x86_64'], arm64: ['arm64', 'aarch64'] };

/** The file of a release that is for this machine, or null. */
export function pickAsset(assets: Asset[], platform: string, arch: string): Asset | null {
	const system = SYSTEMS[platform];
	const names = ARCHES[arch];
	if (!system || !names) return null;
	const ends = names.map((a) => `-${system.os}-${a}.${system.ext}`);
	return assets.find((asset) => ends.some((end) => asset.name.endsWith(end))) ?? null;
}

/**
 * What installs a new version. Only the desktop app provides one (electron/update.js),
 * the same way it provides the keychain: the server runs inside its process.
 */
export interface Installer {
	/** Whether this copy of the app can replace itself at all. */
	canInstall(): boolean;
	status(): UpdateStatus;
	/** Starts the download and returns at once. Null when it started, else a sentence saying why not. */
	install(asset: { url: string; size: number; digest: string | null }): string | null;
	/** Starts the new version. Only does anything after an install has finished. */
	restart(): boolean;
}

export const currentInstaller = (): Installer | undefined => (globalThis as { __wtfwidUpdate?: Installer }).__wtfwidUpdate;

/** What the screen is told about versions, and the file an install would fetch. */
export function offer(
	release: Release | null,
	installer: Pick<Installer, 'canInstall'> | undefined,
	current = CURRENT,
	platform: string = process.platform,
	arch: string = process.arch
): { info: VersionInfo; asset: Asset | null } {
	if (!release || !newer(release.version, current)) return { info: { current, latest: null, canInstall: false }, asset: null };
	const asset = installer?.canInstall() ? pickAsset(release.assets, platform, arch) : null;
	return { info: { current, latest: { version: release.version, url: release.url }, canInstall: asset !== null }, asset };
}

/** Starts installing the newest version. Null when it started, else a sentence saying why it cannot. */
export function startInstall(release: Release | null, installer: Installer | undefined, current = CURRENT, platform?: string, arch?: string): string | null {
	if (!installer?.canInstall()) return 'This copy of wtfwid cannot replace itself. Download the new version from the release page.';
	const { info, asset } = offer(release, installer, current, platform, arch);
	if (!info.latest) return 'There is no newer version to install.';
	if (!asset) return 'The new version has no file for this machine.';
	return installer.install({ url: asset.url, size: asset.size, digest: asset.digest });
}
