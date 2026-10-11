import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toSession } from '../src/lib/server/sessions.ts';
import { HELP, asText, asWaybar, claudeHome, parseArgs, render, sessionFilesStamp, stateOf, summarise, watch, waybarError, whyFailed } from './status.js';

const entry = (over = {}) => ({ cwd: '/home/dev/app', kind: 'interactive', startedAt: 1_791_000_000_000, ...over });

/** Two that need you, three working, and four that are neither. */
const BUSY_DAY = [
	entry({ name: 'ENG-7 voice', status: 'busy' }),
	entry({ name: 'ENG-12 reconnect', status: 'waiting', waitingFor: 'permission prompt' }),
	entry({ cwd: '/home/dev/zeta', kind: 'background', state: 'working' }),
	entry({ name: 'old job', kind: 'background', state: 'failed' }),
	entry({ cwd: '/home/dev/api', kind: 'background', state: 'blocked' }),
	entry({ name: 'finished', kind: 'background', state: 'done' }),
	entry({ name: 'at the prompt', status: 'idle' }),
	entry({ name: 'stopped', kind: 'background', state: 'stopped' }),
	entry({ name: 'ENG-9 screen share', status: 'busy' })
];

describe('what the sessions come to', () => {
	it('S-87: counts the sessions that need you, are working and have failed', () => {
		expect(summarise(BUSY_DAY)).toMatchObject({ needs: 2, working: 3, failed: 1 });
		expect(summarise([])).toEqual({ needs: 0, working: 0, failed: 0, sessions: [] });
	});

	it('S-87: lists the sessions running now, the ones that need you first', () => {
		expect(summarise(BUSY_DAY).sessions).toEqual([
			{ name: 'ENG-12 reconnect', cwd: '/home/dev/app', state: 'needs', waitingFor: 'permission prompt' },
			{ name: null, cwd: '/home/dev/api', state: 'needs', waitingFor: null },
			{ name: 'ENG-7 voice', cwd: '/home/dev/app', state: 'working', waitingFor: null },
			{ name: null, cwd: '/home/dev/zeta', state: 'working', waitingFor: null },
			{ name: 'ENG-9 screen share', cwd: '/home/dev/app', state: 'working', waitingFor: null }
		]);
	});

	it('S-87: gives every entry the state the app gives it', async () => {
		// The rule is written twice: `toSession` for the app, `stateOf` for this script. Every
		// word the app's rule or its entry type mentions is tried in both fields it reads, so a
		// state added there and forgotten here fails this test.
		const source = await readFile(fileURLToPath(new URL('../src/lib/server/sessions.ts', import.meta.url)), 'utf8');
		const rule = source.slice(source.indexOf('interface AgentEntry'), source.indexOf('export function remember'));
		const words = [...new Set([...rule.matchAll(/'([a-z]+)'/g)].map((m) => m[1]))];
		expect(words).toEqual(expect.arrayContaining(['working', 'blocked', 'done', 'failed', 'stopped', 'busy', 'waiting', 'idle']));

		const values = [undefined, 'not seen before', ...words];
		const entries = values.flatMap((state) =>
			values.flatMap((status) => [
				entry({ state, status, name: 'ENG-12 reconnect', waitingFor: 'permission prompt' }),
				entry({ state, status, kind: 'background' })
			])
		);
		for (const e of entries) expect(stateOf(e), `state ${e.state}, status ${e.status}`).toBe(toSession(e).state);

		// and the whole answer, built from the app's own sessions
		const app = entries.map(toSession);
		const pick = (state) => app.filter((s) => s.state === state).map((s) => ({ name: s.name, cwd: s.cwd, state: s.state, waitingFor: s.waitingFor }));
		expect(summarise(entries)).toEqual({
			needs: pick('needs').length,
			working: pick('working').length,
			failed: pick('failed').length,
			sessions: [...pick('needs'), ...pick('working')]
		});
	});
});

