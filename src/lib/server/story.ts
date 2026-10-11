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
export function actionsFrom(line: string, cwd: string): Action[] {
	if (line.includes('"type":"tool_result"')) return [];
	if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) return [];
	let entry: Entry;
	try {
		entry = JSON.parse(line);
	} catch {
		return [];
	}
	if (entry.isSidechain || (entry.type !== 'assistant' && entry.type !== 'user')) return [];
	const at = entry.timestamp ?? null;
	if (entry.type === 'user') {
		if (entry.isMeta || entry.isCompactSummary || (entry.origin?.kind && entry.origin.kind !== 'human')) return [];
		const text = typed(entry);
		return text ? [{ at, tool: 'you', text: oneLine(text, 120) }] : [];
	}
	const out: Action[] = [];
	const content = entry.message?.content;
	for (const block of Array.isArray(content) ? content : []) {
		if (block?.type === 'text' && block.text?.trim()) out.push({ at, tool: 'says', text: oneLine(block.text, 120) });
		else if (block?.type === 'tool_use') {
			const text = describeAction(str(block.name), block.input && typeof block.input === 'object' ? block.input : {}, cwd);
			if (text) out.push({ at, tool: str(block.name), text });
		}
	}
	return out;
}

/** Takes a transcript one line at a time. `cwd` is the session's folder, for short paths. */
export function storyReader(cwd: string) {
	const files = new Map<string, { edits: number; created: boolean }>();
	const usage = new Map<string, { input: number; output: number; cached: number }>();
	const story: SessionStory = {
		startedAt: null, endedAt: null, activeMinutes: 0, prompts: [], promptCount: 0, files: [], commands: 0, toolCalls: 0,
		added: 0, removed: 0, tokens: { input: 0, output: 0, cached: 0 }, costUSD: null, branches: [], recent: []
	};
	let activeMs = 0;
	let lastAt: number | null = null;

	function tick(at: string | undefined) {
		const t = at ? Date.parse(at) : NaN;
		if (Number.isNaN(t)) return;
		story.startedAt ??= at!;
		story.endedAt = at!;
		if (lastAt !== null && t > lastAt && t - lastAt <= IDLE_MS) activeMs += t - lastAt;
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
				if (at >= 0) tick(line.slice(at + 13, at + 37));
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
				if (typeof entry.totalCostUSD === 'number') story.costUSD = entry.totalCostUSD;
				return;
			}
			if (entry.isSidechain) return;
			if (entry.type !== 'assistant' && entry.type !== 'user') return;
			tick(entry.timestamp);
			const branch = str(entry.gitBranch);
			if (branch && branch !== 'HEAD' && branch !== story.branches.at(-1)) story.branches.push(branch);

			if (entry.type === 'user') {
				if (entry.isMeta || entry.isCompactSummary) return;
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
			story.activeMinutes = Math.round(activeMs / 60_000);
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
