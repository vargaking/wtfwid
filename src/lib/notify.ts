import type { Graph, GraphNode } from './model';

export interface Alert {
	/** The node it is about. */
	id: string;
	kind: 'needs' | 'failed' | 'finished';
	title: string;
	body: string;
}

const HEADLINE = { needs: 'needs you', failed: 'failed', finished: 'is done working' } as const;

function alertFor(node: GraphNode, kind: Alert['kind']): Alert {
	const isTicket = node.status !== null;
	const waiting = node.sessions.find((s) => !s.gone && s.state === 'needs')?.waitingFor;
	const body = [isTicket ? node.title : null, kind === 'needs' && waiting ? `Waiting for: ${waiting}` : null].filter(Boolean).join('\n');
	return { id: node.id, kind, title: `${isTicket ? node.label : node.title} ${HEADLINE[kind]}`, body };
}

/**
 * Whether a refresh can be compared with another. When Linear or Claude Code could not be
 * read, tickets and sessions are simply missing, and that would look like everything stopped.
 */
export function reliable(graph: Graph): boolean {
	// the relay too: when it cannot be reached, every session in the cloud is missing at once
	return !graph.setup && !graph.warnings.some((w) => w.startsWith('Linear') || w.startsWith('Claude Code') || w.startsWith('Cloud sessions'));
}

/**
 * What changed between two refreshes that is worth interrupting for (S-18):
 * a ticket starts needing you, a session fails, or a session that was working stops.
 * Nothing when the two cannot be compared: first-run setup, demo against real, a failed source.
 */
export function alerts(before: Graph, after: Graph): Alert[] {
	if (!reliable(before) || !reliable(after) || before.demo !== after.demo) return [];
	const nodes = (g: Graph) => g.lanes.flatMap((l) => l.nodes);
	const was = new Map(nodes(before).map((n) => [n.id, n.state]));
	// "failed" is said once per session that fails, not each time the ticket's state comes back round to it
	const failedBefore = new Set(nodes(before).flatMap((n) => n.sessions.filter((s) => s.state === 'failed').map((s) => s.id)));
	const out: Alert[] = [];
	for (const node of nodes(after)) {
		const prev = was.get(node.id);
		if (node.state === prev) continue;
		if (node.state === 'needs') out.push(alertFor(node, 'needs'));
		else if (node.state === 'failed') {
			if (node.sessions.some((s) => s.state === 'failed' && !failedBefore.has(s.id))) out.push(alertFor(node, 'failed'));
		} else if (prev === 'working') out.push(alertFor(node, 'finished'));
	}
	return out;
}
