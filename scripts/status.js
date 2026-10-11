// One line for a status bar or a shell prompt: how many Claude Code sessions need you and
// how many are working (S-87). It asks Claude Code and nothing else, so it needs no Linear
// key, no server and no window: `node scripts/status.js`, straight from a checkout.
// `--help` says what it prints.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** How long `claude agents` gets to answer. The same as the app gives it. */
const TIMEOUT_MS = 15_000;
/** While watching: ask at least this often, changed or not. The same as the app (S-85). */
const ASK_MS = 15_000;
const WATCH_SECONDS = 5;

export const HELP = `wtfwid status: how many Claude Code sessions need you, and how many are working.

  node scripts/status.js             one line of text: "2 need you · 3 working", "1 needs you",
                                     "3 working", or "idle" when nothing is running
  node scripts/status.js --json      {"needs":2,"working":3,"failed":0,"sessions":[{name,cwd,state,waitingFor}]}
                                     sessions: the ones that need you, then the ones working
  node scripts/status.js --waybar    one line for a Waybar custom module: {"text","tooltip","class","alt"}
                                     text: how many need you, or how many are working when none do,
                                     or empty when idle. class: needs, working, idle or error
  --watch [seconds]                  with any of the above: keep running and print a line only when
                                     the answer changed. Looks at Claude Code's session files every
                                     [seconds] (default ${WATCH_SECONDS}, at least 1) and asks claude only when they
                                     changed, and otherwise every ${ASK_MS / 1000} seconds
  --help                             this text

It reads \`claude agents --json --all\` and changes nothing. A session needs you when it is
blocked or waiting for your input.

When claude is not found or fails: text and --json print nothing, say why on stderr and exit
with 1. --waybar prints class "error" with the reason as its tooltip and exits with 0.
--watch keeps trying: until claude answers again, text prints an empty line, --json prints
{"error":"…"} and --waybar its error line.`;

/**
 * The state of one entry of `claude agents --json`. This is the rule in `toSession`
 * (src/lib/server/sessions.ts), copied because this file runs without a build and cannot
 * import TypeScript. A test feeds both the same entries and fails when they disagree.
 */
export function stateOf(e) {
	// A live process says more about right now than the saved job state does.
	if (e.status === 'waiting' || e.state === 'blocked') return 'needs';
	if (e.status === 'busy' || e.state === 'working') return 'working';
	if (e.state === 'failed') return 'failed';
	if (e.state === 'done') return 'done';
	return 'open';
}

/**
 * What the list of entries comes to: how many need you, are working, have failed, and the
 * sessions that are running now (the ones that need you first, then the ones working).
 */
export function summarise(entries) {
	const all = entries
		.filter((e) => e && typeof e === 'object')
		.map((e) => ({ name: e.name ?? null, cwd: e.cwd ?? '', state: stateOf(e), waitingFor: e.waitingFor ?? null }));
	const of = (state) => all.filter((s) => s.state === state);
	const needs = of('needs');
	const working = of('working');
	return { needs: needs.length, working: working.length, failed: of('failed').length, sessions: [...needs, ...working] };
}

export function asText({ needs, working }) {
	const parts = [];
	if (needs) parts.push(needs === 1 ? '1 needs you' : `${needs} need you`);
	if (working) parts.push(`${working} working`);
	return parts.join(' · ') || 'idle';
}

/** What to call a session: its name, else the folder it runs in. */
function label(session) {
	const folder = session.cwd.split(/[\\/]/).filter(Boolean).pop();
	return session.name || folder || session.cwd || 'unnamed';
}

// Waybar reads a tooltip as Pango markup unless its "escape" option is on, so a name with
// "&" or "<" in it would otherwise make the whole tooltip unreadable. Line breaks inside a
// name go too: the tooltip is one session per line.
const plain = (text) => String(text).replace(/\s+/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The object a Waybar custom module with `"return-type": "json"` reads. */
export function asWaybar({ needs, working, sessions }) {
	const state = needs ? 'needs' : working ? 'working' : 'idle';
	const lines = sessions.map((s) => {
		const doing = s.state === 'needs' ? (s.waitingFor ? `needs you, ${s.waitingFor}` : 'needs you') : 'working';
		return plain(`${label(s)}: ${doing}`);
	});
	return {
		// an empty text hides the module, which is what idle should look like
		text: needs ? String(needs) : working ? String(working) : '',
		tooltip: lines.join('\n') || 'No Claude Code session is working or waiting',
		class: state,
		alt: state
	};
}

export function waybarError(why) {
	return { text: '', tooltip: plain(why), class: 'error', alt: 'error' };
}

/** Why `claude agents` gave no list, in one line. */
export function whyFailed(error) {
	if (error?.code === 'ENOENT') return 'claude was not found in PATH';
	if (error instanceof SyntaxError) return 'claude agents did not print a list of sessions';
	if (error?.killed) return `claude agents did not answer within ${TIMEOUT_MS / 1000} seconds`;
	const said = String(error?.stderr ?? '').trim().split('\n')[0].trim();
	if (said) return `claude agents failed: ${said}`;
	if (typeof error?.code === 'number') return `claude agents failed with exit code ${error.code}`;
	return `claude agents failed: ${error?.message ?? error}`;
}

/**
 * The line an answer becomes. An answer is `{ entries }`, or `{ error }` when claude gave
 * none. Always one line, so a bar that reads line by line never gets half an answer.
 */
export function render(mode, answer) {
	if ('error' in answer) {
		const why = whyFailed(answer.error);
		if (mode === 'waybar') return JSON.stringify(waybarError(why));
		// text has nothing true to say, and an empty line clears what a bar was showing
		return mode === 'json' ? JSON.stringify({ error: why }) : '';
	}
	const summary = summarise(answer.entries);
	if (mode === 'waybar') return JSON.stringify(asWaybar(summary));
	return mode === 'json' ? JSON.stringify(summary) : asText(summary);
}

export function parseArgs(argv) {
	const args = { mode: 'text', watch: null, help: false, error: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--help' || arg === '-h') {
			args.help = true;
		} else if (arg === '--json' || arg === '--waybar') {
			const mode = arg.slice(2);
			if (args.mode !== 'text' && args.mode !== mode) return { ...args, error: 'Use --json or --waybar, not both.' };
			args.mode = mode;
		} else if (arg === '--watch' || arg.startsWith('--watch=')) {
			let value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null;
			// the seconds are optional: only take the next word when it is not another option
			if (value === null && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) value = argv[++i];
			const seconds = value === null ? WATCH_SECONDS : Number(value);
			if (!Number.isFinite(seconds) || seconds <= 0) return { ...args, error: `--watch takes a number of seconds, not "${value}".` };
			// looking more often than once a second costs more than it tells
			args.watch = Math.max(1, seconds);
		} else {
			return { ...args, error: `Unknown option ${arg}.` };
		}
	}
	return args;
}

