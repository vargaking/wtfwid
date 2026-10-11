import { describe, expect, it } from 'vitest';
import { buildGraph } from '../graph';
import type { Issue, Snapshot } from '../model';
import { alerts, reliable } from '../notify';
import { contextPack } from '../pack';
import { fetchRelay, toNote, toSession } from './relay';
import { parsePatch, relayAddress } from './settings';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const URL_ = 'https://claude.ai/code/session_018yAbCdEf';
const reported = (over = {}) => ({
	id: 'session_018yAbCdEf', url: URL_, startedAt: NOW - 3_600_000, updatedAt: NOW - 60_000, state: 'working', waitingFor: null, ended: false,
	branch: 'fix/eng-12-reconnect', repo: 'acme/app', cwd: '/home/user/app', title: 'reconnect', lastAsked: 'fix it', lastSaid: null, ...over
});
const issue = (n: number, over: Partial<Issue> = {}): Issue => ({
	id: `ENG-${n}`, title: `Ticket ${n}`, url: '', createdAt: '2026-10-01T08:00:00.000Z', startedAt: null, completedAt: null, canceledAt: null,
	stateName: 'Todo', stateType: 'unstarted', branchName: `fix/eng-${n}-reconnect`, project: { id: 'web', name: 'Web' }, milestone: null, ...over
});
const snap = (over: Partial<Snapshot>): Snapshot => ({ fetchedAt: new Date(NOW).toISOString(), demo: false, warnings: [], issues: [issue(12), issue(13)], prs: [], sessions: [], ...over });

