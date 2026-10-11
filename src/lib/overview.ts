import { DAY, dayLabel, quiet, xOf, type Layout } from './layout';
import { mostUrgent, type NodeState } from './model';

// The overview strip under the timeline (S-80): the whole time range squeezed into the
// strip's width, with a bar for how much started when, and a window for the part of time
// the timeline is showing. Everything here is plain arithmetic; Overview.svelte draws it.

/** Height of the strip, without the line above it. */
export const STRIP_H = 47;
/** The date labels have the top of the strip to themselves; the bars and the window start under them. */
export const LABEL_H = 16;
/** Where the bars stand, from the top of the strip, and how tall the tallest one is. */
export const BASE_Y = 44;
export const BAR_MAX = 26;
/** One ticket is at least this tall, so it can be seen next to a burst. */
export const BAR_MIN = 4;
/** Room left of the first day, and right of "now" for its label. */
export const LEFT = 8;
export const RIGHT = 40;
/** A bar and the gap after it are at least this wide. */
const SLOT = 6;
/** With fewer tickets than this in the fullest bar, bars still do not reach full height. */
const TOP_FLOOR = 4;
/** The window is drawn at least this wide, so it can be seen and taken hold of when zoomed far in. */
export const WINDOW_MIN = 14;
/** Width of one character of a date label (10px IBM Plex Mono), and the air before it. */
const CHAR_W = 6;
const TEXT_GAP = 5;
/** A day gets its own label when it is this wide, a week when it is; a month needs less, its name is short. */
const DATE_W = 84;
const MONTH_W = 44;

const HOUR = DAY / 24;
/** How long a bar's bucket of time can be: parts of a day that divide it evenly, then whole days. */
const BUCKETS = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 24, 48, 7 * 24, 14 * 24, 28 * 24].map((h) => h * HOUR);

export interface Bar {
	x: number;
	w: number;
	/** Height of the whole bar: every ticket started in its bucket of time. */
	h: number;
	/**
	 * Height of the part, from the bottom, that is drawn in the colour of unfinished work. 0 when
	 * all are finished, the whole bar when none are; in between, their share of it and never
	 * less than half, so that one loose end among many finished tickets is still seen.
	 */
	live: number;
	/** The most urgent state among the unfinished ones, null when all are finished. */
	state: NodeState | null;
	count: number;
	unfinished: number;
	/** When, and how many: the tooltip. */
	title: string;
}

export interface DateLabel {
	x: number;
	text: string;
}

/** How strip x and timeline x relate: timeline x `from` sits at strip x `LEFT`, and one timeline pixel is `k` strip pixels. */
export interface Scale {
	from: number;
	k: number;
}

export interface Overview extends Scale {
	width: number;
	bars: Bar[];
	nowX: number;
	labels: DateLabel[];
	/** Length of one bar's bucket of time, in milliseconds. */
	bucket: number;
}

export function toStrip(x: number, scale: Scale): number {
	return LEFT + (x - scale.from) * scale.k;
}

export function toTimeline(sx: number, scale: Scale): number {
	return scale.from + (sx - LEFT) / scale.k;
}

/** The timeline x of the start of time; the timeline keeps some room before it. */
const startX = (view: Layout) => xOf(view.t0, view.t0, 1);

/** The time at a timeline x. Uses only the layout, so it needs no zoom. */
function timeAt(view: Layout, x: number): number {
	const from = startX(view);
	return view.t0 + ((x - from) / Math.max(1, view.nowX - from)) * (view.now - view.t0);
}

const two = (n: number) => String(n).padStart(2, '0');
const clock = (t: number) => `${two(new Date(t).getHours())}:${two(new Date(t).getMinutes())}`;

/** The stretch of time a bar stands for, in words. */
function when(t: number, bucket: number): string {
	if (bucket < DAY) return `${dayLabel(t)} ${clock(t)} to ${clock(t + bucket)}`;
	if (bucket === DAY) return dayLabel(t);
	// t + bucket is the first moment of the next bar; step back into this one's last day
	return `${dayLabel(t)} to ${dayLabel(t + bucket - DAY / 2)}`;
}

/**
 * A few date labels, so the strip can be read without the axis above it: every day when
 * days are wide, Mondays when weeks are, else the first of each month, else each new year.
 * A label that would run into the one before it, or into "now", is left out.
 */
function dateLabels(t0: number, now: number, perDay: number, nowX: number): DateLabel[] {
	const every = perDay >= DATE_W ? 'day' : perDay * 7 >= DATE_W ? 'week' : perDay * 28 >= MONTH_W ? 'month' : 'year';
	const labels: DateLabel[] = [];
	let free = 0;
	// t0 is a midnight, give or take the hour a clock change moves it
	const d = new Date(t0 + DAY / 2);
	d.setHours(0, 0, 0, 0);
	for (; d.getTime() <= now; d.setDate(d.getDate() + 1)) {
		const first = d.getDate() === 1;
		const wanted = { day: true, week: d.getDay() === 1, month: first, year: first && d.getMonth() === 0 }[every];
		if (!wanted) continue;
		const t = d.getTime();
		const month = dayLabel(t).split(' ')[2];
		const text =
			every === 'year' ? String(d.getFullYear()) : every === 'month' ? (d.getMonth() === 0 ? `${month} ${d.getFullYear()}` : month) : dayLabel(t);
		const x = Math.round(LEFT + ((t - t0) / DAY) * perDay);
		const end = x + TEXT_GAP + text.length * CHAR_W;
		if (x < free || end > nowX - TEXT_GAP) continue;
		labels.push({ x, text });
		free = end + 2 * TEXT_GAP;
	}
	return labels;
}

