import { DAY } from './layout';
import type { GraphNode, Lane } from './model';
import { mergeSpans } from './relations';

/**
 * What happened in a stretch of days (S-89): which tickets were worked on and for how long,
 * which were started and which completed. Built from the work already on each node (S-88),
 * so nothing is read for it.
 */

export interface DayItem {
	node: GraphNode;
	/** Minutes its sessions were at it within the stretch. */
	minutes: number;
	/** Commits made on its pull requests within the stretch (S-90). */
	commits: number;
	started: boolean;
	completed: boolean;
}

export interface Day {
	from: number;
	to: number;
	/** All session time in the stretch. Sessions running side by side each count. */
	minutes: number;
	/** Minutes of the stretch in which at least one session was at it. */
	busy: number;
	/** Commits made within the stretch, on pull requests that have been read. */
	commits: number;
	/** Each ticket's cost, by the share of its work that fell in the stretch. Null when no cost is known. */
	costUSD: number | null;
	/** Most worked on first, then the ones only started or completed. */
	items: DayItem[];
}

const MINUTE = 60_000;

/** How many of the minutes in `spans` fall between `from` and `to`, all in minutes since 1970. */
export function minutesIn(spans: [number, number][], from: number, to: number): number {
	let sum = 0;
	for (const [a, b] of spans) sum += Math.max(0, Math.min(b, to) - Math.max(a, from));
	return sum;
}

const within = (iso: string | null, from: number, to: number) => {
	if (!iso) return false;
	const t = Date.parse(iso);
	return t >= from && t < to;
};

/** `from` and `to` are times in milliseconds: the start of the first day and the end of the last. */
export function dayOf(lanes: Lane[], from: number, to = from + DAY): Day {
	const a = from / MINUTE;
	const b = to / MINUTE;
	const items: DayItem[] = [];
	const clipped: [number, number][] = [];
	let cost: number | null = null;
	for (const node of lanes.flatMap((l) => l.nodes)) {
		const spans = node.work?.spans ?? [];
		const minutes = Math.round(minutesIn(spans, a, b));
		// a session with no ticket "starts" when it starts; a ticket when Linear says it was started
		const commits = (node.work?.commits ?? []).filter((at) => at >= a && at < b).length;
		const started = within(node.startedAt, from, to);
		const completed = within(node.completedAt, from, to);
		if (!minutes && !commits && !started && !completed) continue;
		items.push({ node, minutes, commits, started, completed });
		for (const [x, y] of spans) if (Math.min(y, b) > Math.max(x, a)) clipped.push([Math.max(x, a), Math.min(y, b)]);
		if (minutes && node.work?.costUSD != null && node.work.minutes > 0) cost = (cost ?? 0) + node.work.costUSD * Math.min(1, minutes / node.work.minutes);
	}
	items.sort((x, y) => y.minutes - x.minutes || y.commits - x.commits || x.node.at.localeCompare(y.node.at));
	return {
		from,
		to,
		minutes: items.reduce((sum, item) => sum + item.minutes, 0),
		busy: Math.round(mergeSpans(clipped).reduce((sum, [x, y]) => sum + y - x, 0)),
		commits: items.reduce((sum, item) => sum + item.commits, 0),
		costUSD: cost === null ? null : Math.round(cost * 100) / 100,
		items
	};
}
