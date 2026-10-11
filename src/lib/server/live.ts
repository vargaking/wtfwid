import { createHash } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Action, LiveEvent, Session } from '../model';
import { config } from './config';
import { pulse, relayState } from './collect';
import { listSessions } from './sessions';
import { actionsFrom } from './story';
import { agentTranscripts, claudeHome, findTranscript, readNote } from './transcript';

/**
 * Follows the sessions that are running and says what each is doing, as it happens (S-85).
 *
 * One follower serves every open window. Once a second it looks at the transcript of each
 * running session; when a file has grown it reads only the new part and passes on what
 * happened. It also asks Claude Code which sessions exist, and says so when that changed,
 * so the screen can refresh at once. Asking means starting the claude command, so it only
 * asks when Claude Code's own session files have changed, and otherwise four times a minute.
 * It runs only while a window is listening.
 */

const TICK_MS = 1000;
/** Ask for the session list at least this often, changed or not. */
const LIST_MS = 15_000;
const KEPT = 12;
/** A transcript found late is replayed from its start only if it is smaller than this. */
const REPLAY_MAX = 256 * 1024;

/**
 * Changes whenever Claude Code touches its record of a running session. Only ever used as
 * a reason to ask `claude agents` again, never read for what it says.
 */
async function sessionFilesStamp(root: string): Promise<string> {
	const dir = join(root, 'sessions');
	const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort();
	const stamps = await Promise.all(names.map((n) => stat(join(dir, n)).then((s) => `${n}:${s.mtimeMs}`, () => n)));
	return stamps.join('|');
}

const signature = (sessions: Session[]) =>
	createHash('sha1').update(sessions.map((s) => `${s.id}:${s.state}:${s.waitingFor ?? ''}`).sort().join('|')).digest('hex').slice(0, 16);

interface Followed {
	session: Session;
	file: string | null;
	/** How far into the file has been read. */
	offset: number;
	/** The start of a line whose end has not been written yet. */
	partial: Buffer;
	recent: Action[];
	/** Its sub-agents' transcripts, each read the same way: by file, how far and the unfinished rest. */
	agents: Map<string, { offset: number; partial: Buffer }>;
}

type Listener = (event: LiveEvent) => void;

/** Reads what was added to a file since `from`. Returns whole lines and the unfinished rest. */
export async function readNew(file: string, from: number, partial: Buffer): Promise<{ lines: string[]; offset: number; partial: Buffer }> {
	const handle = await open(file, 'r');
	try {
		const { size } = await handle.stat();
		// shorter than before: the file was rewritten (Claude Code does that when it compacts)
		if (size < from) return { lines: [], offset: size, partial: Buffer.alloc(0) };
		if (size === from) return { lines: [], offset: from, partial };
		const { buffer } = await handle.read(Buffer.alloc(size - from), 0, size - from, from);
		const all = Buffer.concat([partial, buffer]);
		const end = all.lastIndexOf(0x0a);
		// cut on the newline byte, so a character that spans two reads is never split
		const lines = end < 0 ? [] : all.subarray(0, end).toString('utf8').split('\n').filter(Boolean);
		return { lines, offset: size, partial: end < 0 ? all : all.subarray(end + 1) };
	} finally {
		await handle.close();
	}
}

export interface HubDeps {
	list: () => Promise<Session[]>;
	/** A value that changes when the screen should refresh. Left out or null, it is worked out from the session list. */
	beat?: () => Promise<string | null>;
	/** A cheap value that changes when it is worth asking for the list again. */
	hint?: () => Promise<string>;
	claude?: string;
}

