import { describe, expect, it } from 'vitest';
import type { Graph, GraphNode, NodeState, Session } from './model';
import { alerts, reliable } from './notify';

const session = (state: Session['state'], waitingFor: string | null = null): Session => ({ id: 's1', name: 'claude-07', cwd: '/r', kind: 'interactive', startedAt: '2026-10-10T09:00:00.000Z', state, waitingFor, gone: false });
const node = (id: string, state: NodeState, over: Partial<GraphNode> = {}): GraphNode => ({
	id, label: id, title: 'Reconnect after a network change', url: null, at: '2026-10-10T09:00:00.000Z', state, stage: 'session', status: 'In Progress', startedAt: null, completedAt: null, sessions: [], prs: [], ...over
});
const graph = (...nodes: GraphNode[]): Graph => ({
	fetchedAt: '2026-10-10T12:00:00.000Z', demo: false, setup: false, warnings: [],
	lanes: [{ id: 'a', name: 'a', project: null, kind: 'project', parent: null, closed: false, nodes }]
});
const kinds = (before: NodeState, after: NodeState) =>
	alerts(graph(node('ENG-1', before)), graph(node('ENG-1', after, { sessions: after === 'failed' ? [session('failed')] : [] }))).map((a) => a.kind);

describe('alerts', () => {
	it('S-18 says when a ticket starts needing you, and what it is waiting for', () => {
		const after = graph(node('ENG-1', 'needs', { sessions: [session('needs', 'permission prompt')] }));
		expect(alerts(graph(node('ENG-1', 'working')), after)).toEqual([
			{ id: 'ENG-1', kind: 'needs', title: 'ENG-1 needs you', body: 'Reconnect after a network change\nWaiting for: permission prompt' }
		]);
	});

	it('S-18 says when a session fails, and when one that was working stops', () => {
		expect(kinds('working', 'failed')).toEqual(['failed']);
		expect(kinds('open', 'failed')).toEqual(['failed']);
		expect(kinds('working', 'open')).toEqual(['finished']);
		expect(kinds('working', 'review')).toEqual(['finished']);
		expect(kinds('working', 'done')).toEqual(['finished']);
	});

	it('S-18 stays quiet when nothing you care about changed', () => {
		expect(kinds('needs', 'needs')).toEqual([]);
		expect(kinds('needs', 'working')).toEqual([]);
		expect(kinds('open', 'working')).toEqual([]);
		expect(kinds('open', 'done')).toEqual([]);
		expect(kinds('review', 'done')).toEqual([]);
	});

	it('S-18 speaks up about a ticket it has not seen before only if it needs you or failed', () => {
		const empty = graph();
		expect(alerts(empty, graph(node('ENG-2', 'needs'))).map((a) => a.kind)).toEqual(['needs']);
		expect(alerts(empty, graph(node('ENG-2', 'working'), node('ENG-3', 'done')))).toEqual([]);
	});

	it('S-18 says nothing about a refresh where Linear or Claude Code could not be read', () => {
		const working = graph(node('ENG-1', 'working'), node('ENG-2', 'needs'));
		// the sessions could not be listed: every ticket falls back to "open"
		const blind = { ...graph(node('ENG-1', 'open'), node('ENG-2', 'open')), warnings: ['Claude Code: timed out'] };
		expect(alerts(working, blind)).toEqual([]);
		expect(alerts(blind, working)).toEqual([]);
		expect(alerts({ ...working, warnings: ['Linear: fetch failed'] }, working)).toEqual([]);
		expect(reliable(blind)).toBe(false);
		// pull requests do not decide any of the three things worth saying
		const noGitHub = { ...graph(node('ENG-1', 'open')), warnings: ['GitHub: o/r: HTTP 502'] };
		expect(reliable(noGitHub)).toBe(true);
		expect(alerts(working, noGitHub).map((a) => a.kind)).toEqual(['finished']);
	});

	it('S-18 says nothing when setup has just been finished, or the demo is left', () => {
		const first = graph(node('ENG-1', 'needs'), node('ENG-2', 'failed', { sessions: [session('failed')] }));
		expect(alerts({ ...graph(), setup: true }, first)).toEqual([]);
		expect(alerts({ ...graph(), demo: true }, first)).toEqual([]);
	});

	it('S-18 says "failed" once per session that fails, not each time the ticket comes back to it', () => {
		const failed = (state: NodeState) => graph(node('ENG-1', state, { sessions: [session('failed')] }));
		// an older session on the same ticket stopped waiting: the failure underneath is old news
		expect(alerts(failed('needs'), failed('failed'))).toEqual([]);
		// a session that was waiting and then failed is news
		const waiting = graph(node('ENG-1', 'needs', { sessions: [session('needs')] }));
		expect(alerts(waiting, failed('failed')).map((a) => a.kind)).toEqual(['failed']);
	});

	it('S-18 names a session with no ticket by its own name', () => {
		const loose = (state: NodeState) => node('session:s1', state, { label: 'try-bun-runti…', title: 'try-bun-runtime', status: null });
		expect(alerts(graph(loose('working')), graph(loose('open')))).toEqual([{ id: 'session:s1', kind: 'finished', title: 'try-bun-runtime is done working', body: '' }]);
	});
});