/** Where Claude Code keeps its files. */
export const claudeHome = (env = process.env) => env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

/**
 * Changes whenever Claude Code touches its record of a running session. Only ever used as
 * a reason to ask `claude agents` again, never read for what it says. The same hint the
 * app uses (`sessionFilesStamp` in src/lib/server/live.ts).
 */
export async function sessionFilesStamp(root = claudeHome()) {
	const dir = join(root, 'sessions');
	const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).sort();
	const stamps = await Promise.all(names.map((n) => stat(join(dir, n)).then((s) => `${n}:${s.mtimeMs}`, () => n)));
	return stamps.join('|');
}

/** Every session Claude Code lists, as it lists them. `signal` stops the command early. */
export async function listEntries(signal) {
	const { stdout } = await run('claude', ['agents', '--json', '--all'], { timeout: TIMEOUT_MS, maxBuffer: 16 << 20, signal });
	const entries = JSON.parse(stdout);
	if (!Array.isArray(entries)) throw new SyntaxError('not a list');
	return entries;
}

const ask = (list) => list().then((entries) => ({ entries }), (error) => ({ error }));

/**
 * Keeps answering until `stopped()`, and prints only when the line changed.
 *
 * Asking means starting the claude command, so each round first looks at `hint`, which is
 * cheap. It asks when the hint changed, and otherwise when `askEveryMs` have passed since it
 * last asked: Claude Code may change something without touching the files the hint looks at.
 * A failed ask is an answer like any other (the line says so once), and the next round tries
 * again.
 *
 * The clock, the sleep, the list and the hint are passed in, so a test can run an hour of
 * this in no time.
 */
export async function watch({ list, hint, render, print, sleep, now = Date.now, everyMs = WATCH_SECONDS * 1000, askEveryMs = ASK_MS, stopped = () => false }) {
	let printed = null;
	let lastHint = null;
	let askedAt = -Infinity;
	while (!stopped()) {
		const seen = await hint().catch(() => null);
		const hinted = seen !== null && seen !== lastHint;
		if (seen !== null) lastHint = seen;
		if (hinted || now() - askedAt >= askEveryMs) {
			askedAt = now();
			const answer = await ask(list);
			// stopped while asking: the command was cut short, and that is not an answer
			if (stopped()) break;
			const line = render(answer);
			if (line !== printed) {
				printed = line;
				print(line, answer);
			}
		}
		await sleep(everyMs);
	}
}

async function main(argv) {
	const args = parseArgs(argv);
	if (args.error) {
		console.error(`wtfwid status: ${args.error} --help lists the options.`);
		return 2;
	}

	// SIGINT, SIGTERM or a reader that went away: stop the round in progress and leave quietly.
	const stop = new AbortController();
	for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
	process.stdout.on('error', (error) => {
		if (error.code !== 'EPIPE') throw error;
		stop.abort();
	});
	// One write per line, never held back: Node does not buffer what it writes to a pipe.
	const print = (line) => process.stdout.write(line + '\n');
	const complain = (error) => console.error(`wtfwid status: ${whyFailed(error)}`);

	if (args.help) {
		print(HELP);
		return 0;
	}

	if (args.watch === null) {
		const answer = await ask(() => listEntries(stop.signal));
		if (stop.signal.aborted) return 0;
		// Waybar hides a module whose command exits with an error, whatever it printed, so
		// there the failure is a line like any other and the exit is clean.
		if ('error' in answer && args.mode !== 'waybar') {
			complain(answer.error);
			return 1;
		}
		print(render(args.mode, answer));
		return 0;
	}

	await watch({
		list: () => listEntries(stop.signal),
		hint: () => sessionFilesStamp(),
		render: (answer) => render(args.mode, answer),
		print: (line, answer) => {
			print(line);
			// Waybar shows the reason in its tooltip; the others have only stderr for it
			if ('error' in answer && args.mode !== 'waybar') complain(answer.error);
		},
		sleep: (ms) => wait(ms, undefined, { signal: stop.signal }).catch(() => {}),
		everyMs: args.watch * 1000,
		stopped: () => stop.signal.aborted
	});
	return 0;
}

// Run as a command, not imported by its tests. Compared as real paths: the URL form of a
// path differs from the path itself as soon as it has a space, a symlink or a drive letter.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
	process.exitCode = await main(process.argv.slice(2));
}
