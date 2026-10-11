import type { Note, Session } from '../model';

/**
 * Reads the relay (S-91): what sessions running in the cloud have reported about
 * themselves, and the notes conversations left through the connector. The relay is a small
 * server of your own on the internet (see the `relay` folder); wtfwid only ever reads it.
 */

/** A session that said "working" and then nothing for this long most likely is not any more. */
const SILENT_MS = 3 * 60 * 60_000;
const TIMEOUT_MS = 8000;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const iso = (v: unknown, fallback: number) => new Date(typeof v === 'number' && Number.isFinite(v) ? v : fallback).toISOString();
const STATES = new Set(['needs', 'working', 'open', 'done']);

/** One session as the relay keeps it, as a session of the timeline. Null for what is not one. */
export function toSession(r: any, now: number): Session | null {
	if (!r || typeof r !== 'object' || !/^[\w-]{6,90}$/.test(str(r.id))) return null;
	const url = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/.test(str(r.url)) ? str(r.url) : null;
	const last = typeof r.updatedAt === 'number' ? r.updatedAt : now;
	let state = (STATES.has(r.state) ? r.state : 'open') as Session['state'];
	// its container can be taken away without a word; a claim to be working does not last for ever
	if (state === 'working' && now - last > SILENT_MS) state = 'open';
	const ended = r.ended === true || state === 'done';
	const repo = str(r.repo);
	return {
		id: str(r.id),
		name: str(r.title) || str(r.branch) || null,
		// where it runs is a container nobody can open; the repository says more
		cwd: repo || str(r.cwd),
		kind: 'cloud',
		startedAt: iso(r.startedAt, last),
		state,
		waitingFor: state === 'needs' ? str(r.waitingFor) || null : null,
		gone: ended,
		branch: str(r.branch) || null,
		lastAt: iso(last, now),
		url,
		ticket: str(r.ticket) || null,
		lastAsked: str(r.lastAsked) || null,
		lastSaid: str(r.lastSaid) || null
	};
}

export function toNote(r: any): Note | null {
	if (!r || typeof r !== 'object' || !str(r.id) || !str(r.summary) || typeof r.at !== 'number') return null;
	const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
	return {
		id: str(r.id),
		at: new Date(r.at).toISOString(),
		ticket: str(r.ticket) || null,
		title: str(r.title) || 'Note',
		summary: str(r.summary),
		decided: list(r.decided),
		open: list(r.open),
		url: /^https:\/\//.test(str(r.url)) ? str(r.url) : null
	};
}

export interface RelayState {
	sessions: Session[];
	notes: Note[];
}

/** Everything the relay knows. Throws with a sentence that says what went wrong. */
export async function fetchRelay(url: string, token: string, now = Date.now(), fetcher: typeof fetch = fetch): Promise<RelayState> {
	let res: Response;
	try {
		res = await fetcher(`${url.replace(/\/+$/, '')}/state`, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'wtfwid' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
	} catch {
		throw new Error('the relay could not be reached');
	}
	if (res.status === 401) throw new Error('the relay refused the token');
	if (!res.ok) throw new Error(`the relay answered HTTP ${res.status}`);
	const body: any = await res.json().catch(() => null);
	if (!body || !Array.isArray(body.sessions)) throw new Error('the relay answered with something else than its state');
	return {
		sessions: body.sessions.map((r: unknown) => toSession(r, now)).filter((s: Session | null): s is Session => s !== null),
		notes: (Array.isArray(body.notes) ? body.notes : []).map(toNote).filter((n: Note | null): n is Note => n !== null)
	};
}
