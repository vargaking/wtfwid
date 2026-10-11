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
	/** When GitHub last saw it change. Used to know when its files and commits must be read again. */
	updatedAt?: string;
	/**
	 * Links to the Claude Code sessions that worked on it (S-90). A session that runs in the
	 * cloud leaves its link in the pull request's description and in its commits; that is the
	 * only trace of it outside claude.ai.
	 */
	sessions?: string[];
}

/** What wtfwid keeps of a pull request after reading its files and commits once (S-56, S-90). */
export interface PullDigest {
	/** Which state of the pull request this was read from (its `updatedAt`), and when. */
	stamp: string;
	readAt: number;
	/** Files it changes, most changed first. */
	files: { path: string; changes: number }[];
	added: number;
	removed: number;
	/** Its commits: when, in whole minutes since 1970, and which of `sessions` made it (-1: none named). */
	commits: [number, number][];
	/** Session links from the commits' `Claude-Session:` trailers, in order of first appearance. */
	sessions: string[];
}

export interface Session {
	id: string;
	name: string | null;
	cwd: string;
	/** `cloud`: it runs on Anthropic's machines and says so itself, through the relay (S-91). */
	kind: 'interactive' | 'background' | 'cloud';
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
	/** When it last wrote to its transcript, or last reported. */
	lastAt?: string | null;
	/** A cloud session's page on claude.ai. */
	url?: string | null;
	/** The ticket it said it is for, when it said so (S-91). */
	ticket?: string | null;
	/** The last thing you asked and the last thing it said, as it reported them. */
	lastAsked?: string | null;
	lastSaid?: string | null;
}

/** What a conversation left on a ticket through the connector (S-91): where it got to. */
export interface Note {
	id: string;
	at: string;
	ticket: string | null;
	title: string;
	summary: string;
	decided: string[];
	open: string[];
	/** A link to the conversation, when it gave one. */
	url: string | null;
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
	/** Notes left through the connector, oldest first. */
	notes?: Note[];
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
	/** The stretches it was at it, as [from, to] in milliseconds. A pause of more than five minutes ends one. */
	spans: [number, number][];
}

/** What the live stream sends (S-85). */
export type LiveEvent =
	/** on connecting: the last things each running session did, by session id */
	| { type: 'hello'; sessions: Record<string, Action[]> }
	/** a running session did something */
	| { type: 'actions'; id: string; actions: Action[] }
	/** a session started, stopped or changed state: read everything again */
	| { type: 'sessions' };

/**
 * What wtfwid keeps of a session after reading its transcript once (S-86): enough to relate
 * tickets to each other and to say when the work happened, and small enough to keep for good.
 */
export interface Digest {
	/** Which state of the transcript this was read from, and when. */
	stamp: string;
	readAt: number;
	/** The checkout the session worked in: its folder, with a Claude Code worktree taken out. */
	root: string;
	/** Files it edited, as the story has them: from the session's folder, most edited first. */
	files: { path: string; edits: number }[];
	/** Git branches it was on, in order. */
	branches: string[];
	/** When it was at it, as [from, to] in whole minutes since 1970. */
	spans: [number, number][];
	minutes: number;
	added: number;
	removed: number;
	tokens: number;
	costUSD: number | null;
	/** Links to the cloud sessions behind it, when this came from a pull request (S-90). */
	cloud?: string[];
	/** When it committed, in whole minutes since 1970, when this came from a pull request. */
	commits?: number[];
}

/** How two nodes on the timeline belong together (S-86). */
export interface Relation {
	/** Node ids. `a` is the earlier one; when a session carried on, `a` is where it came from. */
	a: string;
	b: string;
	/** A session went from `a`'s branch to `b`'s: `b` grew out of `a`. */
	continued: boolean;
	/** How much they share: each file both changed counts, less the more other tickets changed it too. */
	weight: number;
	/** How many files both changed. */
	shared: number;
	/** A few of those files, the ones fewest other tickets touched first. */
	files: string[];
}

/** The work that went into a node, added up over its sessions (S-88). */
export interface Work {
	minutes: number;
	/** How many of its sessions this is known for. */
	sessions: number;
	added: number;
	removed: number;
	tokens: number;
	costUSD: number | null;
	/** When, as [from, to] in whole minutes since 1970, in order. Sessions that ran side by side overlap. */
	spans: [number, number][];
	/** When its pull requests' commits were made, in whole minutes since 1970, in order (S-90). */
	commits: number[];
	/** Lines its pull requests add and remove, as GitHub counts them. Left out without pull request data. */
	lines?: { added: number; removed: number };
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
	/** Left out when none of its sessions has been read. */
	work?: Work;
	/** Notes conversations left on it, newest first (S-91). */
	notes?: Note[];
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
	/** Strongest first. Left out until sessions have been read. */
	relations?: Relation[];
	/** The sessions that worked on more than one ticket, each with the tickets in the order it came to them. */
	threads?: { session: string; nodes: string[] }[];
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
	relayUrl: string;
	relayToken: SecretState;
	/** How a key saved now would be stored. */
	storage: 'keychain' | 'file';
	file: string;
}

export function mostUrgent(states: NodeState[]): NodeState {
	return STATE_ORDER.find((s) => states.includes(s)) ?? 'done';
}