/**
 * The strip for a timeline, `width` pixels wide. It is made from the layout the timeline
 * draws, so it counts exactly the lines that are shown (with "Hide finished" on, the hidden
 * ones are not in it). It depends on time and width only: zooming and scrolling the
 * timeline move the window over it, not the bars.
 */
export function overview(view: Layout, width: number): Overview {
	const from = startX(view);
	const span = Math.max(1, width - LEFT - RIGHT);
	const k = span / Math.max(1, view.nowX - from);
	const nowX = LEFT + span;
	const days = Math.max(view.now - view.t0, HOUR) / DAY;
	const perDay = span / days;
	// the shortest bucket that still gives a bar its width; past the list, whole months of four weeks
	const bucket = BUCKETS.find((b) => (b / DAY) * perDay >= SLOT) ?? Math.ceil(SLOT / perDay / 28) * 28 * DAY;
	const empty: Overview = { from, k, width, bars: [], nowX, labels: [], bucket };
	// no room to draw anything yet: the strip has not been measured
	if (width <= LEFT + RIGHT) return empty;

	const buckets = new Map<number, { count: number; live: NodeState[] }>();
	for (const box of view.lanes) {
		for (const node of box.lane.nodes) {
			const i = Math.floor((Date.parse(node.at) - view.t0) / bucket);
			const b = buckets.get(i) ?? { count: 0, live: [] };
			b.count++;
			// S-36: finished work, and sessions that ended without a ticket, are history
			if (!quiet(node)) b.live.push(node.state);
			buckets.set(i, b);
		}
	}

	const top = Math.max(TOP_FLOOR, ...[...buckets.values()].map((b) => b.count));
	const edge = (i: number) => Math.round(LEFT + ((i * bucket) / DAY) * perDay);
	const bars = [...buckets.entries()]
		.sort(([a], [b]) => a - b)
		.map(([i, b]): Bar => {
			const unfinished = b.live.length;
			// square root: one ticket stays visible next to twenty
			let h = Math.max(BAR_MIN, Math.round(BAR_MAX * Math.sqrt(b.count / top)));
			let live = unfinished ? Math.max(Math.round((h * unfinished) / b.count), Math.ceil(h / 2)) : 0;
			// a bar that holds both kinds always shows both
			if (unfinished && unfinished < b.count) {
				h = Math.max(h, BAR_MIN + 2);
				live = Math.min(Math.max(live, BAR_MIN), h - 2);
			}
			const x = edge(i);
			// one pixel of air before the next bar; the bar that holds this moment stops at "now"
			const end = view.t0 + i * bucket <= view.now ? Math.min(edge(i + 1) - 1, nowX) : edge(i + 1) - 1;
			const one = b.count === 1;
			const text = !unfinished ? (one ? 'finished' : 'all finished') : unfinished < b.count ? `${unfinished} not finished` : one ? 'not finished' : 'none finished';
			return {
				x,
				w: Math.max(2, end - x),
				h,
				live,
				state: unfinished ? mostUrgent(b.live) : null,
				count: b.count,
				unfinished,
				title: `${when(view.t0 + i * bucket, bucket)} · ${b.count} started, ${text}`
			};
		});

	return { ...empty, bars, labels: dateLabels(view.t0, view.now, perDay, nowX) };
}

/**
 * The window: the part of the strip the timeline is showing, from its scroll position and
 * width. It stays inside the strip (the timeline has room past "now" that the strip does
 * not), and it is never narrower than WINDOW_MIN.
 */
export function windowAt(scale: Scale, width: number, scrollLeft: number, clientWidth: number): { x: number; w: number } {
	const inside = (sx: number) => Math.min(Math.max(sx, 0), Math.max(0, width));
	const left = inside(toStrip(scrollLeft, scale));
	const right = inside(toStrip(scrollLeft + clientWidth, scale));
	const min = Math.min(WINDOW_MIN, Math.max(0, width));
	if (right - left >= min) return { x: left, w: right - left };
	const middle = Math.min(Math.max((left + right) / 2, min / 2), Math.max(min / 2, width - min / 2));
	return { x: middle - min / 2, w: min };
}

/** Where the timeline scrolls to so that the time at strip x `sx` is in its middle. */
export function scrollFor(sx: number, scale: Scale, clientWidth: number): number {
	return toTimeline(sx, scale) - clientWidth / 2;
}

/**
 * What a key pressed on the strip does: the scroll position to go to, 'now' for where the
 * view opens, or null for a key the strip does not use. Arrows pan by a step, Page Up and
 * Page Down by nearly a screenful (a little stays in view to keep your place), Home goes to
 * the start, End to now.
 */
export function keyTarget(key: string, scrollLeft: number, clientWidth: number): number | 'now' | null {
	const step = Math.max(40, clientWidth / 8);
	const page = clientWidth * 0.9;
	switch (key) {
		case 'ArrowLeft':
			return Math.max(0, scrollLeft - step);
		case 'ArrowRight':
			return scrollLeft + step;
		case 'PageUp':
			return Math.max(0, scrollLeft - page);
		case 'PageDown':
			return scrollLeft + page;
		case 'Home':
			return 0;
		case 'End':
			return 'now';
		default:
			return null;
	}
}

/** The days the timeline is showing, in words, for screen readers: "Mon 5 Oct to Wed 7 Oct". */
export function windowText(view: Layout, scrollLeft: number, clientWidth: number): string {
	const inside = (t: number) => Math.min(Math.max(t, view.t0), view.now);
	const from = dayLabel(inside(timeAt(view, scrollLeft)));
	const to = dayLabel(inside(timeAt(view, scrollLeft + clientWidth)));
	return from === to ? from : `${from} to ${to}`;
}
