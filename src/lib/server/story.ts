import type { Action, SessionStory } from '../model';

/**
 * Reads from a transcript what the session did (S-84): the files it edited, the commands
 * it ran, roughly how many lines it wrote, how long it was at it and what it cost in tokens.
 * Like the rest of the transcript reading, this follows what Claude Code 2.1.296 writes and
 * skips whatever it does not understand.
 */

const PROMPT_MAX = 240;
const PROMPTS_KEPT = 40;
const ACTIONS_KEPT = 12;
/** A pause longer than this is not counted as time spent. */
const IDLE_MS = 5 * 60_000;
/**
 * Unless it ends with the result of a tool: then the session was not idle, it was waiting for
 * a command or a sub-agent, which can take much longer. Not without limit, because a tool
 * that waits for your permission can sit there overnight.
 */
const TOOL_WAIT_MS = 60 * 60_000;

/** Whole minutes in a list of stretches given in milliseconds, each end rounded to the minute. */
export function minutesOf(spans: [number, number][]): number {
	return spans.reduce((sum, [from, to]) => sum + Math.round(to / 60_000) - Math.round(from / 60_000), 0);
}

type Input = Record<string, unknown>;
interface Block {
	type?: string;
	text?: string;
	name?: string;
	input?: Input;
}
interface Entry {
	type?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	isCompactSummary?: boolean;
	origin?: { kind?: string };
	timestamp?: string;
	cwd?: string;
	gitBranch?: string;
	message?: { id?: string; content?: string | Block[]; usage?: Record<string, unknown> };
	totalCostUSD?: number;
	startTime?: number;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const lines = (v: unknown) => (typeof v === 'string' && v ? v.split('\n').length : 0);
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text);
const oneLine = (text: string, max: number) => clip(text.trim().split('\n')[0] ?? '', max);

/** A path the way you would say it: from the session's folder, where it is inside it. */
export function relative(path: string, cwd: string): string {
	const root = cwd.replace(/[\\/]+$/, '');
	return root && (path.startsWith(root + '/') || path.startsWith(root + '\\')) ? path.slice(root.length + 1) : path;
}

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** One tool call in a few words, for the live feed. Null for housekeeping nobody needs to watch. */
export function describeAction(tool: string, input: Input, cwd: string): string | null {
	const file = relative(str(input.file_path) || str(input.notebook_path) || str(input.path), cwd);
	switch (tool) {
		case 'Bash':
			return str(input.description) ? oneLine(str(input.description), 90) : `$ ${oneLine(str(input.command), 80)}`;
		case 'Edit':
		case 'MultiEdit':
		case 'NotebookEdit':
			return `Editing ${file}`;
		case 'Write':
			return `Writing ${file}`;
		case 'Read':
			return `Reading ${file}`;
		case 'Grep':
		case 'Glob':
			return `Searching for ${oneLine(str(input.pattern), 60)}`;
		case 'WebSearch':
			return `Searching the web: ${oneLine(str(input.query), 60)}`;
		case 'WebFetch':
			try {
				return `Fetching ${new URL(str(input.url)).host}`;
			} catch {
				return 'Fetching a page';
			}
		case 'Task':
		case 'Agent':
			return `Handing off: ${oneLine(str(input.description) || str(input.prompt), 70)}`;
		case 'TodoWrite':
		case 'TaskCreate':
		case 'TaskUpdate':
		case 'TaskList':
		case 'TaskGet':
		case 'ToolSearch':
			return null;
	}
	const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
	if (mcp) return `${mcp[1].replaceAll('_', ' ')}: ${mcp[2].replaceAll('_', ' ')}`;
	return tool;
}

/** Text that Claude Code put at the start of a message itself; see transcript.ts. */
function withoutInjected(text: string): string {
	let rest = text.trimStart();
	for (;;) {
		const open = /^<([a-zA-Z][\w-]*)(?:\s[^>]*)?(\/?)>/.exec(rest);
		if (!open) return rest.trim();
		if (open[2]) rest = rest.slice(open[0].length).trimStart();
		else {
			const close = rest.indexOf(`</${open[1]}>`, open[0].length);
			if (close < 0) return rest.trim();
			rest = rest.slice(close + open[1].length + 3).trimStart();
		}
	}
}

function typed(entry: Entry): string {
	const content = entry.message?.content;
	const blocks = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string) : [];
	return blocks.map(withoutInjected).filter(Boolean).join('\n\n');
}

