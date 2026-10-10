/** Most urgent first. Used to pick one state for a ticket or a cluster. */
export const STATE_ORDER = ['needs', 'failed', 'working', 'review', 'open', 'done'] as const;
export type NodeState = (typeof STATE_ORDER)[number];

/** How far a ticket got. Drawn as the node's shape. */
export type Stage = 'ticket' | 'session' | 'pr';

// --- what the collectors return -------------------------------------------

export interface Issue {
	/** Linear identifier, e.g. ENG-123 */
	id: string;
	title: string;
	url: string;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	canceledAt: string | null;
	stateName: string;
	/** Linear state type: triage | backlog | unstarted | started | completed | canceled | duplicate */
	stateType: string;
	branchName: string;
	project: { id: string; name: string } | null;
	milestone: { id: string; name: string } | null;
}

export interface PullRequest {
	repo: string;
	number: number;
	title: string;
	url: string;
	branch: string;
	state: 'open' | 'draft' | 'merged' | 'closed';
	createdAt: string;
}

export interface Session {
	id: string;
	name: string | null;
	cwd: string;
	kind: 'interactive' | 'background';
	startedAt: string;
	state: 'needs' | 'working' | 'failed' | 'open' | 'done';
	/** What a blocked session is waiting on, as Claude Code reports it. */
	waitingFor: string | null;
	/** True once Claude Code no longer lists the session. */
	gone: boolean;
}

export interface Snapshot {
	fetchedAt: string;
	demo: boolean;
	warnings: string[];
	issues: Issue[];
	prs: PullRequest[];
	sessions: Session[];
}

// --- what the screen draws -------------------------------------------------

export interface GraphNode {
	id: string;
	/** Short text under the node. */
	label: string;
	title: string;
	url: string | null;
	/** Where the node sits on the timeline. */
	at: string;
	state: NodeState;
	stage: Stage;
	/** Linear status name, null for nodes that are not tickets. */
	status: string | null;
	startedAt: string | null;
	completedAt: string | null;
	sessions: Session[];
	prs: PullRequest[];
}

export interface Lane {
	id: string;
	name: string;
	/** Project name, shown next to a milestone's name. */
	project: string | null;
	kind: 'project' | 'milestone' | 'unsorted';
	/** Lane this one branches from. */
	parent: string | null;
	/** Everything on it (and under it) is done. */
	closed: boolean;
	nodes: GraphNode[];
}

export interface Graph {
	fetchedAt: string;
	demo: boolean;
	warnings: string[];
	lanes: Lane[];
}

// --- settings ---------------------------------------------------------------

/** saved here · saved but encrypted by another app · taken from the environment · not set */
export type SecretState = 'saved' | 'locked' | 'env' | 'none';

/** What the settings dialog is given. It never includes a key itself. */
export interface PublicSettings {
	linearTeam: string;
	githubRepos: string[];
	linearKey: SecretState;
	githubToken: SecretState;
	/** How a key saved now would be stored. */
	storage: 'keychain' | 'file';
	file: string;
}

export function mostUrgent(states: NodeState[]): NodeState {
	return STATE_ORDER.find((s) => states.includes(s)) ?? 'done';
}