describe('one line of text', () => {
	it('S-87: says how many need you and how many are working, and leaves out a part that is zero', () => {
		expect(asText({ needs: 2, working: 3 })).toBe('2 need you · 3 working');
		expect(asText({ needs: 1, working: 0 })).toBe('1 needs you');
		expect(asText({ needs: 0, working: 3 })).toBe('3 working');
		expect(asText({ needs: 1, working: 1 })).toBe('1 needs you · 1 working');
		expect(asText(summarise(BUSY_DAY))).toBe('2 need you · 3 working');
	});

	it('S-87: says idle when nothing is running, whatever else is listed', () => {
		expect(asText({ needs: 0, working: 0 })).toBe('idle');
		expect(render('text', { entries: [entry({ state: 'failed' }), entry({ status: 'idle' }), entry({ state: 'done' })] })).toBe('idle');
	});
});

describe('a line for Waybar', () => {
	it('S-87: shows how many need you, and lists them before the ones working', () => {
		expect(asWaybar(summarise(BUSY_DAY))).toEqual({
			text: '2',
			tooltip: ['ENG-12 reconnect: needs you, permission prompt', 'api: needs you', 'ENG-7 voice: working', 'zeta: working', 'ENG-9 screen share: working'].join('\n'),
			class: 'needs',
			alt: 'needs'
		});
	});

	it('S-87: shows how many are working when none need you, and nothing when idle', () => {
		expect(asWaybar(summarise([entry({ status: 'busy' }), entry({ name: 'b', status: 'busy' })]))).toEqual({ text: '2', tooltip: 'app: working\nb: working', class: 'working', alt: 'working' });
		expect(asWaybar(summarise([entry({ status: 'idle' })]))).toEqual({ text: '', tooltip: 'No Claude Code session is working or waiting', class: 'idle', alt: 'idle' });
	});

	it('S-87: is one line of JSON, with nothing in the tooltip that Waybar would read as markup', () => {
		const line = render('waybar', { entries: [entry({ name: 'R&D <b>fast</b>\nline two', status: 'waiting', waitingFor: 'input needed' }), entry({ cwd: 'C:\\Users\\dev\\app', status: 'busy' }), entry({ cwd: '/', status: 'busy' })] });
		expect(line).not.toContain('\n');
		expect(JSON.parse(line).tooltip).toBe('R&amp;D &lt;b&gt;fast&lt;/b&gt; line two: needs you, input needed\napp: working\n/: working');
	});

	it('S-87: says why as an error class when claude gave no list', () => {
		expect(waybarError('claude was not found in PATH')).toEqual({ text: '', tooltip: 'claude was not found in PATH', class: 'error', alt: 'error' });
		expect(JSON.parse(render('waybar', { error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) }))).toEqual(waybarError('claude was not found in PATH'));
	});
});

describe('when claude gives no list', () => {
	it('S-87: says why in one line', () => {
		expect(whyFailed(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))).toBe('claude was not found in PATH');
		expect(whyFailed(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null }))).toBe('claude agents did not answer within 15 seconds');
		expect(whyFailed(Object.assign(new Error('Command failed'), { code: 1, stderr: '\nNot logged in\nRun claude to log in\n' }))).toBe('claude agents failed: Not logged in');
		expect(whyFailed(Object.assign(new Error('Command failed'), { code: 3, stderr: '' }))).toBe('claude agents failed with exit code 3');
		expect(whyFailed(new SyntaxError('Unexpected token'))).toBe('claude agents did not print a list of sessions');
		expect(whyFailed(new Error('something else'))).toBe('claude agents failed: something else');
	});

	it('S-87: has no text to print, and says so in JSON', () => {
		const error = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
		expect(render('text', { error })).toBe('');
		expect(render('json', { error })).toBe('{"error":"claude was not found in PATH"}');
	});
});

