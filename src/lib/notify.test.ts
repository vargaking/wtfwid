import { describe, expect, it } from 'vitest';
import type { Graph, GraphNode, NodeState, Session } from './model';
import { alerts } from './notify';

const session = (state: Session['state'], waitingFor: string | null = null): Session => ({ id: 's1', name: 'claude-07', cwd: '/r', kind: 'interactive', startedAt: '2026-10-10T09:00:00.000Z', state, waitingFor, gone: false });
const node = (id: string, state: NodeState, over: Partial<GraphNode> = {}): GraphNode => ({
	id, label: id, title: 'Reconnect after a network change', url: null, at: '2026-10-10T09:00:00.000Z', state, stage: 'session', status: 'In Progress', startedAt: null, completedAt: null, sessions: [], prs: [], ...over
});
const graph = (...nodes: GraphNode[]): Graph => ({
	fetchedAt: '2026-10-10T12:00:00.000Z', demo: false, setup: false, warnings: [],
	lanes: [{ id: 'a', name: 'a', project: null, kind: 'project', parent: null, closed: false, nodes }]
});
const kinds = (before: NodeState, after: NodeState) => alerts(graph(node('ENG-1', before)), graph(node('ENG-1', after))).map((a) => a.kind);

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

	it('S-18 names a session with no ticket by its own name', () => {
		const loose = (state: NodeState) => node('session:s1', state, { label: 'try-bun-runti…', title: 'try-bun-runtime', status: null });
		expect(alerts(graph(loose('working')), graph(loose('open')))).toEqual([{ id: 'session:s1', kind: 'finished', title: 'try-bun-runtime is done working', body: '' }]);
	});
});
