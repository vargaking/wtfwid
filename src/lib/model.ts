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
	/** The git branch it was last on, read from its transcript. */
	branch?: string | null;
	/** Found as a transcript on disk, never seen listed by Claude Code (S-83). */
	fromDisk?: boolean;
	/** When it last wrote to its transcript. */
	lastAt?: string | null;
}

/** What a session's transcript says it was doing (S-55). */
export interface SessionNote {
	/** What the session was started with. Lost once Claude Code compacts the conversation. */
	firstPrompt: string | null;
	/** The last thing you asked. */
	lastPrompt: string | null;
	/** The last thing Claude said, and when. */
	lastReply: string | null;
	at: string | null;
	/** Pull requests the session opened. */
	prs: { repo: string; number: number; url: string }[];
	/** What it did, when its transcript could be read that far. */
	story?: SessionStory;
}

export interface Snapshot {
	fetchedAt: string;
	demo: boolean;
	/** Nothing is connected yet; the screen shows first-run setup instead of a timeline. */
	setup?: boolean;
	warnings: string[];
	issues: Issue[];
	prs: PullRequest[];
	sessions: Session[];
}

/** One thing a session did, in a few words. */
export interface Action {
	at: string | null;
	tool: string;
	text: string;
}

/** What a session did, read from its transcript (S-84). */
export interface SessionStory {
	startedAt: string | null;
	endedAt: string | null;
	/** Minutes it was at it. Pauses of more than five minutes are left out. */
	activeMinutes: number;
	/** What you typed, in order: the first and the most recent ones when there were many. */
	prompts: { at: string | null; text: string }[];
	promptCount: number;
	/** Files it changed with Claude Code's edit tools, most edited first. Changes made by a command are not seen. */
	files: { path: string; edits: number; created: boolean }[];
	commands: number;
	toolCalls: number;
	/** Lines written and replaced by those edits. A rough size, not a diff. */
	added: number;
	removed: number;
	tokens: { input: number; output: number; cached: number };
	/** What Claude Code says it cost, where it wrote that down. */
	costUSD: number | null;
	/** Git branches it was on, in order. */
	branches: string[];
	/** The last things it did. */
	recent: Action[];
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
	setup: boolean;
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