describe('--json', () => {
	it('S-87: prints the counts and the running sessions as one line of JSON', () => {
		const line = render('json', { entries: BUSY_DAY });
		expect(line).not.toContain('\n');
		expect(JSON.parse(line)).toEqual(summarise(BUSY_DAY));
		expect(Object.keys(JSON.parse(line))).toEqual(['needs', 'working', 'failed', 'sessions']);
	});
});

describe('the options', () => {
	it('S-87: reads the mode and whether to keep watching', () => {
		expect(parseArgs([])).toEqual({ mode: 'text', watch: null, help: false, error: null });
		expect(parseArgs(['--json'])).toMatchObject({ mode: 'json', watch: null });
		expect(parseArgs(['--waybar', '--watch'])).toMatchObject({ mode: 'waybar', watch: 5, error: null });
		expect(parseArgs(['--watch', '--waybar'])).toMatchObject({ mode: 'waybar', watch: 5, error: null });
		expect(parseArgs(['--watch', '2', '--json'])).toMatchObject({ mode: 'json', watch: 2, error: null });
		expect(parseArgs(['--watch=30'])).toMatchObject({ mode: 'text', watch: 30, error: null });
		expect(parseArgs(['--watch', '0.2'])).toMatchObject({ watch: 1 });
		expect(parseArgs(['-h'])).toMatchObject({ help: true, error: null });
		expect(parseArgs(['--help'])).toMatchObject({ help: true, error: null });
	});

	it('S-87: refuses what it does not understand', () => {
		expect(parseArgs(['--wat']).error).toBe('Unknown option --wat.');
		expect(parseArgs(['--watch', 'soon']).error).toBe('--watch takes a number of seconds, not "soon".');
		expect(parseArgs(['--watch=0']).error).toBe('--watch takes a number of seconds, not "0".');
		expect(parseArgs(['--json', '--waybar']).error).toBe('Use --json or --waybar, not both.');
	});

	it('S-87: --help names every option', () => {
		for (const word of ['--json', '--waybar', '--watch [seconds]', '--help', 'idle', 'claude agents --json --all', 'stderr']) expect(HELP).toContain(word);
	});
});

/**
 * A made-up world for the watch loop: time only passes when it sleeps. `hint` and `answer`
 * say what is true at a given time; an answer that is an Error is claude failing.
 */
function world({ hint = () => 'unchanged', answer, mode = 'text', every = 5 }) {
	let t = 0;
	const asked = [];
	const printed = [];
	const run = (seconds) =>
		watch({
			now: () => t * 1000,
			sleep: async (ms) => void (t += ms / 1000),
			hint: async () => hint(t),
			list: async () => {
				asked.push(t);
				const now = answer(t);
				if (now instanceof Error) throw now;
				return now;
			},
			render: (a) => render(mode, a),
			print: (line) => printed.push([t, line]),
			everyMs: every * 1000,
			stopped: () => t >= seconds
		});
	return { asked, printed, run };
}

