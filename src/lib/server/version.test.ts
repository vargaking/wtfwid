import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURRENT, LATEST_URL, REPO, latestRelease, newer, offer, pickAsset, startInstall, toRelease, type Installer, type Release } from './version';

// The shape of GitHub's answer for a release, with the fields wtfwid reads and a few it does not.
const github = (tag = 'v0.1.2') => ({
	tag_name: tag,
	html_url: 'https://example.com/not-used',
	draft: false,
	prerelease: false,
	assets: ['linux-x86_64.AppImage', 'mac-arm64.dmg', 'win-x64.exe'].map((end, i) => ({
		name: `wtfwid-${tag.replace(/^v/, '')}-${end}`,
		size: 1000 + i,
		digest: `sha256:${String(i).repeat(64)}`,
		browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/wtfwid-${tag.replace(/^v/, '')}-${end}`,
		content_type: 'application/octet-stream'
	}))
});
const release = (tag = 'v0.1.2') => toRelease(github(tag)) as Release;

/** A stand-in for fetch that counts how often it is asked and records what it was sent. */
function standIn(answer: () => Response | Promise<Response>) {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	const fetcher = ((url: string, init?: RequestInit) => {
		calls.push({ url, init });
		return Promise.resolve().then(answer);
	}) as typeof fetch;
	return { fetcher, calls };
}
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

// every test asks its own address, so none of them is answered from another's kept answer
let n = 0;
const url = () => `https://api.test/${++n}`;
const HOUR = 60 * 60 * 1000;

afterEach(() => vi.unstubAllEnvs());

describe('versions', () => {
	it('S-82: knows which of two versions is newer', () => {
		expect(newer('0.1.2', '0.1.1')).toBe(true);
		expect(newer('v0.2.0', '0.1.9')).toBe(true);
		expect(newer('1.0.0', 'v0.99.99')).toBe(true);
		// numbers, not text: 0.10.0 comes after 0.9.0
		expect(newer('0.10.0', '0.9.0')).toBe(true);
		expect(newer('0.1.1', '0.1.1')).toBe(false);
		expect(newer('0.1.0', '0.1.1')).toBe(false);
		expect(newer('0.9.9', '1.0.0')).toBe(false);
	});

	it('S-82: a version it cannot read is never newer', () => {
		for (const odd of ['', 'latest', '1.2', '1.2.3.4', '1.2.3-beta.1', 'v', '2.x.0', '99']) {
			expect(newer(odd, '0.1.1'), odd).toBe(false);
			expect(newer('9.9.9', odd), odd).toBe(false);
		}
	});

	it('S-82: the running version is the one in package.json', () => {
		expect(CURRENT).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe('the answer from GitHub', () => {
	it('S-82: reads the version and the files, and builds the link to the release page itself', () => {
		const read = release('v0.1.2');
		expect(read.version).toBe('0.1.2');
		// not the html_url the answer carried: only the tag is taken from the network
		expect(read.url).toBe('https://github.com/vargaking/wtfwid/releases/tag/v0.1.2');
		expect(read.assets[0]).toEqual({
			name: 'wtfwid-0.1.2-linux-x86_64.AppImage',
			size: 1000,
			url: 'https://github.com/vargaking/wtfwid/releases/download/v0.1.2/wtfwid-0.1.2-linux-x86_64.AppImage',
			digest: `sha256:${'0'.repeat(64)}`
		});
	});

	it('S-82: an answer it does not understand is "nothing known"', () => {
		expect(toRelease(null)).toBeNull();
		expect(toRelease({ message: 'API rate limit exceeded' })).toBeNull();
		expect(toRelease({ ...github(), tag_name: 'nightly' })).toBeNull();
		expect(toRelease({ ...github(), prerelease: true })).toBeNull();
		expect(toRelease({ ...github(), draft: true })).toBeNull();
		// a file with no size or no link is left out, the rest is kept
		expect(toRelease({ ...github(), assets: [{ name: 'x' }, github().assets[1]] })?.assets.map((a) => a.name)).toEqual(['wtfwid-0.1.2-mac-arm64.dmg']);
		expect(toRelease({ tag_name: 'v1.0.0' })?.assets).toEqual([]);
	});

	it('S-82: picks the file for this machine', () => {
		const { assets } = release();
		expect(pickAsset(assets, 'linux', 'x64')?.name).toBe('wtfwid-0.1.2-linux-x86_64.AppImage');
		expect(pickAsset(assets, 'darwin', 'arm64')?.name).toBe('wtfwid-0.1.2-mac-arm64.dmg');
		expect(pickAsset(assets, 'win32', 'x64')?.name).toBe('wtfwid-0.1.2-win-x64.exe');
		// nothing is built for these, and a file for another machine is never a substitute
		expect(pickAsset(assets, 'linux', 'arm64')).toBeNull();
		expect(pickAsset(assets, 'darwin', 'x64')).toBeNull();
		expect(pickAsset(assets, 'freebsd', 'x64')).toBeNull();
		expect(pickAsset(assets, 'linux', 'riscv64')).toBeNull();
		expect(pickAsset([], 'linux', 'x64')).toBeNull();
	});
});

describe('asking GitHub', () => {
	it('S-82: asks the public API of this repository, with no token', async () => {
		vi.stubEnv('GITHUB_TOKEN', 'ghp_must_not_leave');
		vi.stubEnv('GH_TOKEN', 'ghp_must_not_leave_either');
		expect(LATEST_URL).toBe('https://api.github.com/repos/vargaking/wtfwid/releases/latest');
		const { fetcher, calls } = standIn(ok(github()));
		const address = url();
		expect((await latestRelease(fetcher, address, 0))?.version).toBe('0.1.2');
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(address);
		const headers = new Headers(calls[0].init?.headers);
		expect(headers.get('user-agent')).toBe('wtfwid');
		expect(headers.has('authorization')).toBe(false);
		expect(headers.has('cookie')).toBe(false);
		expect(JSON.stringify(calls[0].init)).not.toContain('ghp_');
		// a request that never answers is given up
		expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
	});

	it('S-82: keeps the answer for 6 hours', async () => {
		const { fetcher, calls } = standIn(ok(github()));
		const address = url();
		await latestRelease(fetcher, address, 0);
		expect((await latestRelease(fetcher, address, 6 * HOUR - 1))?.version).toBe('0.1.2');
		expect(calls).toHaveLength(1);
		await latestRelease(fetcher, address, 6 * HOUR);
		expect(calls).toHaveLength(2);
	});

	it('S-82: two questions at the same moment are one request', async () => {
		const { fetcher, calls } = standIn(ok(github()));
		const address = url();
		const both = await Promise.all([latestRelease(fetcher, address, 0), latestRelease(fetcher, address, 0)]);
		expect(both.map((r) => r?.version)).toEqual(['0.1.2', '0.1.2']);
		expect(calls).toHaveLength(1);
	});

	it('S-82: offline is not an error, it is "nothing known", and is asked again after 30 minutes', async () => {
		const { fetcher, calls } = standIn(() => {
			throw new TypeError('fetch failed');
		});
		const address = url();
		await expect(latestRelease(fetcher, address, 0)).resolves.toBeNull();
		await expect(latestRelease(fetcher, address, 29 * 60 * 1000)).resolves.toBeNull();
		expect(calls).toHaveLength(1);
		await latestRelease(fetcher, address, 30 * 60 * 1000);
		expect(calls).toHaveLength(2);
	});

	it('S-82: rate-limited, missing or unreadable is "nothing known" too', async () => {
		for (const answer of [
			() => new Response('{"message":"API rate limit exceeded"}', { status: 403 }),
			() => new Response('{"message":"Not Found"}', { status: 404 }),
			() => new Response('<html>a hotel login page</html>', { status: 200 }),
			() => new Response('{"tag_name":"soon"}', { status: 200 })
		]) {
			await expect(latestRelease(standIn(answer).fetcher, url(), 0)).resolves.toBeNull();
		}
	});

	it('S-82: WTFWID_NO_UPDATE_CHECK turns the check off, and nothing is fetched', async () => {
		vi.stubEnv('WTFWID_NO_UPDATE_CHECK', '1');
		const { fetcher, calls } = standIn(ok(github()));
		const address = url();
		await expect(latestRelease(fetcher, address, 0)).resolves.toBeNull();
		expect(calls).toHaveLength(0);
		// and on again without it
		vi.stubEnv('WTFWID_NO_UPDATE_CHECK', '');
		expect((await latestRelease(fetcher, address, 0))?.version).toBe('0.1.2');
		expect(calls).toHaveLength(1);
	});
});

describe('what the screen is told', () => {
	const can = { canInstall: () => true };
	const cannot = { canInstall: () => false };

	it('S-82: nothing when the running version is the newest, or nothing is known', () => {
		expect(offer(null, can, '0.1.1', 'linux', 'x64').info).toEqual({ current: '0.1.1', latest: null, canInstall: false });
		expect(offer(release('v0.1.1'), can, '0.1.1', 'linux', 'x64').info).toEqual({ current: '0.1.1', latest: null, canInstall: false });
		expect(offer(release('v0.1.0'), can, '0.1.1', 'linux', 'x64').info.latest).toBeNull();
	});

	it('S-82: a newer version and the link to it; installing only where the app can replace itself', () => {
		const latest = { version: '0.1.2', url: 'https://github.com/vargaking/wtfwid/releases/tag/v0.1.2' };
		// an AppImage on the machine the release has a file for
		expect(offer(release(), can, '0.1.1', 'linux', 'x64').info).toEqual({ current: '0.1.1', latest, canInstall: true });
		// the browser version, a run from source, macOS, Windows: a link only
		expect(offer(release(), undefined, '0.1.1', 'linux', 'x64').info).toEqual({ current: '0.1.1', latest, canInstall: false });
		expect(offer(release(), cannot, '0.1.1', 'linux', 'x64').info.canInstall).toBe(false);
		// an AppImage, but the release has no file for this processor
		expect(offer(release(), can, '0.1.1', 'linux', 'arm64').info).toEqual({ current: '0.1.1', latest, canInstall: false });
	});

	const installer = (over: Partial<Installer> = {}) => {
		const asked: unknown[] = [];
		const made: Installer = {
			canInstall: () => true,
			status: () => ({ state: 'idle' }),
			install: (asset) => {
				asked.push(asset);
				return null;
			},
			restart: () => false,
			...over
		};
		return { made, asked };
	};

	it('S-82: an install is started with the link, size and checksum GitHub gave for this machine', () => {
		const { made, asked } = installer();
		expect(startInstall(release(), made, '0.1.1', 'linux', 'x64')).toBeNull();
		expect(asked).toEqual([
			{ url: 'https://github.com/vargaking/wtfwid/releases/download/v0.1.2/wtfwid-0.1.2-linux-x86_64.AppImage', size: 1000, digest: `sha256:${'0'.repeat(64)}` }
		]);
	});

	it('S-82: an install that is not possible is refused with a sentence, and nothing is started', () => {
		const { made, asked } = installer();
		expect(startInstall(release(), undefined, '0.1.1', 'linux', 'x64')).toMatch(/cannot replace itself/);
		expect(startInstall(release(), installer({ canInstall: () => false }).made, '0.1.1', 'linux', 'x64')).toMatch(/cannot replace itself/);
		expect(startInstall(null, made, '0.1.1', 'linux', 'x64')).toMatch(/no newer version/);
		expect(startInstall(release('v0.1.1'), made, '0.1.1', 'linux', 'x64')).toMatch(/no newer version/);
		expect(startInstall(release(), made, '0.1.1', 'linux', 'arm64')).toMatch(/no file for this machine/);
		expect(asked).toEqual([]);
		// what the installer itself refuses is passed on
		expect(startInstall(release(), installer({ install: () => 'The new version is already downloading.' }).made, '0.1.1', 'linux', 'x64')).toBe(
			'The new version is already downloading.'
		);
	});
});
