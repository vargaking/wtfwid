import { AXIS_H, ROW_H, type Layout } from './layout';

/** One relation of the open ticket, as the timeline needs it (S-86). */
export interface Link {
	a: string;
	b: string;
	continued: boolean;
	weight: number;
}

export interface Arc {
	key: string;
	/** An SVG path, in the timeline's own coordinates. */
	d: string;
	continued: boolean;
	width: number;
}

/** How far from a mark's centre a line starts and stops, so it does not run into the mark. */
const CLEAR = 13;

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * A line for every link whose two ends are on the timeline right now. A ticket on a hidden
 * line has no place to draw to and gets none. Each line is one bow: upwards between tickets
 * side by side, to the left between tickets above each other, away from the names.
 */
export function arcs(view: Layout, links: Link[]): Arc[] {
	if (!links.length) return [];
	const wanted = new Set(links.flatMap((l) => [l.a, l.b]));
	const at = new Map<string, { x: number; y: number }>();
	for (const box of view.lanes) {
		for (const c of box.clusters) {
			for (const n of c.nodes) if (wanted.has(n.id)) at.set(n.id, { x: c.markX, y: box.y + box.lineY + c.row * ROW_H });
		}
	}

	const out: Arc[] = [];
	for (const link of links) {
		const from = at.get(link.a);
		const to = at.get(link.b);
		if (!from || !to) continue;
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		const length = Math.hypot(dx, dy);
		if (length < CLEAR * 2 + 4) continue; // in the same cluster, or touching
		// the bow's height grows with the distance, within limits
		const bow = Math.min(64, Math.max(16, length * 0.16));
		// of the two sides of the straight line, the upper one; for a vertical line, the left
		let nx = -dy / length;
		let ny = dx / length;
		if (ny > 0.01 || (Math.abs(ny) <= 0.01 && nx > 0)) {
			nx = -nx;
			ny = -ny;
		}
		// On the top rows a bow upwards would go behind the dates, which stay on top: bow down there.
		if ((from.y + to.y) / 2 + ny * bow < AXIS_H + 8) {
			nx = -nx;
			ny = -ny;
		}
		const cx = (from.x + to.x) / 2 + nx * bow * 2;
		const cy = (from.y + to.y) / 2 + ny * bow * 2;
		// leave the marks clear, along the way the line leaves and arrives
		const out1 = Math.hypot(cx - from.x, cy - from.y);
		const in1 = Math.hypot(to.x - cx, to.y - cy);
		const sx = from.x + ((cx - from.x) / out1) * CLEAR;
		const sy = from.y + ((cy - from.y) / out1) * CLEAR;
		const ex = to.x - ((to.x - cx) / in1) * CLEAR;
		const ey = to.y - ((to.y - cy) / in1) * CLEAR;
		out.push({
			key: `${link.a}>${link.b}`,
			d: `M${round(sx)} ${round(sy)} Q${round(cx)} ${round(cy)} ${round(ex)} ${round(ey)}`,
			continued: link.continued,
			// one shared file is a thin line, four or more a thick one: a difference you can see
			width: link.continued ? 2 : round(1 + Math.min(2, link.weight * 0.5))
		});
	}
	return out;
}