export function createHub(deps: HubDeps) {
	const listeners = new Set<Listener>();
	const followed = new Map<string, Followed>();
	let lastBeat: string | null = null;
	let lastHint: string | null = null;
	let listedAt = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	/** The first listing after the first window connected. */
	let starting: Promise<void> | undefined;
	const busy = { tail: false, list: false };

	const send = (event: LiveEvent) => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				// a window that went away; it is taken off when its stream closes
			}
		}
	};

	async function follow(session: Session): Promise<Followed> {
		const file = await findTranscript(session.id, session.cwd, deps.claude).catch(() => null);
		const entry: Followed = { session, file, offset: 0, partial: Buffer.alloc(0), recent: [], agents: new Map() };
		if (file) {
			// start from now, with the last few things it did as a lead-in
			entry.offset = await stat(file).then((s) => s.size, () => 0);
			entry.recent = await readNote(file, session.cwd).then((n) => n.story?.recent.slice(-KEPT) ?? [], () => []);
			// sub-agents that are already there are followed from where they are now
			for (const agent of await agentTranscripts(file).catch(() => [])) {
				entry.agents.set(agent.file, { offset: await stat(agent.file).then((s) => s.size, () => 0), partial: Buffer.alloc(0) });
			}
		}
		return entry;
	}

	async function relist() {
		if (busy.list) return;
		busy.list = true;
		try {
			listedAt = Date.now();
			const running = (await deps.list().catch(() => null))?.filter((s) => !s.gone);
			const own = deps.beat ? await deps.beat().catch(() => null) : null;
			const beat = own ?? (running ? signature(running) : null);
			if (beat !== null && lastBeat !== null && beat !== lastBeat) send({ type: 'sessions' });
			if (beat !== null) lastBeat = beat;

			if (!running) return; // could not tell this time: keep following what was being followed
			const ids = new Set(running.map((s) => s.id));
			for (const id of followed.keys()) if (!ids.has(id)) followed.delete(id);
			for (const session of running) {
				const known = followed.get(session.id);
				if (known) known.session = session;
				else followed.set(session.id, await follow(session));
			}
		} finally {
			busy.list = false;
		}
	}

	/** Asks for the list when something hints it changed, or when it has been a while. */
	async function tick() {
		const hint = deps.hint ? await deps.hint().catch(() => null) : null;
		const hinted = hint !== null && hint !== lastHint;
		if (hint !== null) lastHint = hint;
		if (hinted || Date.now() - listedAt >= LIST_MS) await relist();
		await tail();
	}

	async function tail() {
		if (busy.tail) return;
		busy.tail = true;
		try {
			for (const entry of followed.values()) {
				// a session that has not written anything yet gets its file a little later
				if (!entry.file) {
					entry.file = await findTranscript(entry.session.id, entry.session.cwd, deps.claude).catch(() => null);
					if (!entry.file) continue;
					// a new file is read from its start; a big one that only turned up now is history
					const size = await stat(entry.file).then((s) => s.size, () => 0);
					entry.offset = size > REPLAY_MAX ? size : 0;
					entry.partial = Buffer.alloc(0);
				}
				const read = await readNew(entry.file, entry.offset, entry.partial).catch(() => null);
				if (!read) {
					entry.file = null; // moved or deleted: look for it again next time
					continue;
				}
				entry.offset = read.offset;
				entry.partial = read.partial;
				const actions = read.lines.flatMap((line) => actionsFrom(line, entry.session.cwd));
				// What its sub-agents are doing is what the session is doing: while it waits for
				// them its own transcript is silent. A sub-agent that starts now is read from its start.
				for (const agent of await agentTranscripts(entry.file).catch(() => [])) {
					const at = entry.agents.get(agent.file) ?? { offset: 0, partial: Buffer.alloc(0) };
					const more = await readNew(agent.file, at.offset, at.partial).catch(() => null);
					if (!more) continue;
					entry.agents.set(agent.file, { offset: more.offset, partial: more.partial });
					actions.push(...more.lines.flatMap((line) => actionsFrom(line, entry.session.cwd, true)));
				}
				actions.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
				if (!actions.length) continue;
				entry.recent = [...entry.recent, ...actions].slice(-KEPT);
				send({ type: 'actions', id: entry.session.id, actions });
			}
		} finally {
			busy.tail = false;
		}
	}

	function snapshot(): LiveEvent {
		return { type: 'hello', sessions: Object.fromEntries([...followed].map(([id, f]) => [id, f.recent])) };
	}

	return {
		/** Starts listening. Returns what is known right now, and a function that stops listening. */
		async subscribe(listener: Listener): Promise<() => void> {
			listeners.add(listener);
			if (listeners.size === 1) {
				starting = (async () => {
					lastHint = deps.hint ? await deps.hint().catch(() => null) : null;
					await relist();
				})();
				// A tick that fails must not take the server down with it: it is tried again in a second.
				timer = setInterval(() => void tick().catch(() => {}), TICK_MS);
			}
			// a window that connects while the first one is still being answered waits for the same list
			await starting?.catch(() => {});
			listener(snapshot());
			return () => {
				listeners.delete(listener);
				if (listeners.size) return;
				clearInterval(timer);
				followed.clear();
				lastBeat = null;
				starting = undefined;
			};
		},
		/** Tells every open window to read everything again. */
		nudge: () => send({ type: 'sessions' }),
		// for tests, which do not want to wait for a timer
		tick,
		tail,
		relist,
		get following() {
			return [...followed.keys()];
		}
	};
}

type Hub = ReturnType<typeof createHub>;
const slot = globalThis as { __wtfwidLive?: Hub };

/** The one follower of this process. Kept across reloads of this module while developing. */
export function hub(): Hub {
	return (slot.__wtfwidLive ??= createHub({
		// With a saved snapshot or no Linear key there are no sessions to follow; the screen
		// still wants to know when the snapshot file changes.
		// Sessions in the cloud are listed too (S-91): there is no transcript of theirs to follow,
		// but when one starts needing you the screen should say so as fast as for a local one.
		list: async () => {
			if (!(await following())) return [];
			const cloud = await relayState(await config()).then((r) => r.sessions, () => []);
			return [...(await listSessions()), ...cloud];
		},
		beat: async () => ((await following()) ? null : pulse()),
		// Claude Code's own session files, and what sessions in the cloud last reported: when
		// either changes it is worth listing again. The relay is asked at most every five seconds.
		hint: async () => {
			const cloud = await relayState(await config()).then((r) => signature(r.sessions), () => '');
			return `${await sessionFilesStamp(claudeHome())}#${cloud}`;
		}
	}));
}

const following = () => config().then((c) => !c.snapshotFile && !!c.linearKey);
