import { describe, expect, it } from 'vitest';
import { DAY, dayLabel, layout, xOf } from './layout';
import type { Graph, GraphNode, Lane, NodeState, Session } from './model';
import { BAR_MAX, BAR_MIN, LEFT, RIGHT, WINDOW_MIN, keyTarget, overview, scrollFor, toStrip, toTimeline, windowAt, windowText } from './overview';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const HOUR = DAY / 24;

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
const iso = (t: number) => new Date(t).toISOString();

/** `count` tickets within the same half hour, starting at `at`. */
const burst = (name: string, at: string, count: number, state: NodeState = 'done') =>
	Array.from({ length: count }, (_, i) => node(`${name}${i}`, iso(Date.parse(at) + i * 60_000), state));

/** A repeatable stand-in for chance. */
function chance(seed: number) {
	return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const STATES: NodeState[] = ['done', 'done', 'done', 'working', 'needs', 'open', 'review', 'failed'];
/** History the way it really looks: bursts within the hour, quiet days, every state. */
function busy(seed: number, count: number, days: number): GraphNode[] {
	const next = chance(seed);
	const times = Array.from({ length: count }, () => NOW - next() * next() * days * DAY).sort((a, b) => a - b);
	return times.map((t, i) => node(`ENG-${i + 1}`, iso(t), STATES[Math.floor(next() * STATES.length)]));
}

/** Where a time is on a strip, worked out here the plain way: start of time at LEFT, now at width - RIGHT. */
const stripX = (t: number, t0: number, width: number) => LEFT + ((t - t0) / (NOW - t0)) * (width - LEFT - RIGHT);

describe('overview strip: bars', () => {
	it('S-80: tickets started in the same stretch of time make one bar, and a bar stands where its time is', () => {
		const g = graph([
			lane('a', [node('n1', '2026-10-05T09:10:00.000Z'), node('n2', '2026-10-05T09:40:00.000Z'), node('n3', '2026-10-07T15:00:00.000Z')]),
			lane('b', [node('m1', '2026-10-05T09:20:00.000Z')])
		]);
		const view = layout(g, NOW, 160);
		const o = overview(view, 1000);
		// six and a half days on 952 pixels: a bar is an hour
		expect(o.bucket).toBe(HOUR);
		expect(o.bars.map((b) => b.count)).toEqual([3, 1]);
		const [first, second] = o.bars;
		expect(first.x).toBe(Math.round(stripX(Date.parse('2026-10-05T09:00:00.000Z'), view.t0, 1000)));
		expect(second.x).toBe(Math.round(stripX(Date.parse('2026-10-07T15:00:00.000Z'), view.t0, 1000)));
		expect(first.title).toBe('Mon 5 Oct 09:00 to 10:00 · 3 started, all finished');
		expect(second.title).toBe('Wed 7 Oct 15:00 to 16:00 · 1 started, finished');
	});

	it('S-80: every ticket is in exactly one bar, bars do not touch, and none is outside the strip', () => {
		for (const [days, width] of [[9, 1120], [22, 1120], [22, 580], [200, 1120], [900, 700]] as const) {
			const nodes = busy(days, 250, days);
			const view = layout(graph([lane('a', nodes)]), NOW, 160);
			const o = overview(view, width);
			expect(o.bars.reduce((sum, b) => sum + b.count, 0)).toBe(250);
			for (const n of nodes) {
				const sx = stripX(Date.parse(n.at), view.t0, width);
				// a pixel either way: bar edges sit on whole pixels
				expect(o.bars.filter((b) => sx >= b.x - 1 && sx <= b.x + b.w + 2).length).toBeGreaterThanOrEqual(1);
			}
			o.bars.forEach((b, i) => {
				expect(b.w).toBeGreaterThanOrEqual(2);
				expect(b.x).toBeGreaterThanOrEqual(LEFT);
				// the bar that holds this moment stops at now, and is still wide enough to see
				expect(b.x + b.w).toBeLessThanOrEqual(o.nowX + 2);
				if (i) expect(b.x).toBeGreaterThan(o.bars[i - 1].x + o.bars[i - 1].w);
			});
		}
	});

	it('S-80: a single ticket stays visible next to a burst of twenty', () => {
		const g = graph([
			lane('a', [...burst('five', '2026-10-05T09:00:00.000Z', 5), ...burst('twenty', '2026-10-06T09:00:00.000Z', 20), node('one', '2026-10-07T09:00:00.000Z')])
		]);
		const [five, twenty, one] = overview(layout(g, NOW, 160), 1000).bars;
		expect([five.count, twenty.count, one.count]).toEqual([5, 20, 1]);
		expect(twenty.h).toBe(BAR_MAX);
		// square root: a quarter of the tickets is half the height
		expect(five.h).toBe(BAR_MAX / 2);
		expect(one.h).toBeGreaterThanOrEqual(BAR_MIN);
		expect(one.h).toBeLessThan(five.h);
	});

	it('S-80: a few tickets on their own do not fill the strip to the top', () => {
		const [one] = overview(layout(graph([lane('a', [node('one', '2026-10-07T09:00:00.000Z')])]), NOW, 160), 1000).bars;
		expect(one.h).toBeLessThan(BAR_MAX);
	});

	it('S-80: a bar with unfinished work takes the colour of the most urgent of it; finished work has none', () => {
		const g = graph([
			lane('a', [
				...burst('d', '2026-10-05T09:00:00.000Z', 3),
				node('o', '2026-10-05T09:10:00.000Z', 'open'),
				node('n', '2026-10-05T09:11:00.000Z', 'needs'),
				...burst('e', '2026-10-06T09:00:00.000Z', 3),
				node('r', '2026-10-07T09:00:00.000Z', 'review'),
				node('w', '2026-10-07T09:10:00.000Z', 'working'),
				node('f', '2026-10-08T09:00:00.000Z'),
				node('p', '2026-10-08T09:10:00.000Z', 'open')
			])
		]);
		const [mixed, finished, live, pair] = overview(layout(g, NOW, 160), 1000).bars;
		expect([mixed.state, mixed.count, mixed.unfinished]).toEqual(['needs', 5, 2]);
		expect([finished.state, finished.live, finished.unfinished]).toEqual([null, 0, 0]);
		// nothing finished in it: the whole bar is in the colour
		expect([live.state, live.live]).toEqual(['working', live.h]);
		// "done" is never the colour while something in the bar is not
		expect(pair.state).toBe('open');
		expect(mixed.title).toBe('Mon 5 Oct 09:00 to 10:00 · 5 started, 2 not finished');
		expect(live.title).toBe('Wed 7 Oct 09:00 to 10:00 · 2 started, none finished');
	});

	it('S-80: one loose end among many finished tickets is still a clear part of the bar, and never all of it', () => {
		for (const done of [1, 2, 9, 40, 400]) {
			const g = graph([lane('a', [...burst('d', '2026-10-05T09:00:00.000Z', done), node('o', '2026-10-05T09:29:00.000Z', 'failed')])]);
			const [bar] = overview(layout(g, NOW, 160), 1000).bars;
			expect(bar.state).toBe('failed');
			expect(bar.live).toBeGreaterThanOrEqual(BAR_MIN);
			expect(bar.live).toBeGreaterThanOrEqual(bar.h / 2 - 1);
			expect(bar.h - bar.live).toBeGreaterThanOrEqual(2);
			expect(bar.h).toBeLessThanOrEqual(BAR_MAX);
		}
	});

	it('S-80: a session that ended without a ticket is history, whatever state it ended in', () => {
		const gone: Session = { id: 's', name: 'try', cwd: '/x', kind: 'interactive', startedAt: '2026-10-05T09:00:00.000Z', state: 'failed', waitingFor: null, gone: true };
		const ended: GraphNode = { ...node('s', '2026-10-05T09:00:00.000Z', 'failed'), status: null, stage: 'session', sessions: [gone] };
		const [bar] = overview(layout(graph([lane('u', [ended], { kind: 'unsorted' })]), NOW, 160), 1000).bars;
		expect([bar.count, bar.state, bar.live]).toEqual([1, null, 0]);
	});

	it('S-80: an empty timeline gives a strip with no bars, and nothing that is not a number', () => {
		const view = layout(graph([]), NOW, 160);
		const o = overview(view, 1000);
		expect(o.bars).toEqual([]);
		expect(o.nowX).toBe(1000 - RIGHT);
		expect(o.labels.length).toBeGreaterThan(0);
		expect([o.from, o.k, o.bucket].every(Number.isFinite)).toBe(true);
		const win = windowAt(o, 1000, 0, 800);
		expect(Number.isFinite(win.x) && Number.isFinite(win.w)).toBe(true);
	});

	it('S-80: a strip that has not been measured yet draws nothing', () => {
		const view = layout(graph([lane('a', busy(3, 40, 20))]), NOW, 160);
		for (const width of [0, 20, LEFT + RIGHT]) {
			const o = overview(view, width);
			expect(o.bars).toEqual([]);
			expect(o.labels).toEqual([]);
			expect(Number.isFinite(o.k)).toBe(true);
		}
		expect(windowAt(overview(view, 0), 0, 500, 800)).toEqual({ x: 0, w: 0 });
	});

	it('S-80: a single ticket is one bar between the start and now', () => {
		const o = overview(layout(graph([lane('a', [node('n1', '2026-10-08T09:00:00.000Z', 'open')])]), NOW, 160), 1000);
		expect(o.bars).toHaveLength(1);
		const [bar] = o.bars;
		expect([bar.count, bar.state, bar.live]).toEqual([1, 'open', bar.h]);
		expect(bar.h).toBeGreaterThanOrEqual(BAR_MIN);
		expect(bar.x).toBeGreaterThan(LEFT);
		expect(bar.x + bar.w).toBeLessThan(o.nowX);
		expect(bar.title).toBe('Thu 8 Oct 09:00 to 10:00 · 1 started, not finished');
	});

	it('S-80: a narrower strip has longer stretches of time per bar, and still every ticket', () => {
		const nodes = busy(11, 250, 22);
		const view = layout(graph([lane('a', nodes)]), NOW, 160);
		let before = 0;
		for (const width of [2400, 1120, 580, 300, 120]) {
			const o = overview(view, width);
			expect(o.width).toBe(width);
			expect(o.nowX).toBe(width - RIGHT);
			expect(o.bucket).toBeGreaterThanOrEqual(before);
			before = o.bucket;
			expect(o.bars.reduce((sum, b) => sum + b.count, 0)).toBe(250);
			// a bar and the gap after it are never thinner than six pixels
			expect((o.bucket / (NOW - view.t0)) * (width - LEFT - RIGHT)).toBeGreaterThanOrEqual(6);
		}
		expect(before).toBeGreaterThan(overview(view, 2400).bucket);
	});

	it('S-80: years of history still fit: a bar is then some whole weeks', () => {
		const view = layout(graph([lane('a', busy(5, 250, 3000))]), NOW, 160);
		const o = overview(view, 600);
		expect(o.bucket % (7 * DAY)).toBe(0);
		expect(o.bars.reduce((sum, b) => sum + b.count, 0)).toBe(250);
		expect(o.bars[0].title).toMatch(/^\w{3} \d+ \w{3} to \w{3} \d+ \w{3} · /);
	});

	it('S-80: zooming the timeline does not move the bars', () => {
		const g = graph([lane('a', busy(7, 120, 22)), lane('b', busy(8, 60, 15))]);
		const at = (pxPerDay: number) => overview(layout(g, NOW, pxPerDay), 1120);
		expect(at(12).bars).toEqual(at(160).bars);
		expect(at(1600).bars).toEqual(at(160).bars);
		expect(at(1600).labels).toEqual(at(160).labels);
	});

	it('S-80: with "Hide finished" on, the hidden lines do not count', () => {
		const g = graph([
			lane('open', [node('a1', '2026-10-05T09:00:00.000Z'), node('a2', '2026-10-08T09:00:00.000Z', 'working')]),
			lane('closed', burst('c', '2026-10-05T09:00:00.000Z', 6), { closed: true })
		]);
		const all = overview(layout(g, NOW, 160), 1000);
		const shown = overview(layout(g, NOW, 160, true), 1000);
		expect(all.bars.map((b) => b.count)).toEqual([7, 1]);
		expect(shown.bars.map((b) => b.count)).toEqual([1, 1]);
		// the strip still covers the same time: what is left stays where it was
		expect(shown.bars.map((b) => b.x)).toEqual(all.bars.map((b) => b.x));
	});
});

describe('overview strip: date labels', () => {
	const span = (days: number, width = 1120) => overview(layout(graph([lane('a', [node('n1', iso(NOW - days * DAY))])]), NOW, 160), width);

	it('S-80: a short history has a label for every day, in the words the axis uses', () => {
		const o = span(5);
		expect(o.labels.map((l) => l.text)).toEqual(['Sun 4 Oct', 'Mon 5 Oct', 'Tue 6 Oct', 'Wed 7 Oct', 'Thu 8 Oct', 'Fri 9 Oct', 'Sat 10 Oct']);
		expect(o.labels[0].x).toBe(LEFT);
	});

	it('S-80: a few weeks have a label on each Monday', () => {
		const o = span(22);
		expect(o.labels.map((l) => l.text)).toEqual(['Mon 21 Sep', 'Mon 28 Sep', 'Mon 5 Oct']);
	});

	it('S-80: months of history are labelled by month, with the year at its turn', () => {
		expect(span(200).labels.map((l) => l.text)).toEqual(['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
		expect(span(330).labels.map((l) => l.text)).toEqual(['Dec', 'Jan 2026', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
	});

	it('S-80: many years are labelled by year', () => {
		expect(span(2000).labels.map((l) => l.text)).toEqual(['2022', '2023', '2024', '2025', '2026']);
	});

	it('S-80: labels never run into each other or into "now"', () => {
		for (const days of [1, 3, 8, 12, 13, 30, 80, 100, 400, 700, 5000]) {
			for (const width of [200, 580, 1120, 2400]) {
				const o = span(days, width);
				let free = 0;
				for (const l of o.labels) {
					expect(l.x).toBeGreaterThanOrEqual(free);
					free = l.x + 5 + l.text.length * 6;
				}
				expect(free).toBeLessThanOrEqual(o.nowX);
			}
		}
	});
});

describe('overview strip: where you are, and going somewhere', () => {
	const g = graph([lane('a', busy(21, 250, 22))]);

	it('S-80: strip and timeline map onto each other, start to start and now to now', () => {
		for (const pxPerDay of [12, 160, 1600]) {
			const view = layout(g, NOW, pxPerDay);
			const o = overview(view, 1120);
			expect(toStrip(xOf(view.t0, view.t0, pxPerDay), o)).toBe(LEFT);
			expect(toStrip(view.nowX, o)).toBeCloseTo(o.nowX, 6);
			expect(toTimeline(o.nowX, o)).toBeCloseTo(view.nowX, 6);
			for (const x of [0, 333.3, view.nowX / 2, view.width]) expect(toTimeline(toStrip(x, o), o)).toBeCloseTo(x, 6);
		}
	});

	it('S-80: a ticket is at the same place on the strip as its bar', () => {
		const view = layout(g, NOW, 160);
		const o = overview(view, 1120);
		for (const box of view.lanes) {
			for (const c of box.clusters.filter((c) => c.nodes.length === 1)) {
				const sx = toStrip(c.x, o);
				expect(o.bars.some((b) => sx >= b.x - 1 && sx <= b.x + b.w + 2)).toBe(true);
			}
		}
	});

	it('S-80: the window follows scrolling and zooming', () => {
		const view = layout(g, NOW, 160);
		const o = overview(view, 1120);
		const a = windowAt(o, 1120, 1000, 900);
		const b = windowAt(o, 1120, 1400, 900);
		expect(a.x).toBeCloseTo(toStrip(1000, o), 6);
		expect(a.w).toBeCloseTo(900 * o.k, 6);
		expect(b.x).toBeGreaterThan(a.x);
		expect(b.w).toBeCloseTo(a.w, 6);
		// zoomed in, the same window shows less time
		const zoomed = overview(layout(g, NOW, 480), 1120);
		expect(windowAt(zoomed, 1120, 3000, 900).w).toBeCloseTo(a.w / 3, 1);
	});

	it('S-80: zoomed far in, the window keeps a width that can be seen, around the time shown', () => {
		const view = layout(g, NOW, 1600);
		const o = overview(view, 580);
		const scroll = 20_000;
		const win = windowAt(o, 580, scroll, 600);
		expect(600 * o.k).toBeLessThan(WINDOW_MIN);
		expect(win.w).toBe(WINDOW_MIN);
		expect(win.x + win.w / 2).toBeCloseTo(toStrip(scroll + 300, o), 6);
	});

	it('S-80: the window never leaves the strip', () => {
		for (const pxPerDay of [12, 160, 1600]) {
			const view = layout(g, NOW, pxPerDay);
			for (const width of [300, 580, 1120]) {
				const o = overview(view, width);
				for (const clientWidth of [400, 900, 3000]) {
					for (const scroll of [0, 40, view.nowX - clientWidth + 180, Math.max(0, view.width - clientWidth), view.width]) {
						const win = windowAt(o, width, scroll, clientWidth);
						expect(win.x).toBeGreaterThanOrEqual(0);
						expect(win.x + win.w).toBeLessThanOrEqual(width + 1e-9);
						expect(win.w).toBeGreaterThanOrEqual(WINDOW_MIN);
					}
				}
			}
		}
	});

	it('S-80: when the whole timeline fits in its window, the window covers the whole strip', () => {
		const view = layout(g, NOW, 12);
		expect(view.width).toBeLessThan(1200);
		expect(windowAt(overview(view, 1120), 1120, 0, 1200)).toEqual({ x: 0, w: 1120 });
	});

	it('S-80: clicking the strip brings that time to the middle of the timeline', () => {
		const view = layout(g, NOW, 160);
		const o = overview(view, 1120);
		for (const sx of [200, 560.5, 900]) {
			const scroll = scrollFor(sx, o, 900);
			expect(scroll + 450).toBeCloseTo(toTimeline(sx, o), 6);
			const win = windowAt(o, 1120, scroll, 900);
			expect(win.x + win.w / 2).toBeCloseTo(sx, 6);
		}
		// on a ticket's bar, the ticket comes to the middle, give or take the bar's width
		const c = view.lanes[0].clusters[40];
		const bar = o.bars.find((b) => toStrip(c.x, o) >= b.x - 1 && toStrip(c.x, o) <= b.x + b.w + 2)!;
		expect(Math.abs(scrollFor(bar.x + bar.w / 2, o, 900) + 450 - c.x)).toBeLessThan((bar.w + 3) / o.k);
	});

	it('S-80: arrow keys pan by a step, Page Up and Page Down by nearly a screenful, Home goes to the start, End to now', () => {
		expect(keyTarget('ArrowRight', 1000, 800)).toBe(1100);
		expect(keyTarget('ArrowLeft', 1000, 800)).toBe(900);
		expect(keyTarget('PageDown', 1000, 800)).toBe(1720);
		expect(keyTarget('PageUp', 1000, 800)).toBe(280);
		expect(keyTarget('Home', 1000, 800)).toBe(0);
		expect(keyTarget('End', 1000, 800)).toBe('now');
		// never before the start; a narrow window still moves by something
		expect(keyTarget('ArrowLeft', 30, 800)).toBe(0);
		expect(keyTarget('PageUp', 30, 800)).toBe(0);
		expect(keyTarget('ArrowRight', 0, 200)).toBe(40);
		// keys it has no use for are left alone
		for (const key of ['ArrowUp', 'ArrowDown', 'Tab', 'Escape', 'a', ' ']) expect(keyTarget(key, 1000, 800)).toBeNull();
	});

	it('S-80: it says in words which days the timeline is showing', () => {
		const view = layout(g, NOW, 160);
		const x = (isoTime: string) => xOf(Date.parse(isoTime), view.t0, 160);
		const left = x('2026-10-05T06:00:00.000Z');
		expect(windowText(view, left, x('2026-10-07T18:00:00.000Z') - left)).toBe('Mon 5 Oct to Wed 7 Oct');
		expect(windowText(view, left, 80)).toBe('Mon 5 Oct');
		// the room past now is not a day of its own
		expect(windowText(view, view.nowX - 20, 600)).toBe(dayLabel(NOW));
		expect(windowText(view, 0, 60)).toBe(dayLabel(view.t0));
	});
});