/**
 * What one line of a transcript says happened, for the live feed (S-85): the tools Claude
 * called, the first line of what it said, and what you typed. Nothing for lines that are
 * results, housekeeping, or a sub-agent's.
 */
export function actionsFrom(line: string, cwd: string, agent = false): Action[] {
	if (line.includes('"type":"tool_result"')) return [];
	if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) return [];
	let entry: Entry;
	try {
		entry = JSON.parse(line);
	} catch {
		return [];
	}
	// a sub-agent's lines count only when reading its own transcript, and then only what it did
	if (!!entry.isSidechain !== agent || (entry.type !== 'assistant' && entry.type !== 'user')) return [];
	const at = entry.timestamp ?? null;
	if (entry.type === 'user') {
		if (agent || entry.isMeta || entry.isCompactSummary || (entry.origin?.kind && entry.origin.kind !== 'human')) return [];
		const text = typed(entry);
		return text ? [{ at, tool: 'you', text: oneLine(text, 120) }] : [];
	}
	const out: Action[] = [];
	const content = entry.message?.content;
	for (const block of Array.isArray(content) ? content : []) {
		// what a sub-agent says is for the session that started it, not for you
		if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() && !agent) out.push({ at, tool: 'says', text: oneLine(block.text, 120) });
		else if (block?.type === 'tool_use') {
			const text = describeAction(str(block.name), block.input && typeof block.input === 'object' ? block.input : {}, cwd);
			if (text) out.push({ at, tool: str(block.name), text });
		}
	}
	return out;
}

/**
 * Takes a transcript one line at a time. `cwd` is the session's folder, for short paths.
 * `agent` is for the transcript of a sub-agent, which Claude Code keeps in a file of its
 * own: what it edited, ran and used counts; what it was told is not something you typed.
 */
