import { mostUrgent, type Graph, type GraphNode, type Lane, type NodeState, type Stage } from './model';

export const DAY = 86_400_000;
export const LANE_H = 96;
export const LINE_Y = 52;
export const AXIS_H = 40;
const PAD = 48;
/** Nodes closer than this merge into a cluster (S-35). Also the room one label needs. */
const GAP = 68;
/** Room a date label on the axis needs. */
const LABEL_W = 80;
/** How far left of a milestone's first node its branch leaves the trunk. */
const ELBOW = 28;

export interface Cluster {
	key: string;
	x: number;
	nodes: GraphNode[];
	state: NodeState;
	/** null for a cluster of several nodes */
	stage: Stage | null;
	label: string;
}

export interface LaneBox {
	lane: Lane;
	y: number;
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
	counts: Record<'needs' | 'working' | 'review' | 'failed', number>;
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

function clusters(lane: Lane, x: (iso: string) => number): Cluster[] {
	// A cluster sits at its first node, so two clusters are never closer than GAP.
	const groups: { first: number; nodes: GraphNode[] }[] = [];
	for (const node of lane.nodes) {
		const nx = x(node.at);
		const cur = groups[groups.length - 1];
		if (cur && nx - cur.first < GAP) cur.nodes.push(node);
		else groups.push({ first: nx, nodes: [node] });
	}
	return groups.map((g) => ({
		key: g.nodes[0].id,
		x: Math.round(g.first),
		nodes: g.nodes,
		state: mostUrgent(g.nodes.map((n) => n.state)),
		stage: g.nodes.length === 1 ? g.nodes[0].stage : null,
		label: g.nodes.length === 1 ? g.nodes[0].label : `${g.nodes.length} ${lane.kind === 'unsorted' ? 'items' : 'tickets'}`
	}));
}

function statusText(lane: Lane): { status: string; urgent: boolean } {
	if (lane.closed) return { status: 'finished', urgent: false };
	const n = (s: NodeState) => lane.nodes.filter((node) => node.state === s).length;
	const parts = [
		n('needs') && `${n('needs')} ${n('needs') === 1 ? 'needs' : 'need'} you`,
		n('failed') && `${n('failed')} failed`,
		n('review') && `${n('review')} to review`,
		n('working') && `${n('working')} working`
	].filter(Boolean);
	return { status: parts.join(' · ') || 'nothing waiting', urgent: n('needs') > 0 };
}

export function layout(graph: Graph, now: number, pxPerDay: number, hideFinished = false): Layout {
	const all = graph.lanes.flatMap((l) => l.nodes);
	const first = all.length ? Math.min(...all.map((n) => Date.parse(n.at))) : now - 7 * DAY;
	const t0 = startOfDay(first) - DAY;
	const x = (iso: string) => xOf(Date.parse(iso), t0, pxPerDay);
	const nowX = Math.round(xOf(now, t0, pxPerDay));

	const visible = graph.lanes.filter((l) => !(hideFinished && l.closed)); // S-13
	const boxes = new Map<string, LaneBox>();
	const lanes = visible.map((lane, row) => {
		const cs = clusters(lane, x);
		const xs = lane.nodes.map((n) => x(n.at));
		// A trunk with no tickets of its own gets its extent from its branches, below.
		const box: LaneBox = {
			lane,
			y: AXIS_H + row * LANE_H,
			clusters: cs,
			lineLeft: Math.round(Math.min(...xs, Infinity)),
			lineRight: lane.closed ? Math.round(Math.max(...xs, -Infinity)) : nowX,
			...statusText(lane)
		};
		boxes.set(lane.id, box);
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
		connectors.push({ left: elbow, top: trunk.y + LINE_Y, width: ELBOW, height: box.y - trunk.y });
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

	const count = (s: NodeState) => visible.reduce((sum, l) => sum + l.nodes.filter((n) => n.state === s).length, 0);

	return {
		width: nowX + 260,
		height: AXIS_H + lanes.length * LANE_H + 32,
		nowX,
		nowLabel,
		lanes,
		connectors,
		ticks,
		counts: { needs: count('needs'), working: count('working'), review: count('review'), failed: count('failed') },
		t0
	};
}
