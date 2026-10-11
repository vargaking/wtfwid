import type { Digest, GraphNode, Lane, Relation, Work } from './model';

/**
 * Works out which tickets belong together (S-86), from what their sessions did:
 * - two tickets whose sessions changed the same files are about the same part of the code;
 * - a session that went from one ticket's branch to another's carried one into the other.
 * Nothing here reads a file: it is given what was already read from the transcripts.
 */

/** A Claude Code worktree inside a checkout: `<checkout>/.claude/worktrees/<name>`. */
const WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/;

/**
 * The checkout a folder belongs to. Sessions on different tickets often run in a worktree
 * each; taking the worktree out of the path makes the same file the same path in all of them.
 */
export const checkoutOf = (folder: string) => folder.replace(WORKTREE, '').replace(/[\\/]+$/, '');

const absolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');

/** Files that change with almost any piece of work, and say nothing about what it was. */
const NOISE = /(^|[\\/])(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|CHANGELOG\.md)$/i;

/**
 * Where a file is, from its checkout: the same for every worktree of it. Null for a file
 * outside the checkout (a note in /tmp, a plan in ~/.claude): two sessions writing
 * `/tmp/plan.md` have nothing to do with each other.
 */
export function fileIn(path: string, root: string): string | null {
	if (!path || !root) return null;
	const full = checkoutOf(absolute(path) ? path : `${root}/${path}`);
	if (!full.startsWith(`${root}/`) && !full.startsWith(`${root}\\`)) return null;
	const inside = full.slice(root.length + 1);
	return NOISE.test(inside) ? null : inside;
}

/** A file more tickets than this have changed says too little to relate two of them. */
const HUB_MIN = 6;
const HUB_MAX = 12;
/** Below this, what two tickets share is not worth a line. One file only they changed counts 1. */
const MIN_WEIGHT = 0.5;
/** Each ticket keeps its strongest few relations. */
const PER_NODE = 5;
/** How many shared files a relation names. */
const FILES_NAMED = 4;

interface Pair {
	a: string;
	b: string;
	continued: boolean;
	weight: number;
	files: { path: string; others: number }[];
}

/**
 * Every relation worth drawing, strongest first.
 * `digests` is what was read from each session's transcript, by session id.
 * `ticketOf` says which node a git branch belongs to, or null.
 */
