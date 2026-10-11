import { mostUrgent, STATE_ORDER, type Graph, type GraphNode, type Lane, type NodeState, type Stage } from './model';

export const DAY = 86_400_000;
/** Height of a lane with one row of nodes. */
export const LANE_H = 78;
/** Centre of a lane's first row, where its line runs. */
export const LINE_Y = 47;
export const AXIS_H = 40;
/** Height of each further row. */
export const ROW_H = 26;
/** Tickets started close together stack into this many rows before they merge (S-35). */
export const MAX_ROWS = 5;
/** Height of a folded lane, and where its line runs (S-16). */
export const FOLD_H = 44;
export const FOLD_LINE_Y = 30;
const PAD = 48;
/** Room a node needs in its row: the mark, and a little air. */
const NODE_W = 24;
/** Width of one character of a node's label (11px IBM Plex Mono). */
const CHAR_W = 6.7;
/** Longest label drawn next to a node, in characters. */
const LABEL_MAX = 34;
/** From a node's centre to where its label starts. */
const LABEL_GAP = 16;
/** Room a date label on the axis needs. */
const LABEL_W = 80;
/** How far left of a milestone's first node its branch leaves the trunk. */
const ELBOW = 28;

export interface Cluster {
	key: string;
	x: number;
	/** 0 is on the lane's line; further rows hang below it. */
	row: number;
	nodes: GraphNode[];
	state: NodeState;
	/** null for a cluster of several nodes */
	stage: Stage | null;
	/** Finished work: drawn as a small mark, with a dimmer label (S-36). */
	quiet: boolean;
	/** Text drawn to the right of the node. Finished work only has one where there is room. */
	label: string | null;
	/** Full description, for the tooltip and screen readers. */
	title: string;
	/** Right edge of what is drawn, label included. */
	right: number;
}

export interface LaneBox {
	lane: Lane;
	y: number;
	height: number;
	/** Where the lane's line runs, from the top of the lane. */
	lineY: number;
	/** A finished lane drawn as a thin strip: one row of small marks, no names (S-16). */
	folded: boolean;
	clusters: Cluster[];
	lineLeft: number;
	lineRight: number;
	status: string;
	urgent: boolean;
}

