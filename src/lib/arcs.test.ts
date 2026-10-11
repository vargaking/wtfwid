import { describe, expect, it } from 'vitest';
import { arcs } from './arcs';
import { buildGraph } from './graph';
import { layout } from './layout';
import type { Issue, Snapshot } from './model';

const issue = (n: number, startedAt: string, milestone: string | null = null): Issue => ({
	id: `ENG-${n}`,
	title: `Ticket ${n}`,
	url: '',
	createdAt: startedAt,
	startedAt,
	completedAt: null,
	canceledAt: null,
	stateName: 'In Progress',
	stateType: 'started',
	branchName: `eng-${n}`,
	project: { id: 'web', name: 'Web' },
	milestone: milestone ? { id: milestone, name: milestone } : null
});
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const view = (issues: Issue[], hideFinished = false) => {
	const snap: Snapshot = { fetchedAt: new Date(NOW).toISOString(), demo: false, warnings: [], issues, prs: [], sessions: [] };
	return layout(buildGraph(snap), NOW, 160, hideFinished);
};
const points = (d: string) => d.match(/-?[\d.]+/g)!.map(Number);

describe('lines between related tickets', () => {
	it('S-86: a line runs between the two marks and stops short of both', () => {
		const v = view([issue(1, '2026-10-10T09:00:00.000Z'), issue(2, '2026-10-11T09:00:00.000Z')]);
		const [a, b] = v.lanes[0].clusters;
		const [arc] = arcs(v, [{ a: 'ENG-1', b: 'ENG-2', continued: true, weight: 0 }]);
		const [sx, sy, cx, cy, ex, ey] = points(arc.d);
		const y = v.lanes[0].y + v.lanes[0].lineY;
		// side by side: it bows upwards, and starts and ends a little away from the marks
		expect(cy).toBeLessThan(y);
		expect(cx).toBeCloseTo((a.markX + b.markX) / 2, 0);
		expect(Math.hypot(sx - a.markX, sy - y)).toBeCloseTo(13, 0);
		expect(Math.hypot(ex - b.markX, ey - y)).toBeCloseTo(13, 0);
		expect(sx).toBeGreaterThan(a.markX);
		expect(ex).toBeLessThan(b.markX);
		expect(arc).toMatchObject({ key: 'ENG-1>ENG-2', continued: true });
	});

	it('S-86: between tickets above each other it bows to the left, away from their names', () => {
		const v = view([issue(1, '2026-10-10T09:00:00.000Z'), issue(2, '2026-10-10T09:00:00.000Z', 'voice')]);
		const [arc] = arcs(v, [{ a: 'ENG-1', b: 'ENG-2', continued: false, weight: 2 }]);
		const [, , cx] = points(arc.d);
		expect(cx).toBeLessThan(v.lanes[0].clusters[0].markX);
		expect(arc.continued).toBe(false);
	});

	it('S-86: on the top line it bows downwards, so it does not go behind the dates', () => {
		// far apart on the first row of the first line: a bow upwards would rise above the axis
		const v = view([issue(1, '2026-10-02T09:00:00.000Z'), issue(2, '2026-10-18T09:00:00.000Z')]);
		const y = v.lanes[0].y + v.lanes[0].lineY;
		const [arc] = arcs(v, [{ a: 'ENG-1', b: 'ENG-2', continued: false, weight: 1 }]);
		expect(points(arc.d)[3]).toBeGreaterThan(y);
	});

	it('S-86: a ticket that is not on the timeline, or in the same cluster, gets no line', () => {
		const v = view([issue(1, '2026-10-10T09:00:00.000Z'), issue(2, '2026-10-14T09:00:00.000Z')]);
		expect(arcs(v, [{ a: 'ENG-1', b: 'ENG-9', continued: false, weight: 1 }])).toEqual([]);
		expect(arcs(v, [{ a: 'ENG-1', b: 'ENG-1', continued: false, weight: 1 }])).toEqual([]);
		expect(arcs(v, [])).toEqual([]);
	});

	it('S-86: a stronger relation is a thicker line, within limits', () => {
		const v = view([issue(1, '2026-10-10T09:00:00.000Z'), issue(2, '2026-10-14T09:00:00.000Z')]);
		const width = (weight: number) => arcs(v, [{ a: 'ENG-1', b: 'ENG-2', continued: false, weight }])[0].width;
		expect(width(0.5)).toBeLessThan(width(2));
		expect(width(1)).toBe(1.5);
		expect(width(50)).toBe(3);
	});
});
