import { describe, expect, it } from 'vitest';
import { AXIS_H, DAY, FOLD_H, FOLD_LINE_Y, LANE_H, LINE_Y, MAX_ROWS, ROW_H, layout, nextInState, xOf } from './layout';
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

const hourly = (count: number, state: NodeState = 'done') =>
	Array.from({ length: count }, (_, i) => node(`n${i}`, new Date(NOW - i * 3_600_000).toISOString(), state)).reverse();

/** A repeatable stand-in for chance, so a failing case can be found again. */
function chance(seed: number) {
	return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const STATES: NodeState[] = ['done', 'done', 'done', 'working', 'needs', 'open', 'review', 'failed'];
/** A lane the way real ones look: bursts of tickets within the hour, of every state and title length. */
function busy(seed: number, count: number): GraphNode[] {
	const next = chance(seed);
	let t = NOW - 9 * DAY;
	return Array.from({ length: count }, (_, i) => {
		t += next() < 0.6 ? next() * 3_600_000 : next() * 1.5 * DAY;
		return { ...node(`ENG-${i + 1}`, new Date(Math.min(t, NOW)).toISOString(), STATES[Math.floor(next() * STATES.length)]), title: 'x'.repeat(3 + Math.floor(next() * 50)) };
	});
}
const ZOOMS = [12, 53, 160, 600, 1600];
const xAt = (n: GraphNode, view: { t0: number }, pxPerDay: number) => Math.round(xOf(Date.parse(n.at), view.t0, pxPerDay));

describe('rows', () => {
	const g = graph([
		lane('a', [
			node('n1', '2026-10-08T09:00:00.000Z'),
			node('n2', '2026-10-08T11:00:00.000Z', 'needs'),
			node('n3', '2026-10-09T09:00:00.000Z')
		]),
		lane('b', [node('m1', '2026-10-08T09:00:00.000Z')])
	]);

	it('S-35 stacks tickets started close together instead of merging them', () => {
		const [a, b] = layout(g, NOW, 160).lanes;
		expect(a.clusters.map((c) => [c.nodes[0].id, c.row])).toEqual([['n1', 0], ['n2', 1], ['n3', 0]]);
		expect(a.clusters.every((c) => c.nodes.length === 1)).toBe(true);
		// the lane grows by one row, and the next lane moves down with it
		expect(a.height).toBe(LANE_H + ROW_H);
		expect(b.y).toBe(AXIS_H + LANE_H + ROW_H);
	});

	it('S-35 puts them back on one row when zoomed in', () => {
		const [a] = layout(g, NOW, 1600).lanes;
		expect(a.clusters.map((c) => c.row)).toEqual([0, 0, 0]);
		expect(a.height).toBe(LANE_H);
	});

	it('S-35 keeps every single ticket at its own time', () => {
		for (const pxPerDay of ZOOMS) {
			const view = layout(graph([lane('a', busy(7, 60))]), NOW, pxPerDay);
			for (const c of view.lanes[0].clusters) expect(c.x).toBe(xAt(c.nodes[0], view, pxPerDay));
		}
	});

	it('S-35 never draws two things in a row over each other, at any zoom', () => {
		for (const seed of [1, 2, 3, 4, 5, 6]) {
			for (const pxPerDay of ZOOMS) {
				const { clusters } = layout(graph([lane('a', busy(seed, 60))]), NOW, pxPerDay).lanes[0];
				expect(clusters.reduce((n, c) => n + c.nodes.length, 0)).toBe(60);
				for (let row = 0; row < MAX_ROWS; row++) {
					const inRow = clusters.filter((c) => c.row === row).sort((a, b) => a.x - b.x);
					for (let i = 1; i < inRow.length; i++) expect(inRow[i].left, `seed ${seed}, ${pxPerDay} px/day, row ${row}`).toBeGreaterThanOrEqual(inRow[i - 1].right + 4);
				}
			}
		}
	});

	it('S-35 cuts a name short before it merges anything', () => {
		// five tickets in play within four hours take all five rows with their names; two more start a day later
		const burst = [0, 1, 2, 3, 4].map((h) => ({ ...node(`ENG-${h + 1}`, `2026-10-08T${String(9 + h).padStart(2, '0')}:00:00.000Z`, 'working'), title: 'Reconnect after a network change' }));
		const later = [node('ENG-6', '2026-10-09T14:00:00.000Z', 'needs'), node('ENG-7', '2026-10-09T16:30:00.000Z', 'working')];
		const view = layout(graph([lane('a', [...burst, ...later])]), NOW, 160);
		const { clusters } = view.lanes[0];
		expect(clusters.map((c) => c.nodes.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
		const six = clusters.find((c) => c.key === 'ENG-6')!;
		expect(six.x).toBe(xAt(later[0], view, 160));
		expect(six.label).toBe('ENG-6');
		// the ticket before it in that row keeps as much of its name as fits
		const before = clusters.find((c) => c.row === six.row && c.x < six.x)!;
		expect(before.label).toMatch(/^ENG-\d · Reconnect.*…$/);
		expect(before.right + 4).toBeLessThanOrEqual(six.left);
	});

	it('S-35 merges only when a mark is in the way in every row, and then into the nearest in time', () => {
		for (const pxPerDay of [12, 53]) {
			const view = layout(graph([lane('a', busy(3, 60))]), NOW, pxPerDay);
			const merged = view.lanes[0].clusters.filter((c) => c.nodes.length > 1);
			expect(merged.length).toBeGreaterThan(0);
			expect(Math.max(...view.lanes[0].clusters.map((c) => c.row))).toBe(MAX_ROWS - 1);
			// a node that was merged started within reach of the cluster's own mark
			for (const c of merged) for (const n of c.nodes) expect(xAt(n, view, pxPerDay) - c.right).toBeLessThan(4 + 12);
		}
	});

	it('S-35 colours a cluster by its most urgent member and counts it', () => {
		const old = Array.from({ length: 12 }, (_, i) => node(`old${i}`, new Date(NOW - 20 * DAY + i * 3_600_000).toISOString()));
		const lots = graph([lane('a', [...old, ...hourly(12), node('late', new Date(NOW).toISOString(), 'needs')])]);
		const { clusters } = layout(lots, NOW, 12).lanes[0];
		const merged = clusters.find((c) => c.nodes.some((n) => n.id === 'late'))!;
		expect(merged).toMatchObject({ state: 'needs', stage: null, quiet: false, label: `${merged.nodes.length} tickets` });
		expect(clusters.find((c) => c.nodes.length > 1 && c.nodes.every((n) => n.state === 'done'))).toMatchObject({ quiet: true, label: null });
		// its pill starts where its first ticket is and reaches towards the later ones
		expect(merged.markX).toBeGreaterThan(merged.x);
		expect(merged.left).toBe(merged.x - 12);
	});
});

describe('labels', () => {
	const titled = (id: string, at: string, state: NodeState) => ({ ...node(id, at, state), title: 'Reconnect after a network change' });

	it('S-36 names work in play in full while there is a row with room for it', () => {
		const g = graph([lane('a', [titled('ENG-1', '2026-10-08T09:00:00.000Z', 'working'), titled('ENG-2', '2026-10-08T10:00:00.000Z', 'needs')])]);
		for (const pxPerDay of ZOOMS.slice(0, 3)) {
			const { clusters } = layout(g, NOW, pxPerDay).lanes[0];
			expect(clusters.map((c) => [c.label, c.quiet, c.row])).toEqual([
				['ENG-1 · Reconnect after a network…', false, 0],
				['ENG-2 · Reconnect after a network…', false, 1]
			]);
		}
		expect(layout(g, NOW, 160).lanes[0].clusters[0].title).toBe('ENG-1 · Reconnect after a network change, working');
	});

	it('S-36 names six tickets in play started an hour apart as far as each has room', () => {
		const six = [9, 10, 11, 12, 13, 14].map((h, i) => titled(`ENG-${i + 1}`, `2026-10-08T${String(h).padStart(2, '0')}:00:00.000Z`, 'working'));
		const { clusters } = layout(graph([lane('a', six)]), NOW, 160).lanes[0];
		// all six are drawn on their own; the one that shares a row with the sixth has no room for a name
		expect(clusters.map((c) => c.nodes.length)).toEqual([1, 1, 1, 1, 1, 1]);
		expect(clusters.filter((c) => c.label?.includes('Reconnect'))).toHaveLength(5);
		expect(clusters.filter((c) => c.label === null).map((c) => c.title)).toEqual(['ENG-1 · Reconnect after a network change, working']);
	});

	it('S-36 names finished work only as far as there is room', () => {
		const days = (gap: number) =>
			graph([lane('a', [titled('ENG-1', '2026-10-08T09:00:00.000Z', 'done'), titled('ENG-2', new Date(Date.parse('2026-10-08T09:00:00.000Z') + gap * DAY).toISOString(), 'done')])]);
		const first = (gap: number) => layout(days(gap), NOW, 160).lanes[0].clusters[0];
		expect(first(0.2)).toMatchObject({ quiet: true, row: 0, label: null }); // 32px: no room
		expect(first(0.5)).toMatchObject({ label: 'ENG-1' }); // 80px: the id fits
		expect(first(1)).toMatchObject({ label: 'ENG-1 · Reconnect…' });
		expect(first(3)).toMatchObject({ label: 'ENG-1 · Reconnect after a network…' });
		// nothing follows the last one, so it has all the room it wants
		expect(layout(days(0.2), NOW, 160).lanes[0].clusters[1].label).toBe('ENG-2 · Reconnect after a network…');
	});

	it('S-36 does not repeat a session name that is its own label', () => {
		const session = { ...node('s1', '2026-10-09T09:00:00.000Z', 'working'), label: 'try-bun-runti…', title: 'try-bun-runtime', status: null };
		const [c] = layout(graph([lane('unsorted', [session], { kind: 'unsorted' })]), NOW, 160).lanes[0].clusters;
		expect(c.label).toBe('try-bun-runtime');
	});

	it('S-36 draws a session that ended without a ticket as history, even one that failed', () => {
		const ended = (id: string, state: 'open' | 'failed', gone: boolean) => ({
			...node(id, '2026-10-03T09:00:00.000Z', state),
			status: null,
			sessions: [{ id, name: id, cwd: '/r', kind: 'background' as const, startedAt: '2026-10-03T09:00:00.000Z', state, waitingFor: null, gone }]
		});
		const [box] = layout(graph([lane('unsorted', [ended('a', 'open', true), ended('b', 'failed', true), ended('c', 'failed', false)], { kind: 'unsorted' })]), NOW, 1600).lanes;
		expect(box.clusters.map((c) => [c.key, c.quiet])).toEqual([['a', true], ['b', true], ['c', false]]);
		// only the one Claude Code still lists counts as failed
		expect(box.status).toBe('1 failed');
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
			// the older milestone is finished, so it is folded and its line runs higher in its lane
			{ left: c.lineLeft - 28, top: t.y + LINE_Y, width: 28, height: 2 * LANE_H + FOLD_LINE_Y - LINE_Y }
		]);
		expect(view.connectors[1].top + view.connectors[1].height).toBe(c.y + c.lineY);
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
		expect(view.counts).toEqual({ needs: 0, working: 1, review: 0, failed: 0, open: 0 });
	});

	it('S-20 gives a trunk with no tickets of its own the extent of its milestones', () => {
		const empty = layout(graph([lane('p', [], { closed: true }), closed]), NOW, 160);
		expect(empty.lanes[0].lineLeft).toBe(empty.lanes[1].lineLeft - 28);
		expect(empty.lanes[0].lineRight).toBe(empty.lanes[1].lineRight);
	});
});

describe('folding', () => {
	const burst = hourly(6);
	const g = graph([lane('old', burst, { closed: true }), lane('live', [node('x', '2026-10-09T09:00:00.000Z', 'working')])]);

	it('S-16 draws a finished lane as a strip: one row, no names, less height', () => {
		const [old, live] = layout(g, NOW, 160).lanes;
		expect(old).toMatchObject({ folded: true, height: FOLD_H, lineY: FOLD_LINE_Y, status: 'finished · 6 tickets' });
		expect(old.clusters.every((c) => c.row === 0 && c.label === null)).toBe(true);
		expect(old.clusters.reduce((n, c) => n + c.nodes.length, 0)).toBe(6);
		expect(live).toMatchObject({ folded: false, y: AXIS_H + FOLD_H, lineY: LINE_Y });
	});

	it('S-16 keeps the small marks of a strip clear of each other at any zoom', () => {
		const done = busy(4, 60).map((n) => ({ ...n, state: 'done' as const }));
		for (const pxPerDay of ZOOMS) {
			const { clusters } = layout(graph([lane('old', done, { closed: true })]), NOW, pxPerDay).lanes[0];
			expect(clusters.reduce((n, c) => n + c.nodes.length, 0)).toBe(60);
			for (let i = 1; i < clusters.length; i++) expect(clusters[i].left, `${pxPerDay} px/day`).toBeGreaterThanOrEqual(clusters[i - 1].right + 2);
		}
	});

	it('S-16 draws it in full once it is unfolded', () => {
		const [old, live] = layout(g, NOW, 160, false, MAX_ROWS, new Set(['old'])).lanes;
		expect(old.folded).toBe(false);
		expect(Math.max(...old.clusters.map((c) => c.row))).toBeGreaterThan(0);
		expect(old.clusters.some((c) => c.label)).toBe(true);
		expect(live.y).toBe(AXIS_H + old.height);
	});

	it('S-16 never folds a lane with anything still open', () => {
		expect(layout(g, NOW, 160).lanes[1].folded).toBe(false);
		expect(layout(g, NOW, 160, false, MAX_ROWS, new Set(['live'])).lanes[1].folded).toBe(false);
	});
});

describe('jumping', () => {
	const g = graph([
		lane('a', [node('a1', '2026-10-08T09:00:00.000Z', 'needs'), node('a2', '2026-10-09T09:00:00.000Z', 'working')]),
		lane('b', [node('b1', '2026-10-07T09:00:00.000Z', 'needs')], { closed: false }),
		lane('c', [node('c1', '2026-10-06T09:00:00.000Z')], { closed: true })
	]);
	const view = layout(g, NOW, 160);

	it('S-15 goes through the tickets in a state from the top lane down, and wraps round', () => {
		expect(nextInState(view, 'needs', null)?.id).toBe('a1');
		expect(nextInState(view, 'needs', 'a1')?.id).toBe('b1');
		expect(nextInState(view, 'needs', 'b1')?.id).toBe('a1');
		// something else is open: start from the first
		expect(nextInState(view, 'needs', 'a2')?.id).toBe('a1');
		expect(nextInState(view, 'failed', null)).toBeNull();
	});

	it('S-15 counts work that is started and has nothing running on it', () => {
		const idle = graph([lane('a', [node('a1', '2026-10-02T09:00:00.000Z', 'open'), node('a2', '2026-10-09T09:00:00.000Z', 'done')])]);
		const v = layout(idle, NOW, 160);
		expect(v.counts.open).toBe(1);
		expect(nextInState(v, 'open', null)?.id).toBe('a1');
	});

	it('S-15 does not count a session that ended without a ticket as open work', () => {
		const ended = { ...node('session:s1', '2026-10-03T09:00:00.000Z', 'open'), status: null, sessions: [{ id: 's1', name: 'scratch', cwd: '/r', kind: 'interactive' as const, startedAt: '2026-10-03T09:00:00.000Z', state: 'open' as const, waitingFor: null, gone: true }] };
		const live = { ...ended, id: 'session:s2', sessions: [{ ...ended.sessions[0], id: 's2', gone: false }] };
		const v = layout(graph([lane('unsorted', [ended, live], { kind: 'unsorted' })]), NOW, 160);
		expect(v.counts.open).toBe(1);
		expect(nextInState(v, 'open', null)?.id).toBe('session:s2');
		expect(nextInState(v, 'open', 'session:s2')?.id).toBe('session:s2');
	});

	it('S-15 does not count a failed session that ended without a ticket either', () => {
		const failed = { ...node('session:s3', '2026-09-01T09:00:00.000Z', 'failed'), status: null, sessions: [{ id: 's3', name: 'old', cwd: '/r', kind: 'background' as const, startedAt: '2026-09-01T09:00:00.000Z', state: 'failed' as const, waitingFor: null, gone: true }] };
		const v = layout(graph([lane('a', [node('t1', '2026-10-09T09:00:00.000Z', 'failed')]), lane('unsorted', [failed], { kind: 'unsorted' })]), NOW, 160);
		expect(v.counts.failed).toBe(1);
		expect(nextInState(v, 'failed', 't1')?.id).toBe('t1');
	});

	it('S-15 skips lanes that are hidden', () => {
		expect(nextInState(view, 'done', null)?.id).toBe('c1');
		expect(nextInState(layout(g, NOW, 160, true), 'done', null)).toBeNull();
	});
});