export interface Connector {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface Tick {
	x: number;
	label: string | null;
}

export interface Layout {
	width: number;
	height: number;
	nowX: number;
	/** "now", with today's date in front when the date's own label had no room. */
	nowLabel: string;
	lanes: LaneBox[];
	connectors: Connector[];
	ticks: Tick[];
	counts: Record<'needs' | 'working' | 'review' | 'failed' | 'open', number>;
	/** Time at the left edge of the timeline; with xOf / tOf it maps time to x and back. */
	t0: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayLabel(t: number): string {
	const d = new Date(t);
	return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function startOfDay(t: number): number {
	const d = new Date(t);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

export function xOf(t: number, t0: number, pxPerDay: number): number {
	return PAD + ((t - t0) / DAY) * pxPerDay;
}

export function tOf(x: number, t0: number, pxPerDay: number): number {
	return t0 + ((x - PAD) / pxPerDay) * DAY;
}

const STATE_WORDS: Record<NodeState, string> = {
	needs: 'needs you',
	failed: 'failed',
	working: 'working',
	review: 'ready for review',
	open: 'open',
	done: 'done'
};

/** History is drawn small and dim; what is still in play is drawn full size, with its name (S-36). */
export function quiet(node: GraphNode): boolean {
	if (node.state === 'done') return true;
	// a session or pull request with no ticket, that is over
	return node.status === null && node.state === 'open' && node.sessions.every((s) => s.gone) && !node.prs.length;
}

/** A node's short name, e.g. "ENG-12", and its full one, "ENG-12 · Fix login". */
function names(node: GraphNode): { id: string; name: string } {
	// a session's label is its name cut short, so the name alone says everything
	const repeats = node.title.startsWith(node.label.replace(/…$/, ''));
	return { id: node.label, name: repeats ? node.title : `${node.label} · ${node.title}` };
}

/** The longest form of a node's name that fits in `chars` characters, or null when not even its id does. */
function fit(node: GraphNode, chars: number): string | null {
	const { id, name } = names(node);
	const max = Math.min(chars, LABEL_MAX);
	if (name.length <= max) return name;
	if (max >= id.length + 10) return name.slice(0, max - 1).trimEnd() + '…';
	return id.length <= max ? id : null;
}

/**
 * Whether a node counts as being in a state, for the header (S-15). A session that ended
 * without a ticket is "open" forever; it is history, not something left half done.
 */
function inState(node: GraphNode, state: NodeState): boolean {
	return node.state === state && !(state === 'open' && quiet(node));
}

function describe(nodes: GraphNode[], unsorted: boolean): Pick<Cluster, 'label' | 'title' | 'quiet'> {
	const isQuiet = nodes.every(quiet);
	if (nodes.length > 1) {
		const state = mostUrgent(nodes.map((n) => n.state));
		const what = `${nodes.length} ${unsorted ? 'items' : 'tickets'}`;
		return { quiet: isQuiet, label: isQuiet ? null : what, title: `${what}, most urgent: ${STATE_WORDS[state]}` };
	}
	const [node] = nodes;
	return { quiet: isQuiet, label: isQuiet ? null : fit(node, LABEL_MAX), title: `${names(node).name}, ${STATE_WORDS[node.state]}` };
}

/**
 * Places a lane's nodes (S-35). Each goes in the first row with room for it, so tickets
 * started close together stack below the line in the order they started. Only when every
 * row is taken does a node merge into the item just before it, which becomes a cluster.
 */
function place(lane: Lane, x: (iso: string) => number, maxRows: number, folded = false): Cluster[] {
	const unsorted = lane.kind === 'unsorted';
	if (folded) maxRows = 1;
	const nodeW = folded ? 14 : NODE_W;
	const extent = (nodes: GraphNode[], at: number) => {
		const d = describe(nodes, unsorted);
		if (folded) d.label = null;
		const mark = nodes.length > 1 ? nodeW + 12 : nodeW; // a cluster's counted pill is wider
		return { ...d, right: at + mark / 2 + (d.label ? 4 + d.label.length * CHAR_W : 0) };
	};
	type Item = { x: number; row: number; nodes: GraphNode[]; right: number };
	const items: Item[] = [];
	const rows: Item[][] = [];
	for (const node of lane.nodes) {
		const nx = Math.round(x(node.at));
		let row = 0;
		while (row < maxRows && rows[row] && nx - nodeW / 2 < rows[row].at(-1)!.right + (folded ? 2 : 4)) row++;
		if (row < maxRows) {
			const item = { x: nx, row, nodes: [node], right: extent([node], nx).right };
			(rows[row] ??= []).push(item);
			items.push(item);
		} else {
			const nearest = rows.map((r) => r.at(-1)!).reduce((a, b) => (b.x > a.x ? b : a));
			nearest.nodes.push(node);
			nearest.right = extent(nearest.nodes, nearest.x).right;
		}
	}

	// S-36: a finished ticket gets its name too, as far as the gap to its right neighbour allows.
	const room = new Map<Item, number>();
	for (const row of rows) {
		row.forEach((item, i) => {
			const next = row[i + 1];
			room.set(item, next ? Math.floor((next.x - NODE_W / 2 - 4 - item.x - LABEL_GAP) / CHAR_W) : LABEL_MAX);
		});
	}

	return items.map((g) => {
		const d = extent(g.nodes, g.x);
		const label = d.label ?? (g.nodes.length === 1 && !folded ? fit(g.nodes[0], room.get(g)!) : null);
		return {
			key: g.nodes[0].id,
			x: g.x,
			row: g.row,
			nodes: g.nodes,
			state: mostUrgent(g.nodes.map((n) => n.state)),
			stage: g.nodes.length === 1 ? g.nodes[0].stage : null,
			...d,
			label
		};
	});
}

function statusText(lane: Lane): { status: string; urgent: boolean } {
	if (lane.closed) {
		const n = lane.nodes.length;
		return { status: n ? `finished · ${n} ${n === 1 ? 'ticket' : 'tickets'}` : 'finished', urgent: false };
	}
	const n = (s: NodeState) => lane.nodes.filter((node) => node.state === s).length;
	const parts = [
		n('needs') && `${n('needs')} ${n('needs') === 1 ? 'needs' : 'need'} you`,
		n('failed') && `${n('failed')} failed`,
		n('review') && `${n('review')} to review`,
		n('working') && `${n('working')} working`
	].filter(Boolean);
	return { status: parts.join(' · ') || 'nothing waiting', urgent: n('needs') > 0 };
}

/** `unfolded` holds the ids of the finished lanes that are drawn in full (S-16). */
export function layout(
	graph: Graph,
	now: number,
	pxPerDay: number,
	hideFinished = false,
	maxRows = MAX_ROWS,
	unfolded: ReadonlySet<string> = new Set()
): Layout {
	const all = graph.lanes.flatMap((l) => l.nodes);
	const first = all.length ? Math.min(...all.map((n) => Date.parse(n.at))) : now - 7 * DAY;
	const t0 = startOfDay(first) - DAY;
	const x = (iso: string) => xOf(Date.parse(iso), t0, pxPerDay);
	const nowX = Math.round(xOf(now, t0, pxPerDay));

	const visible = graph.lanes.filter((l) => !(hideFinished && l.closed)); // S-13
	const boxes = new Map<string, LaneBox>();
	let y = AXIS_H;
	const lanes = visible.map((lane) => {
		const folded = lane.closed && !unfolded.has(lane.id);
		const cs = place(lane, x, maxRows, folded);
		const xs = lane.nodes.map((n) => x(n.at));
		const rows = Math.max(1, ...cs.map((c) => c.row + 1));
		// A trunk with no tickets of its own gets its extent from its branches, below.
		const box: LaneBox = {
			lane,
			y,
			height: folded ? FOLD_H : LANE_H + (rows - 1) * ROW_H,
			lineY: folded ? FOLD_LINE_Y : LINE_Y,
			folded,
			clusters: cs,
			lineLeft: Math.round(Math.min(...xs, Infinity)),
			lineRight: lane.closed ? Math.round(Math.max(...xs, -Infinity)) : nowX,
			...statusText(lane)
		};
		boxes.set(lane.id, box);
		y += box.height;
		return box;
	});

	// A milestone's line leaves its project's trunk just before its first node (S-21).
	// The trunk runs at least as long as its milestones do.
	const connectors: Connector[] = [];
	for (const box of lanes) {
		const trunk = box.lane.parent ? boxes.get(box.lane.parent) : undefined;
		if (!trunk) continue;
		const elbow = box.lineLeft - ELBOW;
		trunk.lineLeft = Math.min(trunk.lineLeft, elbow);
		trunk.lineRight = Math.max(trunk.lineRight, box.lineRight);
		const top = trunk.y + trunk.lineY;
		connectors.push({ left: elbow, top, width: ELBOW, height: box.y + box.lineY - top });
	}

	// One labelled tick per day when there is room, otherwise one per week.
	// Days after today get a line but no label, which leaves room for the "now" label.
	const ticks: Tick[] = [];
	const everyDay = pxPerDay >= 90;
	let nowLabel = 'now';
	for (let t = t0; t <= now + 2 * DAY; t = startOfDay(t + DAY + DAY / 2)) {
		const tx = Math.round(xOf(t, t0, pxPerDay));
		let labelled = t <= now && (everyDay || new Date(t).getDay() === 1);
		if (labelled && nowX - tx < LABEL_W) {
			// just after midnight the date and "now" would overlap, so "now" carries the date
			labelled = false;
			nowLabel = `${dayLabel(t)} · now`;
		}
		ticks.push({ x: tx, label: labelled ? dayLabel(t) : null });
	}

	const count = (s: NodeState) => visible.reduce((sum, l) => sum + l.nodes.filter((n) => inState(n, s)).length, 0);

	return {
		width: nowX + 260,
		height: y + 32,
		nowX,
		nowLabel,
		lanes,
		connectors,
		ticks,
		counts: { needs: count('needs'), working: count('working'), review: count('review'), failed: count('failed'), open: count('open') },
		t0
	};
}

/**
 * The next node in `state` after the one with id `after`, top lane first, wrapping round (S-15).
 * With no `after`, or one that is not in that state, the first.
 */
export function nextInState(view: Layout, state: NodeState, after: string | null): GraphNode | null {
	const targets = view.lanes.flatMap((box) => box.lane.nodes).filter((n) => inState(n, state));
	if (!targets.length) return null;
	return targets[(targets.findIndex((n) => n.id === after) + 1) % targets.length];
}

/**
 * Everything that is not finished, most urgent first and then longest open first (S-19).
 * This is the short answer to "what was I doing".
 */
export function unfinished(graph: Graph): { node: GraphNode; lane: Lane }[] {
	const rank = (n: GraphNode) => STATE_ORDER.indexOf(n.state);
	return graph.lanes
		.flatMap((lane) => lane.nodes.filter((node) => !quiet(node)).map((node) => ({ node, lane })))
		.sort((a, b) => rank(a.node) - rank(b.node) || a.node.at.localeCompare(b.node.at));
}
