import type { Graph, GraphNode, Issue, Lane, NodeState, PullRequest, Session, Snapshot } from './model';

const ID_RE = /[a-z][a-z0-9]*-\d+/g;
const HIDDEN_STATE_TYPES = new Set(['canceled', 'duplicate']);

/** Finds the issue a session or pull request belongs to (S-50, S-51). */
function matcher(issues: Issue[]) {
	const byId = new Map(issues.map((i) => [i.id.toLowerCase(), i]));
	const byBranch = issues.filter((i) => i.branchName).map((i) => [i.branchName.toLowerCase(), i] as const);
	return (text: string): Issue | undefined => {
		const lower = text.toLowerCase();
		for (const [branch, issue] of byBranch) if (lower.includes(branch)) return issue;
		for (const m of lower.matchAll(ID_RE)) {
			const hit = byId.get(m[0]);
			if (hit) return hit;
		}
	};
}

function earliest(times: (string | null | undefined)[]): string | null {
	const known = times.filter((t): t is string => !!t).sort();
	return known[0] ?? null;
}

/** S-40 … S-45 */
export function ticketState(issue: Issue, sessions: Session[], prs: PullRequest[]): NodeState {
	const live = sessions.filter((s) => !s.gone);
	if (live.some((s) => s.state === 'needs')) return 'needs';
	const done = issue.completedAt !== null;
	const latest = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
	if (!done && latest?.state === 'failed') return 'failed';
	if (live.some((s) => s.state === 'working')) return 'working';
	if (done) return 'done';
	if (/review/i.test(issue.stateName) || prs.some((p) => p.state === 'open')) return 'review';
	return 'open';
}

function ticketNode(issue: Issue, sessions: Session[], prs: PullRequest[]): GraphNode {
	return {
		id: issue.id,
		label: issue.id,
		title: issue.title,
		url: issue.url,
		// S-34
		at:
			issue.startedAt ??
			earliest(sessions.map((s) => s.startedAt)) ??
			earliest(prs.map((p) => p.createdAt)) ??
			issue.completedAt ??
			issue.createdAt,
		state: ticketState(issue, sessions, prs),
		stage: prs.length ? 'pr' : sessions.length ? 'session' : 'ticket',
		status: issue.stateName,
		startedAt: issue.startedAt,
		completedAt: issue.completedAt,
		sessions,
		prs
	};
}

function sessionNode(s: Session): GraphNode {
	const name = s.name ?? s.cwd.split('/').filter(Boolean).pop() ?? 'session';
	return {
		id: `session:${s.id}`,
		label: name.length > 14 ? name.slice(0, 13) + '…' : name,
		title: name,
		url: null,
		at: s.startedAt,
		state: s.state,
		stage: 'session',
		status: null,
		startedAt: s.startedAt,
		completedAt: null,
		sessions: [s],
		prs: []
	};
}

function prNode(p: PullRequest): GraphNode {
	return {
		id: `pr:${p.repo}#${p.number}`,
		label: `#${p.number}`,
		title: p.title,
		url: p.url,
		at: p.createdAt,
		state: p.state === 'open' ? 'review' : 'open',
		stage: 'pr',
		status: null,
		startedAt: p.createdAt,
		completedAt: null,
		sessions: [],
		prs: [p]
	};
}

const start = (lane: Lane) => lane.nodes[0]?.at ?? '9999';

export function buildGraph(snap: Snapshot): Graph {
	const issues = snap.issues.filter((i) => !HIDDEN_STATE_TYPES.has(i.stateType) && !i.canceledAt); // S-33
	const find = matcher(issues);

	const sessionsOf = new Map<string, Session[]>();
	const prsOf = new Map<string, PullRequest[]>();
	const loose: GraphNode[] = [];
	for (const s of snap.sessions) {
		const issue = find(`${s.name ?? ''} ${s.cwd}`);
		if (issue) sessionsOf.set(issue.id, [...(sessionsOf.get(issue.id) ?? []), s]);
		else loose.push(sessionNode(s)); // S-52
	}
	for (const p of snap.prs) {
		const issue = find(`${p.branch} ${p.title}`);
		if (issue) prsOf.set(issue.id, [...(prsOf.get(issue.id) ?? []), p]);
		else if (p.state === 'open' || p.state === 'draft') loose.push(prNode(p)); // S-52
	}

	const lanes = new Map<string, Lane>();
	const lane = (id: string, make: () => Omit<Lane, 'id' | 'nodes' | 'closed'>): Lane => {
		if (!lanes.has(id)) lanes.set(id, { id, nodes: [], closed: false, ...make() });
		return lanes.get(id)!;
	};

	for (const issue of issues) {
		const sessions = sessionsOf.get(issue.id) ?? [];
		const prs = prsOf.get(issue.id) ?? [];
		if (!issue.startedAt && !issue.completedAt && !sessions.length && !prs.length) continue; // S-32

		const trunkId = `p:${issue.project?.id ?? 'none'}`;
		const projectName = issue.project?.name ?? 'No project'; // S-22
		const trunk = lane(trunkId, () => ({ name: projectName, project: null, kind: 'project', parent: null })); // S-20
		const target = issue.milestone
			? lane(`m:${issue.milestone.id}`, () => ({
					name: issue.milestone!.name,
					project: projectName,
					kind: 'milestone',
					parent: trunkId
				})) // S-21
			: trunk;
		target.nodes.push(ticketNode(issue, sessions, prs));
	}

	for (const l of lanes.values()) l.nodes.sort((a, b) => a.at.localeCompare(b.at));

	// Order: projects oldest first; under each, its milestones newest first (S-23).
	const ordered: Lane[] = [];
	const trunks = [...lanes.values()].filter((l) => l.kind === 'project');
	const groups = trunks.map((trunk) => {
		const children = [...lanes.values()]
			.filter((l) => l.parent === trunk.id)
			.sort((a, b) => start(b).localeCompare(start(a)));
		for (const c of children) c.closed = c.nodes.every((n) => n.state === 'done');
		trunk.closed = trunk.nodes.every((n) => n.state === 'done') && children.every((c) => c.closed);
		const began = [trunk, ...children].map(start).sort()[0];
		return { began, lanes: [trunk, ...children] };
	});
	groups.sort((a, b) => a.began.localeCompare(b.began));
	for (const g of groups) ordered.push(...g.lanes);

	if (loose.length) {
		loose.sort((a, b) => a.at.localeCompare(b.at));
		ordered.push({ id: 'unsorted', name: 'Unsorted', project: null, kind: 'unsorted', parent: null, closed: false, nodes: loose });
	}

	return { fetchedAt: snap.fetchedAt, demo: snap.demo, setup: !!snap.setup, warnings: snap.warnings, lanes: ordered };
}