describe('what the relay says, as sessions of the timeline', () => {
	it('S-91: a session in the cloud becomes a session with its state, its branch and its page', () => {
		expect(toSession(reported(), NOW)).toEqual({
			id: 'session_018yAbCdEf', name: 'reconnect', cwd: 'acme/app', kind: 'cloud', startedAt: '2026-10-11T11:00:00.000Z', state: 'working', waitingFor: null, gone: false,
			branch: 'fix/eng-12-reconnect', lastAt: '2026-10-11T11:59:00.000Z', url: URL_, ticket: null, lastAsked: 'fix it', lastSaid: null
		});
		expect(toSession(reported({ state: 'needs', waitingFor: 'Claude needs your permission to use Bash' }), NOW)).toMatchObject({ state: 'needs', waitingFor: 'Claude needs your permission to use Bash' });
		expect(toSession(reported({ state: 'done', ended: true }), NOW)).toMatchObject({ state: 'done', gone: true });
		// with no title it goes by its branch
		expect(toSession(reported({ title: undefined }), NOW)?.name).toBe('fix/eng-12-reconnect');
	});

	it('S-91: "working" that has been silent for hours is no longer believed; anything odd is left out', () => {
		expect(toSession(reported({ updatedAt: NOW - 4 * 3_600_000 }), NOW)).toMatchObject({ state: 'open', gone: false });
		expect(toSession(reported({ state: 'needs', waitingFor: 'x', updatedAt: NOW - 30 * 3_600_000 }), NOW)).toMatchObject({ state: 'needs' });
		expect(toSession(reported({ state: 'exploding' }), NOW)?.state).toBe('open');
		// a link that is not a session's page on claude.ai is not shown as one
		expect(toSession(reported({ url: 'https://evil.example/code/session_x' }), NOW)?.url).toBeNull();
		expect(toSession(reported({ url: 'javascript:alert(1)' }), NOW)?.url).toBeNull();
		for (const bad of [null, 'x', {}, { id: '../../etc' }, { id: 5 }]) expect(toSession(bad, NOW)).toBeNull();
		expect(toNote({ id: 'n', at: NOW, title: 'T', summary: 'S', decided: ['a', 5], open: 'no', url: 'http://plain.example', ticket: 'ENG-12' })).toEqual({
			id: 'n', at: '2026-10-11T12:00:00.000Z', ticket: 'ENG-12', title: 'T', summary: 'S', decided: ['a'], open: [], url: null
		});
		expect(toNote({ id: 'n', at: NOW, title: 'T' })).toBeNull();
	});

	it('S-91: reads the relay with the read token, and says in words what went wrong', async () => {
		const asked: { url: string; auth: string | null }[] = [];
		const ok = (async (url: string, init: RequestInit) => {
			asked.push({ url, auth: new Headers(init.headers).get('authorization') });
			return new Response(JSON.stringify({ now: NOW, sessions: [reported(), { nonsense: true }], notes: [{ id: 'n', at: NOW, title: 'T', summary: 'S', ticket: 'ENG-12' }] }));
		}) as typeof fetch;
		const state = await fetchRelay('https://relay.example/', 'read', NOW, ok);
		expect(asked).toEqual([{ url: 'https://relay.example/state', auth: 'Bearer read' }]);
		expect([state.sessions.length, state.notes.length]).toEqual([1, 1]);
		const answer = (status: number, body = '{}') => (async () => new Response(body, { status })) as unknown as typeof fetch;
		await expect(fetchRelay('https://r', 't', NOW, answer(401))).rejects.toThrow('the relay refused the token');
		await expect(fetchRelay('https://r', 't', NOW, answer(502))).rejects.toThrow('the relay answered HTTP 502');
		await expect(fetchRelay('https://r', 't', NOW, answer(200, '<html>'))).rejects.toThrow('something else than its state');
		await expect(fetchRelay('https://r', 't', NOW, (async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch)).rejects.toThrow('the relay could not be reached');
	});
});

describe('cloud sessions on the timeline', () => {
	it('S-91: one lands on its ticket by its branch, or by the ticket it said it is for, and gives the ticket its state', () => {
		const byBranch = toSession(reported({ state: 'needs', waitingFor: 'permission' }), NOW)!;
		const byWord = toSession(reported({ id: 'session_other99', url: null, branch: 'claude/dreamy-maxwell-x1', ticket: 'ENG-13' }), NOW)!;
		const stray = toSession(reported({ id: 'session_stray77', url: null, branch: 'claude/no-ticket', title: 'spike' }), NOW)!;
		const graph = buildGraph(snap({ sessions: [byBranch, byWord, stray] }));
		const nodes = Object.fromEntries(graph.lanes.flatMap((l) => l.nodes).map((n) => [n.id, n]));
		// neither ticket was started in Linear: the session is what puts it on the timeline
		expect(nodes['ENG-12']).toMatchObject({ state: 'needs', stage: 'session' });
		expect(nodes['ENG-13']).toMatchObject({ state: 'working', stage: 'session' });
		expect(graph.lanes.at(-1)).toMatchObject({ kind: 'unsorted' });
		expect(graph.lanes.at(-1)!.nodes[0]).toMatchObject({ id: 'session:session_stray77', title: 'spike' });
	});

	it('S-18, S-91: a cloud session that starts needing you is news; a relay that cannot be reached is not', () => {
		const working = buildGraph(snap({ sessions: [toSession(reported(), NOW)!] }));
		const needs = buildGraph(snap({ sessions: [toSession(reported({ state: 'needs', waitingFor: 'Claude needs your permission to use Bash' }), NOW)!] }));
		expect(alerts(working, needs)).toEqual([{ id: 'ENG-12', kind: 'needs', title: 'ENG-12 needs you', body: 'Ticket 12\nWaiting for: Claude needs your permission to use Bash' }]);
		const done = buildGraph(snap({ sessions: [toSession(reported({ state: 'open' }), NOW)!] }));
		expect(alerts(working, done).map((a) => a.kind)).toEqual(['finished']);
		// the relay is away: every cloud session is missing, which must not read as all of them stopping
		const away = buildGraph(snap({ sessions: [], warnings: ['Cloud sessions: the relay could not be reached'] }));
		expect(reliable(away)).toBe(false);
		expect(reliable(working)).toBe(true);
	});

	it('S-91: notes are on the ticket they name, newest first, and go into the context for a new session', () => {
		const note = (id: string, at: string, over = {}) => ({ id, at, ticket: 'eng-12', title: `Note ${id}`, summary: `Summary ${id}.`, decided: ['Restart ICE'], open: ['Firefox'], url: null, ...over });
		const graph = buildGraph(snap({ notes: [note('a', '2026-10-09T10:00:00.000Z'), note('b', '2026-10-10T10:00:00.000Z'), note('c', '2026-10-10T11:00:00.000Z', { ticket: null, title: 'About ENG-13 scope' }), note('d', '2026-10-10T12:00:00.000Z', { ticket: 'ENG-999' })] }));
		const nodes = Object.fromEntries(graph.lanes.flatMap((l) => l.nodes).map((n) => [n.id, n]));
		// a ticket nobody started, with a note: the talk about it is why it is here
		expect(nodes['ENG-12'].notes!.map((n) => n.id)).toEqual(['b', 'a']);
		// one that names its ticket only in its title still finds it; one for a ticket that is not there is dropped
		expect(nodes['ENG-13'].notes!.map((n) => n.id)).toEqual(['c']);
		const pack = contextPack(nodes['ENG-12'], {});
		expect(pack).toContain('## Note from 2026-10-09: Note a\n\nSummary a.\n\nDecided:\n- Restart ICE\n\nStill open:\n- Firefox');
		expect(pack.indexOf('Note a')).toBeLessThan(pack.indexOf('Note b'));
	});

	it('S-57, S-91: the context for a new session says what a cloud session reported, and where it is', () => {
		const session = toSession(reported({ state: 'open', lastSaid: 'ICE restart is in. Firefox still drops.' }), NOW)!;
		const [node] = buildGraph(snap({ sessions: [session] })).lanes[0].nodes;
		const pack = contextPack(node, {});
		expect(pack).toContain(`It ran in the cloud: ${URL_}`);
		expect(pack).toContain('Where it ended:\n> ICE restart is in. Firefox still drops.');
		expect(pack).not.toContain('transcript');
	});
});

describe('the relay in the settings', () => {
	it('S-91: the address must be https, or plain http only for one on this machine; the token is a secret like the others', () => {
		expect(relayAddress('https://relay.example.workers.dev')).toBe(true);
		expect(relayAddress('http://127.0.0.1:8787')).toBe(true);
		expect(relayAddress('http://localhost:8787')).toBe(true);
		for (const bad of ['http://relay.example', 'ftp://x', 'relay.example', 'https://user:pw@relay.example', 'https://relay.example/?token=x', 'javascript:alert(1)']) expect(relayAddress(bad)).toBe(false);
		expect(parsePatch({ relayUrl: ' https://relay.example/ ', relayToken: ' secret ' })).toEqual({ relayUrl: 'https://relay.example', relayToken: 'secret' });
		expect(parsePatch({ relayUrl: '' })).toEqual({ relayUrl: '' });
		expect(parsePatch({ relayUrl: 'http://relay.example' })).toMatch(/must start with https/);
		expect(parsePatch({ relayToken: null })).toEqual({ relayToken: null });
	});
});
