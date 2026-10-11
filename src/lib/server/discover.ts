import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session } from '../model';
import { claudeHome } from './transcript';

/**
 * Finds past sessions on disk (S-83). Claude Code only lists sessions that still exist,
 * but it keeps a transcript of every one for weeks. Each transcript is a session wtfwid
 * can put on the timeline, so history is there the first time the app is opened.
 *
 * Only the start and the end of each file are read: who and where from the first lines,
 * the name, the branch and the last sign of life from the last.
 */

const TRANSCRIPT = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;
const HEAD = 32 * 1024;
const TAIL = 256 * 1024;

/** The last value of a string field in a piece of a transcript, or null. */
function lastString(text: string, field: string): string | null {
	const at = text.lastIndexOf(`"${field}":"`);
	if (at < 0) return null;
	const raw = /^"[^"]+":"((?:[^"\\]|\\.)*)"/.exec(text.slice(at, at + 2000))?.[1];
	if (raw === undefined) return null;
	try {
		return JSON.parse(`"${raw}"`) || null;
	} catch {
		return null; // cut off in the middle
	}
}

async function readPiece(file: string, from: 'start' | 'end', bytes: number): Promise<string> {
	const handle = await open(file, 'r');
	try {
		const { size } = await handle.stat();
		const length = Math.min(size, bytes);
		const { buffer } = await handle.read(Buffer.alloc(length), 0, length, from === 'start' ? 0 : size - length);
		return buffer.toString('utf8');
	} finally {
		await handle.close();
	}
}

/** What one transcript says about its session, or null when it is not a session of its own. */
export async function sessionFrom(file: string, id: string): Promise<Session | null> {
	const head = await readPiece(file, 'start', HEAD);
	let cwd: string | null = null;
	let startedAt: string | null = null;
	for (const line of head.split('\n')) {
		let entry: { cwd?: unknown; timestamp?: unknown; isSidechain?: unknown };
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // a line longer than the piece that was read
		}
		if (entry.isSidechain === true) return null; // a sub-agent's conversation, part of another session
		if (typeof entry.timestamp === 'string') startedAt ??= entry.timestamp;
		if (typeof entry.cwd === 'string') cwd ??= entry.cwd;
		if (cwd && startedAt) break;
	}
	if (!cwd || !startedAt || Number.isNaN(Date.parse(startedAt))) return null;

	const tail = await readPiece(file, 'end', TAIL);
	const branch = lastString(tail, 'gitBranch');
	return {
		id,
		// the name you gave it, else the one Claude Code made up for it
		name: lastString(tail, 'customTitle') ?? lastString(tail, 'aiTitle'),
		cwd,
		kind: 'interactive',
		startedAt: new Date(startedAt).toISOString(),
		// Whether it finished is not written down anywhere. "open" claims the least.
		state: 'open',
		waitingFor: null,
		gone: true,
		branch: branch && branch !== 'HEAD' ? branch : null,
		fromDisk: true,
		lastAt: lastString(tail, 'timestamp')
	};
}

const cache = new Map<string, { stamp: string; session: Session | null }>();

/** Every session that has a transcript under `root`, oldest first. Files are read again only when they change. */
export async function discoverSessions(root = claudeHome()): Promise<Session[]> {
	const projects = join(root, 'projects');
	const newest = new Map<string, { session: Session; at: number; began: string }>();
	for (const folder of await readdir(projects).catch(() => [] as string[])) {
		for (const name of await readdir(join(projects, folder)).catch(() => [] as string[])) {
			const id = TRANSCRIPT.exec(name)?.[1];
			if (!id) continue;
			const file = join(projects, folder, name);
			const info = await stat(file).catch(() => null);
			if (!info?.isFile() || !info.size) continue;
			const stamp = `${info.mtimeMs}:${info.size}`;
			let hit = cache.get(file);
			if (hit?.stamp !== stamp) {
				hit = { stamp, session: await sessionFrom(file, id).catch(() => null) };
				cache.set(file, hit);
			}
			if (!hit.session) continue;
			// A session that moved folder has a file in each. The one written to last is current,
			// but the session began when its first file did.
			const seen = newest.get(id);
			const began = seen && seen.began < hit.session.startedAt ? seen.began : hit.session.startedAt;
			if (!seen || info.mtimeMs > seen.at) newest.set(id, { session: hit.session, at: info.mtimeMs, began });
			else seen.began = began;
		}
	}
	return [...newest.values()].map((n) => ({ ...n.session, startedAt: n.began })).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
