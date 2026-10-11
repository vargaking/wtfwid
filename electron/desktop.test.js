import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { home as serverHome } from '../src/lib/server/config.ts';
import { closeAction, home, needsFromTitle, needsLabel, readDesktop, trayMenu, writeDesktop } from './desktop.js';

const tmp = () => mkdtemp(join(tmpdir(), 'wtfwid-desktop-'));

afterEach(() => vi.unstubAllEnvs());

describe('how many need you', () => {
	it('S-81: reads the count from the window title', () => {
		expect(needsFromTitle('(2) wtfwid')).toBe(2);
		expect(needsFromTitle('(1) wtfwid')).toBe(1);
		expect(needsFromTitle('(12) wtfwid')).toBe(12);
		expect(needsFromTitle('wtfwid')).toBe(0);
	});

	it('S-81: a title it does not expect counts as nothing', () => {
		for (const odd of ['', '(two) wtfwid', '( 2 ) wtfwid', 'wtfwid (2)', '(2)wtfwid', '2 wtfwid', '(-1) wtfwid', null, undefined, 7]) {
			expect(needsFromTitle(odd), String(odd)).toBe(0);
		}
	});

	it('S-81: says it in words', () => {
		expect(needsLabel(0)).toBe('Nothing needs you');
		expect(needsLabel(1)).toBe('1 needs you');
		expect(needsLabel(2)).toBe('2 need you');
	});
});

describe('the tray menu', () => {
	const labels = (menu) => menu.filter((item) => item.type !== 'separator').map((item) => item.label);

	it('S-81: show, how many need you, keep running, quit', () => {
		const menu = trayMenu({ needs: 2, keepRunning: false });
		expect(labels(menu)).toEqual(['Show wtfwid', '2 need you', 'Keep running when the window is closed', 'Quit']);
		expect(menu.filter((item) => item.id).map((item) => item.id)).toEqual(['show', 'needs', 'keep', 'quit']);
		expect(labels(trayMenu({ needs: 0, keepRunning: false }))[1]).toBe('Nothing needs you');
	});

	it('S-81: keep running is a checkbox that shows the choice', () => {
		const keep = (keepRunning) => trayMenu({ needs: 0, keepRunning }).find((item) => item.id === 'keep');
		expect(keep(false)).toMatchObject({ type: 'checkbox', checked: false });
		expect(keep(true)).toMatchObject({ type: 'checkbox', checked: true });
	});
});

describe('closing the window', () => {
	it('S-81: quits, unless you chose to keep running', () => {
		expect(closeAction({ keepRunning: false, quitting: false })).toBe('quit');
		expect(closeAction({ keepRunning: true, quitting: false })).toBe('hide');
	});

	it('S-81: Quit, Ctrl+Q and a restart really quit, even with keep running on', () => {
		expect(closeAction({ keepRunning: true, quitting: true })).toBe('quit');
		expect(closeAction({ keepRunning: false, quitting: true })).toBe('quit');
	});
});

describe('desktop.json', () => {
	it('S-81: keep running is off until it is turned on', async () => {
		expect(await readDesktop(await tmp())).toEqual({ keepRunning: false });
		// a folder that is not there yet
		expect(await readDesktop(join(await tmp(), 'not', 'made'))).toEqual({ keepRunning: false });
	});

	it('S-81: remembers the choice, both ways', async () => {
		const dir = join(await tmp(), 'new-home');
		await writeDesktop(dir, { keepRunning: true });
		expect(await readDesktop(dir)).toEqual({ keepRunning: true });
		expect(JSON.parse(await readFile(join(dir, 'desktop.json'), 'utf8'))).toEqual({ keepRunning: true });
		await writeDesktop(dir, { keepRunning: false });
		expect(await readDesktop(dir)).toEqual({ keepRunning: false });
	});

	it('S-81: a broken file gives the defaults, and can be written over', async () => {
		const dir = await tmp();
		for (const broken of ['', '{"keepRunning": tr', 'null', '[]', '"yes"', '{"keepRunning":"true"}', '{"keepRunning":1}']) {
			await writeFile(join(dir, 'desktop.json'), broken);
			expect(await readDesktop(dir), broken).toEqual({ keepRunning: false });
		}
		await writeDesktop(dir, { keepRunning: true });
		expect(await readDesktop(dir)).toEqual({ keepRunning: true });
	});

	it.skipIf(process.platform === 'win32')('S-81: the file is readable only by you, also when it was not before', async () => {
		const dir = await tmp();
		await writeDesktop(dir, { keepRunning: true });
		expect((await stat(join(dir, 'desktop.json'))).mode & 0o777).toBe(0o600);
		await writeFile(join(dir, 'desktop.json'), '{}', { mode: 0o644 });
		await writeDesktop(dir, { keepRunning: true });
		expect((await stat(join(dir, 'desktop.json'))).mode & 0o777).toBe(0o600);
	});

	it('S-81: it lives where the settings do', () => {
		expect(home({ WTFWID_HOME: '/somewhere/else' })).toBe('/somewhere/else');
		expect(home({})).toBe(join(homedir(), '.wtfwid'));
		// the same answer as the server's own rule, with and without WTFWID_HOME
		vi.stubEnv('WTFWID_HOME', '/somewhere/else');
		expect(home()).toBe(serverHome());
		vi.stubEnv('WTFWID_HOME', '');
		expect(home()).toBe(serverHome());
	});
});
