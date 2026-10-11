import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Session } from '../model';
import { findTranscript, lastBranch } from './transcript';

const run = promisify(execFile);

/** One entry of `claude agents --json`, as Claude Code documents it. */
interface AgentEntry {
	id?: string;
	sessionId?: string;
	name?: string;
	cwd: string;
	kind: 'interactive' | 'background';
	startedAt: number;
	state?: 'working' | 'blocked' | 'done' | 'failed' | 'stopped';
	status?: 'busy' | 'waiting' | 'idle';
	waitingFor?: string;
}

export function toSession(e: AgentEntry): Session {
	// A live process says more about right now than the saved job state does.
	const state: Session['state'] =
		e.status === 'waiting' || e.state === 'blocked'
			? 'needs'
			: e.status === 'busy' || e.state === 'working'
				? 'working'
				: e.state === 'failed'
					? 'failed'
					: e.state === 'done'
						? 'done'
						: 'open';
	return {
		id: e.sessionId ?? e.id ?? `${e.cwd}@${e.startedAt}`,
		name: e.name ?? null,
		cwd: e.cwd,
		kind: e.kind,
		startedAt: new Date(e.startedAt).toISOString(),
		state,
		waitingFor: e.waitingFor ?? null,
		gone: false
	};
}

/**
 * Adds the sessions Claude Code lists now to the ones seen before (S-53).
 * A remembered session that is no longer listed keeps its place; one that was
 * working or waiting can no longer be either, so it becomes "open".
 */
export function remember(known: Session[], listed: Session[]): Session[] {
	const now = new Map(listed.map((s) => [s.id, s]));
	const kept = known
		.filter((s) => !now.has(s.id))
		.map((s): Session => ({
			...s,
			gone: true,
			waitingFor: null,
			state: s.state === 'working' || s.state === 'needs' ? 'open' : s.state
		}));
	return [...kept, ...listed].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export async function listSessions(): Promise<Session[]> {
	const { stdout } = await run('claude', ['agents', '--json', '--all'], { timeout: 15_000, maxBuffer: 16 << 20 });
	return (JSON.parse(stdout) as AgentEntry[]).map(toSession);
}

/** Adds the branch each listed session is on, where its transcript says (S-50). */
async function withBranches(listed: Session[], known: Session[], claude: string | undefined): Promise<Session[]> {
	const before = new Map(known.map((s) => [s.id, s.branch ?? null]));
	return Promise.all(
		listed.map(async (s) => {
			const branch = await findTranscript(s.id, s.cwd, claude)
				.then((file) => (file ? lastBranch(file) : null))
				.catch(() => null);
			return { ...s, branch: branch ?? before.get(s.id) ?? null };
		})
	);
}

/** `claude` is where Claude Code keeps its files; tests point it somewhere else. */
export async function collectSessions(home: string, list: () => Promise<Session[]> = listSessions, claude?: string): Promise<Session[]> {
	const file = join(home, 'sessions.json');
	// No file yet means nothing remembered. A file that cannot be read is an error, not an
	// empty list: carrying on would write it back without the sessions it held.
	const known: unknown = await readFile(file, 'utf8').then(JSON.parse, (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? [] : Promise.reject(e)));
	if (!Array.isArray(known)) throw new Error(`${file} does not hold a list of sessions`);
	const all = remember(known, await withBranches(await list(), known, claude));
	await mkdir(home, { recursive: true });
	// written beside the file and moved into place, so nothing ever reads half of it
	const draft = `${file}.${process.pid}.tmp`;
	await writeFile(draft, JSON.stringify(all, null, '\t'));
	await rename(draft, file);
	return all;
}

/** A session wtfwid has seen, by id. */
export async function knownSession(home: string, id: string): Promise<Session | undefined> {
	const known: unknown = await readFile(join(home, 'sessions.json'), 'utf8').then(JSON.parse).catch(() => []);
	return Array.isArray(known) ? (known as Session[]).find((s) => s.id === id) : undefined;
}
