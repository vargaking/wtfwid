import { describe, expect, it } from 'vitest';
import { dayOf, minutesIn } from './days';
import { DAY } from './layout';
import type { GraphNode, Lane, Work } from './model';

const DAY0 = Date.parse('2026-10-08T00:00:00.000Z');
const min = (iso: string) => Date.parse(iso) / 60_000;
const work = (spans: [string, string][], costUSD: number | null = null): Work => {
	const s = spans.map(([a, b]): [number, number] => [min(a), min(b)]);
	return { minutes: s.reduce((n, [a, b]) => n + b - a, 0), sessions: 1, added: 0, removed: 0, tokens: 0, costUSD, spans: s, commits: [] };
};
const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id, label: id, title: id, url: null, at: '2026-10-01T09:00:00.000Z', state: 'open', stage: 'session', status: 'In Progress',
	startedAt: '2026-10-01T09:00:00.000Z', completedAt: null, sessions: [], prs: [], ...over
});
const lane = (nodes: GraphNode[]): Lane[] => [{ id: 'p', name: 'P', project: null, kind: 'project', parent: null, closed: false, nodes }];

describe('what happened on a day', () => {
	it('S-89: counts only the part of each stretch that falls in the day', () => {
		expect(minutesIn([[10, 20], [30, 50]], 15, 40)).toBe(15);
		expect(minutesIn([[10, 20]], 20, 30)).toBe(0);
		// work that ran over midnight belongs to both days, each its own part
		const late = node('A', { work: work([['2026-10-07T23:30:00Z', '2026-10-08T00:45:00Z']]) });
		expect(dayOf(lane([late]), DAY0).items).toEqual([{ node: late, minutes: 45, commits: 0, started: false, completed: false }]);
		expect(dayOf(lane([late]), DAY0 - DAY).minutes).toBe(30);
	});

	it('S-89: lists the tickets worked on, most first, then what was only started or completed that day', () => {
		const a = node('A', { work: work([['2026-10-08T09:00:00Z', '2026-10-08T09:40:00Z']]) });
		const b = node('B', { work: work([['2026-10-08T10:00:00Z', '2026-10-08T12:00:00Z']]), completedAt: '2026-10-08T12:05:00.000Z' });
		const c = node('C', { startedAt: '2026-10-08T15:00:00.000Z', at: '2026-10-08T15:00:00.000Z' });
		const elsewhere = node('D', { work: work([['2026-10-05T10:00:00Z', '2026-10-05T12:00:00Z']]) });
		const day = dayOf(lane([a, b, c, elsewhere]), DAY0);
		expect(day.items.map((i) => [i.node.id, i.minutes, i.started, i.completed])).toEqual([
			['B', 120, false, true],
			['A', 40, false, false],
			['C', 0, true, false]
		]);
		expect(day).toMatchObject({ from: DAY0, to: DAY0 + DAY, minutes: 160, busy: 160, costUSD: null });
	});

	it('S-89: sessions side by side each count as session time, once as time of the day', () => {
		const a = node('A', { work: work([['2026-10-08T09:00:00Z', '2026-10-08T10:00:00Z']]) });
		const b = node('B', { work: work([['2026-10-08T09:30:00Z', '2026-10-08T10:30:00Z']]) });
		expect(dayOf(lane([a, b]), DAY0)).toMatchObject({ minutes: 120, busy: 90 });
	});

	it('S-89: two sessions of one ticket side by side count the same way', () => {
		// both at 09:00 to 10:00, $4 and $6: two hours of session time in one hour of the day
		const s: [number, number] = [min('2026-10-08T09:00:00Z'), min('2026-10-08T10:00:00Z')];
		const both = node('A', { work: { minutes: 120, sessions: 2, added: 0, removed: 0, tokens: 0, costUSD: 10, spans: [s, [...s]], commits: [] } });
		const other = node('B', { work: work([['2026-10-08T09:00:00Z', '2026-10-08T10:00:00Z']], 5) });
		const day = dayOf(lane([both, other]), DAY0);
		expect(day.items.map((i) => [i.node.id, i.minutes])).toEqual([['A', 120], ['B', 60]]);
		expect(day).toMatchObject({ minutes: 180, busy: 60, costUSD: 15 });
	});

	it('S-89: a ticket\'s cost counts by the share of its work that fell in the day', () => {
		// two hours in all, one of them on this day
		const a = node('A', { work: work([['2026-10-07T09:00:00Z', '2026-10-07T10:00:00Z'], ['2026-10-08T09:00:00Z', '2026-10-08T10:00:00Z']], 10) });
		const b = node('B', { work: work([['2026-10-08T11:00:00Z', '2026-10-08T11:30:00Z']], 3) });
		const unknown = node('C', { work: work([['2026-10-08T12:00:00Z', '2026-10-08T12:30:00Z']]) });
		expect(dayOf(lane([a, b, unknown]), DAY0).costUSD).toBe(8);
	});

	it('S-90: work done in the cloud shows in a day by its commits', () => {
		const cloud = (id: string, at: string[]): GraphNode => node(id, { work: { minutes: 0, sessions: 0, added: 0, removed: 0, tokens: 0, costUSD: null, spans: [], commits: at.map(min), lines: { added: 10, removed: 2 } } });
		const a = cloud('A', ['2026-10-07T23:50:00Z', '2026-10-08T09:00:00Z', '2026-10-08T09:40:00Z', '2026-10-08T23:59:00Z']);
		const b = cloud('B', ['2026-10-08T12:00:00Z']);
		const other = cloud('C', ['2026-10-09T00:00:00Z']);
		const local = node('D', { work: work([['2026-10-08T10:00:00Z', '2026-10-08T10:20:00Z']]) });
		const day = dayOf(lane([a, b, other, local]), DAY0);
		// session time first, then commits
		expect(day.items.map((i) => [i.node.id, i.minutes, i.commits])).toEqual([['D', 20, 0], ['A', 0, 3], ['B', 0, 1]]);
		expect(day).toMatchObject({ minutes: 20, commits: 4 });
	});

	it('S-89: a week is the same question over seven days; a day with nothing is empty', () => {
		const a = node('A', { work: work([['2026-10-08T09:00:00Z', '2026-10-08T10:00:00Z'], ['2026-10-12T09:00:00Z', '2026-10-12T09:30:00Z']]) });
		expect(dayOf(lane([a]), DAY0, DAY0 + 7 * DAY).minutes).toBe(90);
		expect(dayOf(lane([a]), DAY0 + 2 * DAY)).toMatchObject({ minutes: 0, busy: 0, commits: 0, costUSD: null, items: [] });
	});
});
