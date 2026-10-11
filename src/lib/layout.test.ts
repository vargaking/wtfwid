import { describe, expect, it } from 'vitest';
import { AXIS_H, LANE_H, LINE_Y, layout } from './layout';
import type { Graph, GraphNode, Lane, NodeState } from './model';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');

const node = (id: string, at: string, state: NodeState = 'done'): GraphNode => ({
	id,
	label: id,
	title: id,
	url: null,
	at,
	state,
	stage: 'ticket',
	status: 'x',
	startedAt: at,
	completedAt: null,
	sessions: [],
	prs: []
});
const lane = (id: string, nodes: GraphNode[], over: Partial<Lane> = {}): Lane => ({
	id,
	name: id,
	project: null,
	kind: 'project',
	parent: null,
	closed: false,
	nodes,
	...over
});
const graph = (lanes: Lane[]): Graph => ({ fetchedAt: new Date(NOW).toISOString(), demo: false, setup: false, warnings: [], lanes });

describe('clusters', () => {
	const g = graph([
		lane('a', [
			node('n1', '2026-10-08T09:00:00.000Z'),
			node('n2', '2026-10-08T11:00:00.000Z', 'needs'),
			node('n3', '2026-10-09T09:00:00.000Z')
		])
	]);

	it('S-35 merges nodes that would overlap and colours the cluster by its most urgent member', () => {
		const [first, second] = layout(g, NOW, 160).lanes[0].clusters;
		expect(first.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
		expect(first).toMatchObject({ state: 'needs', stage: null, label: '2 tickets' });
		expect(second).toMatchObject({ state: 'done', stage: 'ticket', label: 'n3' });
	});

	it('S-35 separates them when zoomed in', () => {
		expect(layout(g, NOW, 1600).lanes[0].clusters).toHaveLength(3);
	});

	it('S-35 never puts two clusters closer than one label', () => {
		const busy = graph([lane('a', Array.from({ length: 40 }, (_, i) => node(`n${i}`, new Date(NOW - i * 3_600_000).toISOString())).reverse())]);
		const xs = layout(busy, NOW, 160).lanes[0].clusters.map((c) => c.x);
		for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(68);
	});
});

describe('lines and branches', () => {
	const trunk = lane('p', [node('t1', '2026-10-06T09:00:00.000Z')]);
	const open = lane('m-new', [node('a1', '2026-10-09T09:00:00.000Z', 'working')], { kind: 'milestone', parent: 'p' });
	const closed = lane('m-old', [node('b1', '2026-10-03T09:00:00.000Z'), node('b2', '2026-10-05T09:00:00.000Z')], { kind: 'milestone', parent: 'p', closed: true });
	const view = layout(graph([trunk, open, closed]), NOW, 160);
	const [t, o, c] = view.lanes;

	it('S-10 lays time out linearly', () => {
		const dayApart = c.clusters[1].x - c.clusters[0].x;
		expect(dayApart).toBe(320);
	});

	it('S-12 ends a finished line at its last node and runs an unfinished one to now', () => {
		expect(c.lineRight).toBe(c.clusters[1].x);
		expect(o.lineRight).toBe(view.nowX);
		expect(t.lineRight).toBe(view.nowX);
	});

	it('S-21 branches each milestone off the trunk just before its first node', () => {
		expect(view.connectors).toEqual([
			{ left: o.lineLeft - 28, top: t.y + LINE_Y, width: 28, height: LANE_H },
			{ left: c.lineLeft - 28, top: t.y + LINE_Y, width: 28, height: 2 * LANE_H }
		]);
		expect(t.lineLeft).toBe(c.lineLeft - 28);
	});

	it('S-23 keeps a branch connector clear of the lines it passes', () => {
		// the older milestone's connector runs through the newer milestone's row, left of where that line starts
		expect(view.connectors[1].left).toBeLessThan(o.lineLeft);
	});

	it('S-13 hides finished lines on request and closes the gap', () => {
		const hidden = layout(graph([trunk, open, closed]), NOW, 160, true);
		expect(hidden.lanes.map((l) => l.lane.id)).toEqual(['p', 'm-new']);
		expect(hidden.lanes[1].y).toBe(AXIS_H + LANE_H);
		expect(hidden.connectors).toHaveLength(1);
	});

	it('S-10 labels days up to today, and lets "now" carry the date just after midnight', () => {
		const noon = layout(graph([trunk]), NOW, 160);
		expect(noon.nowLabel).toBe('now');
		expect(noon.ticks.filter((t) => t.label).at(-1)?.label).toBe('Sat 10 Oct');

		const justAfterMidnight = layout(graph([trunk]), Date.parse('2026-10-10T00:05:00.000Z'), 160);
		expect(justAfterMidnight.nowLabel).toBe('Sat 10 Oct · now');
		expect(justAfterMidnight.ticks.filter((t) => t.label).at(-1)?.label).toBe('Fri 9 Oct');
	});

	it('counts states for the header', () => {
		expect(view.counts).toEqual({ needs: 0, working: 1, review: 0, failed: 0 });
	});

	it('S-20 gives a trunk with no tickets of its own the extent of its milestones', () => {
		const empty = layout(graph([lane('p', [], { closed: true }), closed]), NOW, 160);
		expect(empty.lanes[0].lineLeft).toBe(empty.lanes[1].lineLeft - 28);
		expect(empty.lanes[0].lineRight).toBe(empty.lanes[1].lineRight);
	});
});