export function storyReader(cwd: string, agent = false) {
	const files = new Map<string, { edits: number; created: boolean }>();
	const usage = new Map<string, { input: number; output: number; cached: number }>();
	const story: SessionStory = {
		startedAt: null, endedAt: null, activeMinutes: 0, prompts: [], promptCount: 0, files: [], commands: 0, toolCalls: 0,
		added: 0, removed: 0, tokens: { input: 0, output: 0, cached: 0 }, costUSD: null, branches: [], recent: [], spans: []
	};
	/** What each run of Claude Code on this session says it cost so far. A resumed session has several runs. */
	const costs = new Map<number, number>();
	let lastAt: number | null = null;

	/** `idle` is how long a silence may be and still count as being at it. */
	function tick(at: string | undefined, idle = IDLE_MS) {
		const t = at ? Date.parse(at) : NaN;
		if (Number.isNaN(t)) return;
		story.startedAt ??= at!;
		story.endedAt = at!;
		const span = story.spans.at(-1);
		if (lastAt === null || !span || t - lastAt > idle) story.spans.push([t, t]);
		else if (t > lastAt) span[1] = t;
		lastAt = Math.max(lastAt ?? t, t);
	}

	function tool(block: Block, at: string | undefined) {
		const name = str(block.name);
		const input = block.input && typeof block.input === 'object' ? block.input : {};
		story.toolCalls++;
		if (name === 'Bash') story.commands++;
		if (EDITS.has(name)) {
			const path = relative(str(input.file_path) || str(input.notebook_path), cwd);
			if (path) {
				const seen = files.get(path);
				// a file first touched by writing it whole was most likely made by this session
				files.set(path, { edits: (seen?.edits ?? 0) + 1, created: seen ? seen.created : name === 'Write' });
			}
			if (name === 'Write') story.added += lines(input.content);
			else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
				for (const e of input.edits as Input[]) {
					story.removed += lines(e?.old_string);
					story.added += lines(e?.new_string);
				}
			} else {
				story.removed += lines(input.old_string);
				story.added += lines(input.new_string ?? input.new_source);
			}
		}
		const text = describeAction(name, input, cwd);
		if (text) {
			story.recent.push({ at: at ?? null, tool: name, text } satisfies Action);
			if (story.recent.length > ACTIONS_KEPT) story.recent.shift();
		}
	}

	return {
		add(line: string) {
			// Tool results are most of the file. All this needs from one is when it came back,
			// which is the last timestamp on the line: the entry's own fields follow its message.
			if (line.includes('"type":"tool_result"')) {
				const at = line.lastIndexOf('"timestamp":"');
				if (at >= 0) tick(line.slice(at + 13, at + 37), TOOL_WAIT_MS);
				return;
			}
			if (!line.includes('"timestamp"') && !line.includes('"type":"cost-state"')) return;
			let entry: Entry;
			try {
				entry = JSON.parse(line);
			} catch {
				return;
			}
			if (entry.type === 'cost-state') {
				// the total restarts with every run of Claude Code: keep the highest of each run
				const run = typeof entry.startTime === 'number' ? entry.startTime : 0;
				if (typeof entry.totalCostUSD === 'number') costs.set(run, Math.max(costs.get(run) ?? 0, entry.totalCostUSD));
				return;
			}
			// a sub-agent's lines belong to its own transcript, and only to that
			if (!!entry.isSidechain !== agent) return;
			if (entry.type !== 'assistant' && entry.type !== 'user') return;
			tick(entry.timestamp);
			const branch = str(entry.gitBranch);
			if (!agent && branch && branch !== 'HEAD' && branch !== story.branches.at(-1)) story.branches.push(branch);

			if (entry.type === 'user') {
				if (agent || entry.isMeta || entry.isCompactSummary) return;
				if (entry.origin?.kind && entry.origin.kind !== 'human') return;
				const text = typed(entry);
				if (!text) return;
				story.promptCount++;
				story.prompts.push({ at: entry.timestamp ?? null, text: clip(text, PROMPT_MAX) });
				// keep the first one and the latest ones
				if (story.prompts.length > PROMPTS_KEPT) story.prompts.splice(1, 1);
				return;
			}

			const message = entry.message;
			if (Array.isArray(message?.content)) for (const block of message.content) if (block?.type === 'tool_use') tool(block, entry.timestamp);
			// one reply is written as several lines, each repeating its token count: count it once
			const u = message?.usage;
			if (message?.id && u) {
				const n = (key: string) => (typeof u[key] === 'number' ? (u[key] as number) : 0);
				usage.set(message.id, { input: n('input_tokens') + n('cache_creation_input_tokens'), output: n('output_tokens'), cached: n('cache_read_input_tokens') });
			}
		},
		done(): SessionStory {
			// from the stretches, rounded the way they are kept and drawn, so every number
			// made from them (S-84, S-88, S-89) says the same
			story.activeMinutes = minutesOf(story.spans);
			if (costs.size) story.costUSD = [...costs.values()].reduce((sum, c) => sum + c, 0);
			story.files = [...files].map(([path, f]) => ({ path, ...f })).sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path));
			for (const u of usage.values()) {
				story.tokens.input += u.input;
				story.tokens.output += u.output;
				story.tokens.cached += u.cached;
			}
			return story;
		}
	};
}

export function storyFrom(lines: Iterable<string>, cwd: string): SessionStory {
	const reader = storyReader(cwd);
	for (const line of lines) reader.add(line);
	return reader.done();
}

/**
 * A session's story with its sub-agents' added in: the files they edited, what they ran and
 * used, and the time they were at it while the session itself was waiting for them.
 */
export function withAgents(story: SessionStory, agents: SessionStory[]): SessionStory {
	if (!agents.length) return story;
	const files = new Map(story.files.map((f) => [f.path, { ...f }]));
	for (const f of agents.flatMap((a) => a.files)) {
		const seen = files.get(f.path);
		if (seen) seen.edits += f.edits;
		else files.set(f.path, { ...f });
	}
	// Stretches of the session and its sub-agents overlap: time counts once. A short silence
	// between one and the next is bridged, the same as inside a single transcript.
	const spans: [number, number][] = [];
	for (const [from, to] of [story, ...agents].flatMap((a) => a.spans).sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
		const last = spans.at(-1);
		if (last && from - last[1] <= IDLE_MS) last[1] = Math.max(last[1], to);
		else spans.push([from, to]);
	}
	const sum = (pick: (s: SessionStory) => number) => agents.reduce((n, a) => n + pick(a), pick(story));
	return {
		...story,
		files: [...files.values()].sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path)),
		commands: sum((s) => s.commands),
		toolCalls: sum((s) => s.toolCalls),
		added: sum((s) => s.added),
		removed: sum((s) => s.removed),
		tokens: { input: sum((s) => s.tokens.input), output: sum((s) => s.tokens.output), cached: sum((s) => s.tokens.cached) },
		spans,
		activeMinutes: minutesOf(spans)
	};
}
