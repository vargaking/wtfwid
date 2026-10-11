import { matcher } from '../graph';
import type { Digest, Graph, Snapshot } from '../model';
import { relate, workOf } from '../relations';
import { home } from './config';
import { demoDigests } from './demo';
import { sessionIndex } from './digest';
import { hub } from './live';

/**
 * Adds to a graph what the sessions' transcripts say (S-86, S-88): which tickets belong
 * together, and the work that went into each. Transcripts that have not been read yet are
 * read in the background; the screen is told when they are in and asks again.
 */
export async function enrich(graph: Graph, snapshot: Snapshot, now = Date.now()): Promise<Graph> {
	if (graph.setup) return graph;
	const sessions = graph.lanes.flatMap((l) => l.nodes).flatMap((n) => n.sessions);
	const digests: Record<string, Digest> = snapshot.demo
		? demoDigests(now)
		: await sessionIndex(home())
				.digests(sessions, () => hub().nudge())
				.catch(() => ({})); // relations are an extra: never a reason not to show the timeline
	return withDigests(graph, snapshot, digests);
}

export function withDigests(graph: Graph, snapshot: Snapshot, digests: Record<string, Digest | undefined>): Graph {
	const find = matcher(snapshot.issues);
	const lanes = graph.lanes.map((lane) => ({
		...lane,
		nodes: lane.nodes.map((node) => {
			const work = workOf(node, digests);
			return work ? { ...node, work } : node;
		})
	}));
	return { ...graph, lanes, relations: relate(lanes, digests, (branch) => find(branch)?.id ?? null) };
}
