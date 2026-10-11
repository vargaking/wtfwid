import type { GraphNode, Lane } from './model';

export interface Hit {
	node: GraphNode;
	lane: Lane;
}

/**
 * Finds tickets by ID or title (S-17). Every word typed has to appear somewhere in the two.
 * A bare number finds the ticket with that number. Best matches first, then the most recent.
 */
export function search(lanes: Lane[], query: string, limit = 8): Hit[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	const q = words.join(' ');
	const hits: (Hit & { rank: number })[] = [];
	for (const lane of lanes) {
		for (const node of lane.nodes) {
			const id = node.label.toLowerCase();
			const title = node.title.toLowerCase();
			if (!words.every((w) => id.includes(w) || title.includes(w))) continue;
			const number = id.split('-').pop() ?? '';
			const rank = id === q || number === q ? 0 : id.startsWith(q) || number.startsWith(q) ? 1 : title.startsWith(q) ? 2 : 3;
			hits.push({ node, lane, rank });
		}
	}
	hits.sort((a, b) => a.rank - b.rank || b.node.at.localeCompare(a.node.at));
	return hits.slice(0, limit).map(({ node, lane }) => ({ node, lane }));
}
