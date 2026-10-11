import { matcher } from '../graph';
import type { Digest, Graph, PullDigest, Snapshot } from '../model';
import { pullAsDigest, pullKey, relate, threads, workOf } from '../relations';
import { config } from './config';
import { demoDigests } from './demo';
import { sessionIndex } from './digest';
import { githubToken } from './github';
import { hub } from './live';
import { pullIndex } from './pulls';

/**
 * Adds to a graph what the sessions' transcripts and the pull requests say (S-86, S-88,
 * S-90): which tickets belong together, and the work that went into each. What has not
 * been read yet is read in the background; the screen is told when it is in and asks again.
 * All of it is an extra: a failure here never keeps the timeline from showing.
 */
export async function enrich(graph: Graph, snapshot: Snapshot, now = Date.now()): Promise<Graph> {
	if (graph.setup) return graph;
	if (snapshot.demo) return withDigests(graph, snapshot, demoDigests(now));
	const cfg = await config();
	const nodes = graph.lanes.flatMap((l) => l.nodes);
	const nudge = () => hub().nudge();

	const sessions = sessionIndex(cfg.home)
		.digests(nodes.flatMap((n) => n.sessions), nudge)
		.catch(() => ({}) as Record<string, Digest>);

	// With a saved snapshot nothing is asked of GitHub, unless a stand-in is named for it.
	// Without a token GitHub allows 60 requests an hour, which reading pull requests would
	// use up at once: then they are left unread.
	const prs = nodes.flatMap((n) => n.prs);
	const pulls = (async (): Promise<Record<string, PullDigest>> => {
		if (!prs.length || (cfg.snapshotFile && !process.env.WTFWID_GITHUB_API)) return {};
		const token = await githubToken(cfg.githubToken);
		if (!token && !process.env.WTFWID_GITHUB_API) return {};
		return pullIndex(cfg.home).digests(prs, token, nudge);
	})().catch(() => ({}) as Record<string, PullDigest>);

	return withDigests(graph, snapshot, await sessions, await pulls);
}

export function withDigests(graph: Graph, snapshot: Snapshot, sessions: Record<string, Digest | undefined>, pulls: Record<string, PullDigest> = {}): Graph {
	const find = matcher(snapshot.issues);
	const digests: Record<string, Digest | undefined> = { ...sessions };
	const lanes = graph.lanes.map((lane) => ({
		...lane,
		nodes: lane.nodes.map((node) => {
			// what was read of its pull requests: their sessions' links go onto the pull request itself
			const prs = node.prs.map((pr) => {
				const pull = pulls[pullKey(pr)];
				if (!pull) return pr;
				const digest = pullAsDigest(pr, pull);
				digests[`pr:${pullKey(pr)}`] = digest;
				return digest.cloud?.length ? { ...pr, sessions: digest.cloud } : pr;
			});
			const withPrs = { ...node, prs };
			const work = workOf(withPrs, digests);
			return work ? { ...withPrs, work } : withPrs;
		})
	}));
	const ticketOf = (branch: string) => find(branch)?.id ?? null;
	return { ...graph, lanes, relations: relate(lanes, digests, ticketOf), threads: threads(lanes, digests, ticketOf) };
}
