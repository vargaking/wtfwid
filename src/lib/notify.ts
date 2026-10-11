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
 * What changed between two refreshes that is worth interrupting for (S-18):
 * a ticket starts needing you, a session fails, or a session that was working stops.
 */
export function alerts(before: Graph, after: Graph): Alert[] {
	const was = new Map(before.lanes.flatMap((l) => l.nodes).map((n) => [n.id, n.state]));
	const out: Alert[] = [];
	for (const node of after.lanes.flatMap((l) => l.nodes)) {
		const prev = was.get(node.id);
		if (node.state === prev) continue;
		if (node.state === 'needs') out.push(alertFor(node, 'needs'));
		else if (node.state === 'failed') out.push(alertFor(node, 'failed'));
		else if (prev === 'working') out.push(alertFor(node, 'finished'));
	}
	return out;
}
