// The parts of the tray and of "keep running" (S-81) that need no Electron: what the menu
// says, whether closing the window hides or quits, and the file the choice is kept in.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where wtfwid keeps its files. The same rule as `home()` in src/lib/server/config.ts. */
export const home = (env = process.env) => env.WTFWID_HOME || join(homedir(), '.wtfwid');

/**
 * How many tickets need you, read from the window's title. The page writes it there as
 * `(2) wtfwid`, so the tray needs no channel of its own to the page.
 */
export function needsFromTitle(title) {
	const m = typeof title === 'string' ? /^\((\d+)\)\s/.exec(title) : null;
	return m ? Number(m[1]) : 0;
}

export const needsLabel = (needs) => (needs > 0 ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : 'Nothing needs you');

/** The tray menu, top to bottom. main.js gives each `id` its action. */
export function trayMenu({ needs, keepRunning }) {
	return [
		{ id: 'show', label: 'Show wtfwid' },
		{ id: 'needs', label: needsLabel(needs) },
		{ type: 'separator' },
		{ id: 'keep', label: 'Keep running when the window is closed', type: 'checkbox', checked: keepRunning },
		{ type: 'separator' },
		{ id: 'quit', label: 'Quit' }
	];
}

/**
 * What closing the window does. It only hides when you chose "keep running" and the app
 * is not on its way out: Quit in the tray menu, Ctrl+Q and a restart for a new version
 * all really quit.
 */
export const closeAction = ({ keepRunning, quitting }) => (keepRunning && !quitting ? 'hide' : 'quit');

const file = (dir) => join(dir, 'desktop.json');

/** The choices of the desktop app. A file that is missing or broken gives the defaults. */
export async function readDesktop(dir) {
	const stored = await readFile(file(dir), 'utf8').then(JSON.parse, () => null).catch(() => null);
	return { keepRunning: stored?.keepRunning === true };
}

/** Written the way settings.json is: readable only by you. */
export async function writeDesktop(dir, choices) {
	await mkdir(dir, { recursive: true });
	await writeFile(file(dir), JSON.stringify({ keepRunning: choices.keepRunning === true }, null, '\t'), { mode: 0o600 });
	await chmod(file(dir), 0o600); // the mode above only applies when the file is new
}