describe('--watch', () => {
	it('S-87: asks claude at the start and then only every 15 seconds while nothing hints at a change', async () => {
		const quiet = world({ answer: () => [entry({ status: 'busy' })] });
		await quiet.run(60);
		expect(quiet.asked).toEqual([0, 15, 30, 45]);

		// looking more often does not mean asking more often
		const eager = world({ answer: () => [entry({ status: 'busy' })], every: 1 });
		await eager.run(60);
		expect(eager.asked).toEqual([0, 15, 30, 45]);
	});

	it('S-87: asks at once when a session file changed', async () => {
		const w = world({ hint: (t) => (t < 20 ? '95.json:1' : '95.json:2'), answer: (t) => [entry({ status: t < 20 ? 'busy' : 'waiting' })] });
		await w.run(60);
		expect(w.asked).toEqual([0, 15, 20, 35, 50]);
		expect(w.printed).toEqual([
			[0, '1 working'],
			[20, '1 needs you']
		]);
	});

	it('S-87: prints a line only when the answer changed', async () => {
		const w = world({ answer: (t) => (t < 30 ? [entry({ status: 'busy' })] : t < 45 ? [entry({ status: 'busy' }), entry({ status: 'waiting' })] : []) });
		await w.run(120);
		expect(w.asked).toHaveLength(8);
		expect(w.printed).toEqual([
			[0, '1 working'],
			[30, '1 needs you · 1 working'],
			[45, 'idle']
		]);
	});

	it('S-87: keeps trying when claude fails, and says so once', async () => {
		const gone = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
		const answer = (t) => (t >= 15 && t < 60 ? gone : [entry({ status: 'waiting' })]);
		const text = world({ answer });
		await text.run(90);
		expect(text.asked).toEqual([0, 15, 30, 45, 60, 75]);
		expect(text.printed).toEqual([
			[0, '1 needs you'],
			[15, ''],
			[60, '1 needs you']
		]);

		const bar = world({ answer, mode: 'waybar' });
		await bar.run(90);
		expect(bar.printed.map(([t, line]) => [t, JSON.parse(line).class])).toEqual([
			[0, 'needs'],
			[15, 'error'],
			[60, 'needs']
		]);
	});

	it('S-87: still asks every 15 seconds when the session files cannot be looked at', async () => {
		const w = world({ hint: () => Promise.reject(new Error('EACCES')), answer: () => [] });
		await w.run(40);
		expect(w.asked).toEqual([0, 15, 30]);
		expect(w.printed).toEqual([[0, 'idle']]);
	});
});

describe('the hint that a session changed', () => {
	it('S-87: changes when Claude Code writes a session file, and only then', async () => {
		const root = await mkdtemp(join(tmpdir(), 'wtfwid-status-'));
		expect(await sessionFilesStamp(root)).toBe('');
		await mkdir(join(root, 'sessions'));
		await writeFile(join(root, 'sessions', '95.json'), '{}');
		await utimes(join(root, 'sessions', '95.json'), 1000, 1000);
		const before = await sessionFilesStamp(root);
		expect(before).toBe('95.json:1000000');
		expect(await sessionFilesStamp(root)).toBe(before);

		// a file that is not a session's record says nothing
		await writeFile(join(root, 'sessions', '95.abc.key'), 'x');
		expect(await sessionFilesStamp(root)).toBe(before);

		await utimes(join(root, 'sessions', '95.json'), 2000, 2000);
		expect(await sessionFilesStamp(root)).not.toBe(before);
		await writeFile(join(root, 'sessions', '96.json'), '{}');
		expect(await sessionFilesStamp(root)).toContain('|96.json:');
	});

	it('S-87: looks where CLAUDE_CONFIG_DIR says Claude Code keeps its files', () => {
		expect(claudeHome({ CLAUDE_CONFIG_DIR: '/somewhere/else' })).toBe('/somewhere/else');
		expect(claudeHome({})).toMatch(/[\\/]\.claude$/);
	});
});