export function relate(lanes: Lane[], digests: Record<string, Digest | undefined>, ticketOf: (branch: string) => string | null): Relation[] {
	const nodes = lanes.flatMap((l) => l.nodes);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const pairs = new Map<string, Pair>();
	const pair = (x: string, y: string): Pair => {
		const key = x < y ? `${x}\n${y}` : `${y}\n${x}`;
		let p = pairs.get(key);
		if (!p) {
			// the earlier one first; "continued" turns it round if the session went the other way
			const first = byId.get(x)!.at <= byId.get(y)!.at ? x : y;
			p = { a: first, b: first === x ? y : x, continued: false, weight: 0, files: [] };
			pairs.set(key, p);
		}
		return p;
	};

	// which nodes changed each file
	const changedBy = new Map<string, Set<string>>();
	let withFiles = 0;
	for (const node of nodes) {
		const mine = new Set<string>();
		for (const s of node.sessions) {
			const d = digests[s.id];
			for (const f of d?.files ?? []) {
				const inside = fileIn(f.path, d!.root);
				// the checkout is part of the name: `src/index.ts` of two different projects is two files
				if (inside) mine.add(`${d!.root}\n${inside}`);
			}
		}
		if (mine.size) withFiles++;
		for (const file of mine) changedBy.set(file, (changedBy.get(file) ?? new Set()).add(node.id));
	}

	const hub = Math.max(HUB_MIN, Math.min(HUB_MAX, Math.ceil(withFiles * 0.3)));
	for (const [file, ids] of changedBy) {
		if (ids.size < 2 || ids.size > hub) continue;
		const list = [...ids];
		const path = file.slice(file.indexOf('\n') + 1);
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				const p = pair(list[i], list[j]);
				p.weight += 1 / (list.length - 1);
				p.files.push({ path, others: list.length - 2 });
			}
		}
	}

	// a session that went from one ticket's branch to another's
	for (const node of nodes) {
		for (const s of node.sessions) {
			const went: string[] = [];
			for (const branch of digests[s.id]?.branches ?? []) {
				const id = ticketOf(branch);
				if (id && byId.has(id) && id !== went.at(-1)) went.push(id);
			}
			// A session with no ticket of its own that began on one: it grew out of that ticket.
			if (node.status === null && went.length && went.at(-1) !== node.id) went.push(node.id);
			for (let i = 1; i < went.length; i++) {
				const p = pair(went[i - 1], went[i]);
				if (p.continued) continue; // it went back and forth: the first way stands
				p.continued = true;
				p.a = went[i - 1];
				p.b = went[i];
			}
		}
	}

	const rank = (x: Pair, y: Pair) => Number(y.continued) - Number(x.continued) || y.weight - x.weight || x.a.localeCompare(y.a) || x.b.localeCompare(y.b);
	const worth = [...pairs.values()].filter((p) => p.continued || p.weight >= MIN_WEIGHT).sort(rank);
	// a pair stays if it is among the strongest few of either of its two tickets
	const taken = new Map<string, number>();
	const kept = worth.filter((p) => {
		const room = (taken.get(p.a) ?? 0) < PER_NODE || (taken.get(p.b) ?? 0) < PER_NODE;
		if (room) for (const id of [p.a, p.b]) taken.set(id, (taken.get(id) ?? 0) + 1);
		return room;
	});

	return kept.map((p) => ({
		a: p.a,
		b: p.b,
		continued: p.continued,
		weight: Math.round(p.weight * 100) / 100,
		shared: p.files.length,
		files: p.files
			.sort((x, y) => x.others - y.others || x.path.localeCompare(y.path))
			.slice(0, FILES_NAMED)
			.map((f) => f.path)
	}));
}

/** The relations of one node, strongest first, each with the id of the node at its other end. */
export function relationsOf(relations: Relation[] | undefined, id: string): { other: string; relation: Relation }[] {
	return (relations ?? []).filter((r) => r.a === id || r.b === id).map((relation) => ({ other: relation.a === id ? relation.b : relation.a, relation }));
}

/** Why two nodes are related, in a few words, seen from the node `id`. */
export function reason(relation: Relation, id: string): string {
	const parts: string[] = [];
	if (relation.continued) parts.push(relation.a === id ? 'a session went on from here to this' : 'a session came here from this');
	if (relation.shared) parts.push(`${relation.shared} ${relation.shared === 1 ? 'file' : 'files'} in common`);
	return parts.join(' · ');
}

/** Stretches of time in order, with the ones that touch or overlap made one. */
export function mergeSpans(spans: [number, number][]): [number, number][] {
	const out: [number, number][] = [];
	for (const [from, to] of [...spans].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
		const last = out.at(-1);
		if (last && from <= last[1]) last[1] = Math.max(last[1], to);
		else out.push([from, to]);
	}
	return out;
}

/** What went into a node, added up over the sessions that have been read (S-88). */
export function workOf(node: GraphNode, digests: Record<string, Digest | undefined>): Work | undefined {
	const read = node.sessions.map((s) => digests[s.id]).filter((d): d is Digest => !!d);
	if (!read.length) return undefined;
	const costs = read.map((d) => d.costUSD).filter((c): c is number => c !== null);
	const sum = (pick: (d: Digest) => number) => read.reduce((n, d) => n + pick(d), 0);
	return {
		minutes: sum((d) => d.minutes),
		sessions: read.length,
		added: sum((d) => d.added),
		removed: sum((d) => d.removed),
		tokens: sum((d) => d.tokens),
		costUSD: costs.length ? Math.round(costs.reduce((n, c) => n + c, 0) * 100) / 100 : null,
		spans: mergeSpans(read.flatMap((d) => d.spans))
	};
}
