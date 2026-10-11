import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGraph } from '../graph';
import { collect } from './collect';
import { config, publicSettings } from './config';
import { parsePatch, readSettings, writeSettings, type Vault } from './settings';

// Stands in for the OS keychain: reversible, and visibly not the plain text.
const vault: Vault = {
	encrypt: (plain) => Buffer.from(plain).reverse().toString('base64'),
	decrypt: (stored) => Buffer.from(stored, 'base64').reverse().toString()
};
const tmp = () => mkdtemp(join(tmpdir(), 'wtfwid-settings-'));
const raw = (home: string) => readFile(join(home, 'settings.json'), 'utf8');

describe('settings file', () => {
	it('S-71 saves and reads settings back', async () => {
		const home = await tmp();
		await writeSettings(home, { linearTeam: 'ENG', githubRepos: ['o/r'], linearKey: 'lin_api_1' }, undefined);
		expect(await readSettings(home, undefined)).toEqual({ linearTeam: 'ENG', githubRepos: ['o/r'], linearKey: 'lin_api_1', locked: [] });
	});

	it.skipIf(process.platform === 'win32')('S-71 keeps the file private to the user', async () => {
		const home = await tmp();
		await writeSettings(home, { linearKey: 'lin_api_1' }, undefined);
		expect((await stat(join(home, 'settings.json'))).mode & 0o777).toBe(0o600);
	});

	it('S-72 encrypts keys with the keychain when there is one', async () => {
		const home = await tmp();
		await writeSettings(home, { linearKey: 'lin_api_secret', githubToken: 'ghp_secret', linearTeam: 'ENG' }, vault);
		const text = await raw(home);
		expect(text).not.toContain('lin_api_secret');
		expect(text).not.toContain('ghp_secret');
		expect(text).toContain('"ENG"');
		expect(await readSettings(home, vault)).toMatchObject({ linearKey: 'lin_api_secret', githubToken: 'ghp_secret', locked: [] });
	});

	it('S-72 reports an encrypted key as locked where there is no keychain to open it', async () => {
		const home = await tmp();
		await writeSettings(home, { linearKey: 'lin_api_secret' }, vault);
		const read = await readSettings(home, undefined);
		expect(read.linearKey).toBeUndefined();
		expect(read.locked).toEqual(['linearKey']);
	});

	it('S-74 keeps a key that is not mentioned, replaces one that is, removes one set to null', async () => {
		const home = await tmp();
		await writeSettings(home, { linearKey: 'one', githubToken: 'two' }, undefined);
		await writeSettings(home, { linearTeam: 'ENG' }, undefined);
		expect(await readSettings(home, undefined)).toMatchObject({ linearKey: 'one', githubToken: 'two' });
		await writeSettings(home, { linearKey: 'three', githubToken: null }, undefined);
		const read = await readSettings(home, undefined);
		expect(read.linearKey).toBe('three');
		expect(read.githubToken).toBeUndefined();
	});
});

describe('what the dialog may send', () => {
	it('S-74 tidies a valid change', () => {
		expect(parsePatch({ linearTeam: ' eng ', githubRepos: [' o/r ', ''], linearKey: ' key ', githubToken: null })).toEqual({
			linearTeam: 'ENG',
			githubRepos: ['o/r'],
			linearKey: 'key',
			githubToken: null
		});
	});

	it('S-74 says what is wrong with an invalid one', () => {
		expect(parsePatch(null)).toBe('Expected an object.');
		expect(parsePatch({ githubRepos: ['not a repo'] })).toBe('"not a repo" is not a repository. Write it as owner/name.');
		expect(parsePatch({ linearTeam: 'has spaces' })).toMatch(/team key/);
		expect(parsePatch({ linearKey: 12 })).toMatch(/key/);
	});
});

describe('settings and the environment', () => {
	const KEYS = ['WTFWID_HOME', 'LINEAR_API_KEY', 'WTFWID_LINEAR_TEAM', 'WTFWID_GITHUB_REPOS', 'GITHUB_TOKEN', 'GH_TOKEN', 'WTFWID_SNAPSHOT'];
	const before = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
	beforeEach(async () => {
		for (const k of KEYS) delete process.env[k];
		process.env.WTFWID_HOME = await tmp();
	});
	afterEach(() => {
		for (const k of KEYS) before[k] === undefined ? delete process.env[k] : (process.env[k] = before[k]);
	});

	it('S-73 falls back to the environment for anything not saved', async () => {
		Object.assign(process.env, { LINEAR_API_KEY: 'env-key', WTFWID_LINEAR_TEAM: 'ENV', WTFWID_GITHUB_REPOS: 'a/b, c/d' });
		expect(await config()).toMatchObject({ linearKey: 'env-key', linearTeam: 'ENV', githubRepos: ['a/b', 'c/d'], githubToken: null });
		expect(await publicSettings()).toMatchObject({ linearKey: 'env', githubToken: 'none', linearTeam: 'ENV', storage: 'file' });
	});

	it('S-73 lets saved settings win over the environment', async () => {
		Object.assign(process.env, { LINEAR_API_KEY: 'env-key', WTFWID_LINEAR_TEAM: 'ENV', WTFWID_GITHUB_REPOS: 'a/b' });
		await writeSettings(process.env.WTFWID_HOME!, { linearKey: 'saved-key', linearTeam: '', githubRepos: ['x/y'] }, undefined);
		expect(await config()).toMatchObject({ linearKey: 'saved-key', linearTeam: '', githubRepos: ['x/y'] });
	});

	it('S-63 with no Linear key, asks for setup and shows no data', async () => {
		const graph = buildGraph(await collect());
		expect(graph).toMatchObject({ setup: true, demo: false, lanes: [], warnings: [] });
	});

	it('S-63 shows demo data only when asked for', async () => {
		const graph = buildGraph(await collect(Date.now(), true));
		expect(graph).toMatchObject({ setup: false, demo: true });
		expect(graph.lanes.length).toBeGreaterThan(0);
	});

	it('S-74 never hands a key to the dialog', async () => {
		process.env.GITHUB_TOKEN = 'ghp_from_env';
		await writeSettings(process.env.WTFWID_HOME!, { linearKey: 'lin_api_saved' }, undefined);
		const shown = JSON.stringify(await publicSettings());
		expect(shown).not.toContain('lin_api_saved');
		expect(shown).not.toContain('ghp_from_env');
		expect(JSON.parse(shown)).toMatchObject({ linearKey: 'saved', githubToken: 'env' });
	});
});