// The command itself, started the way a status bar starts it, with a stand-in for claude
// first in PATH. The stand-in is a shell script, so not on Windows.
describe.skipIf(process.platform === 'win32')('run as a command', () => {
	const SCRIPT = fileURLToPath(new URL('./status.js', import.meta.url));

	/** A folder to use as PATH. With `script`, it holds a claude that runs it. */
	async function pathWith(script) {
		const dir = await mkdtemp(join(tmpdir(), 'wtfwid-status-bin-'));
		if (script !== undefined) {
			await writeFile(join(dir, 'claude'), `#!/bin/sh\n${script}\n`);
			await chmod(join(dir, 'claude'), 0o755);
		}
		return dir;
	}

	const status = (path, ...args) =>
		new Promise((done) => execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: path }, timeout: 20_000 }, (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr })));

	const LIST = JSON.stringify([entry({ name: 'ENG-12 reconnect', status: 'waiting', waitingFor: 'permission prompt' }), entry({ cwd: '/home/dev/zeta', status: 'busy' })]);

	it('S-87: asks `claude agents --json --all` and prints one line', async () => {
		// the stand-in answers only when asked exactly that
		const path = await pathWith(`[ "$*" = "agents --json --all" ] || exit 9\nprintf '%s\\n' '${LIST}'`);
		expect(await status(path)).toEqual({ code: 0, stdout: '1 needs you · 1 working\n', stderr: '' });

		const json = await status(path, '--json');
		expect(json.code).toBe(0);
		expect(JSON.parse(json.stdout)).toEqual({
			needs: 1,
			working: 1,
			failed: 0,
			sessions: [
				{ name: 'ENG-12 reconnect', cwd: '/home/dev/app', state: 'needs', waitingFor: 'permission prompt' },
				{ name: null, cwd: '/home/dev/zeta', state: 'working', waitingFor: null }
			]
		});

		const bar = await status(path, '--waybar');
		expect(bar.code).toBe(0);
		expect(bar.stdout.trimEnd()).not.toContain('\n');
		expect(JSON.parse(bar.stdout)).toEqual({ text: '1', tooltip: 'ENG-12 reconnect: needs you, permission prompt\nzeta: working', class: 'needs', alt: 'needs' });
	});

	it('S-87: without claude, text prints nothing and fails with one line on stderr', async () => {
		const path = await pathWith();
		expect(await status(path)).toEqual({ code: 1, stdout: '', stderr: 'wtfwid status: claude was not found in PATH\n' });
		expect(await status(path, '--json')).toEqual({ code: 1, stdout: '', stderr: 'wtfwid status: claude was not found in PATH\n' });
	});

	it('S-87: without claude, --waybar still prints a line and does not fail', async () => {
		const bar = await status(await pathWith(), '--waybar');
		expect(bar).toMatchObject({ code: 0, stderr: '' });
		expect(JSON.parse(bar.stdout)).toEqual({ text: '', tooltip: 'claude was not found in PATH', class: 'error', alt: 'error' });
	});

	it('S-87: says why when claude fails or prints something else', async () => {
		expect(await status(await pathWith('echo "Not logged in" >&2\nexit 1'))).toEqual({ code: 1, stdout: '', stderr: 'wtfwid status: claude agents failed: Not logged in\n' });
		expect(await status(await pathWith('echo "{}"'))).toEqual({ code: 1, stdout: '', stderr: 'wtfwid status: claude agents did not print a list of sessions\n' });
		expect(await status(await pathWith('echo "hello"'))).toEqual({ code: 1, stdout: '', stderr: 'wtfwid status: claude agents did not print a list of sessions\n' });
	});

	it('S-87: --help and a wrong option never start claude', async () => {
		const path = await pathWith('exit 9');
		const help = await status(path, '--help');
		expect(help).toMatchObject({ code: 0, stderr: '' });
		expect(help.stdout).toBe(HELP + '\n');
		expect(await status(path, '--wat')).toEqual({ code: 2, stdout: '', stderr: 'wtfwid status: Unknown option --wat. --help lists the options.\n' });
	});

	it('S-87: --watch prints the first answer at once and leaves quietly on SIGTERM', async () => {
		const path = await pathWith(`printf '%s\\n' '${LIST}'`);
		const result = await new Promise((done) => {
			let stdout = '';
			const child = execFile(process.execPath, [SCRIPT, '--watch', '1'], { env: { PATH: path, CLAUDE_CONFIG_DIR: path }, timeout: 20_000 }, (error, out, stderr) => done({ code: error ? (error.code ?? error.signal) : 0, stdout: out, stderr }));
			// the line arrives while the command is still running: nothing is held back
			child.stdout.on('data', (chunk) => {
				stdout += chunk;
				if (stdout.includes('\n')) child.kill('SIGTERM');
			});
		});
		expect(result).toEqual({ code: 0, stdout: '1 needs you · 1 working\n', stderr: '' });
	});
});
