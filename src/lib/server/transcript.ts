import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionNote } from '../model';
import { storyReader, withAgents } from './story';

/**
 * Claude Code keeps one transcript per session: a .jsonl file with one entry per line.
 * This reads what wtfwid needs from it and nothing else (S-55). Read-only, like every source.
 * The entry shapes below are what Claude Code 2.1.296 writes; they are not a documented format,
 * so everything here treats a line it does not understand as not there.
 */

/** Where Claude Code keeps its files. */
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

const PROMPT_MAX = 400;
const REPLY_MAX = 1200;

function clip(text: string, max: number): string {
	const tidy = text.trim().replace(/\n{3,}/g, '\n\n');
	return tidy.length > max ? tidy.slice(0, max - 1).trimEnd() + '…' : tidy;
}

type Block = { type?: string; text?: string };
type Entry = {
	type?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	isCompactSummary?: boolean;
	/** Who a user entry came from. Absent in older transcripts. */
	origin?: { kind?: string };
	timestamp?: string;
	message?: { content?: string | Block[] };
	lastPrompt?: string;
	prNumber?: number;
	prUrl?: string;
	prRepository?: string;
};

/** The text of a message, leaving out tool calls, tool results and thinking. */
function textOf(entry: Entry): string {
	const content = entry.message?.content;
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((b) => b?.type === 'text' && typeof b.text === 'string')
		.map((b) => b.text)
		.join('\n\n');
}

/**
 * Text that Claude Code put into a message itself arrives as whole elements at its start:
 * a reminder, a command, a notification. This takes those off and leaves what was typed.
 * A prompt that merely begins with "<" ("<div> does not center") has no matching close and stays.
 */
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

/** What the person typed in a user message, or '' when all of it was put there by Claude Code. */
function typedText(entry: Entry): string {
	const content = entry.message?.content;
	const blocks = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string) : [];
	return blocks.map(withoutInjected).filter(Boolean).join('\n\n');
}

/** A branch name worth showing: not empty, and not a detached HEAD. */
const branchOf = (value: unknown) => (typeof value === 'string' && value && value !== 'HEAD' ? value : null);

/** Takes a transcript one line at a time, so a long one never has to be in memory at once. */
export function noteReader() {
	const note: SessionNote = { firstPrompt: null, lastPrompt: null, lastReply: null, at: null, prs: [] };

	return {
		add(line: string) {
			// Most lines are tool calls and their results, which can be megabytes. Skip them unparsed.
			if (line.includes('"type":"tool_result"')) return;
			const wanted =
				line.includes('"type":"pr-link"') ||
				line.includes('"type":"last-prompt"') ||
				line.includes('"type":"user"') ||
				(line.includes('"type":"assistant"') && line.includes('"type":"text"'));
			if (!wanted) return;

			let entry: Entry;
			try {
				entry = JSON.parse(line);
			} catch {
				return; // a line still being written
			}
			if (entry.isSidechain) return; // a sub-agent's conversation, not the session's

			if (entry.type === 'pr-link') {
				if (typeof entry.prUrl !== 'string' || typeof entry.prNumber !== 'number' || note.prs.some((p) => p.url === entry.prUrl)) return;
				note.prs.push({ repo: String(entry.prRepository ?? ''), number: entry.prNumber, url: entry.prUrl });
			} else if (entry.type === 'last-prompt') {
				// Claude Code writes this a few entries after the prompt itself; whichever came last in the file stands
				if (typeof entry.lastPrompt === 'string' && entry.lastPrompt.trim()) note.lastPrompt = clip(entry.lastPrompt, PROMPT_MAX);
			} else if (entry.type === 'assistant') {
				const text = textOf(entry);
				if (!text.trim()) return;
				note.lastReply = clip(text, REPLY_MAX);
				note.at = entry.timestamp ?? note.at;
			} else if (entry.type === 'user') {
				if (entry.isMeta || entry.isCompactSummary) return;
				if (entry.origin?.kind && entry.origin.kind !== 'human') return; // a notification, not a person
				const text = typedText(entry);
				if (!text) return;
				note.lastPrompt = clip(text, PROMPT_MAX);
				note.firstPrompt ??= note.lastPrompt;
			}
		},
		done(): SessionNote {
			return note;
		}
	};
}

export function noteFrom(lines: Iterable<string>): SessionNote {
	const reader = noteReader();
	for (const line of lines) reader.add(line);
	return reader.done();
}

/**
 * The transcript of a session, or null when it is not on this machine (any more).
 * A session that changed folder has one file per folder; the one written to last is its current one.
 */
export async function findTranscript(id: string, cwd: string, root = claudeHome()): Promise<string | null> {
	if (!/^[\w-]{6,80}$/.test(id)) return null;
	const projects = join(root, 'projects');
	// Claude Code names the folder after the working directory, with everything but letters and digits as "-".
	const folders = new Set([cwd.replace(/[^a-zA-Z0-9]/g, '-'), ...(await readdir(projects).catch(() => [] as string[]))]);
	let newest: { file: string; at: number } | null = null;
	for (const folder of folders) {
		const file = join(projects, folder, `${id}.jsonl`);
		const info = await stat(file).catch(() => null);
		if (info?.isFile() && (!newest || info.mtimeMs > newest.at)) newest = { file, at: info.mtimeMs };
	}
	return newest?.file ?? null;
}

const cache = new Map<string, { stamp: string; note: SessionNote }>();

/**
 * The transcripts of a session's sub-agents. Claude Code keeps them beside the session's
 * own: `<session id>/subagents/agent-<id>.jsonl`.
 */
export async function agentTranscripts(file: string): Promise<{ file: string; stamp: string }[]> {
	const dir = join(file.replace(/\.jsonl$/, ''), 'subagents');
	const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^agent-[\w-]+\.jsonl$/.test(n)).sort();
	const found = await Promise.all(names.map((n) => stat(join(dir, n)).then((info) => ({ file: join(dir, n), stamp: `${info.mtimeMs}:${info.size}` }), () => null)));
	return found.filter((f): f is { file: string; stamp: string } => f !== null);
}

const lines = (file: string) => createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });

/**
 * Reads a transcript: the note, and the story of what the session did, its sub-agents
 * included. One pass over each file. Reads again only when one of them has changed.
 * `cwd` shortens the paths.
 */
export async function readNote(file: string, cwd = ''): Promise<SessionNote> {
	const s = await stat(file);
	const agents = await agentTranscripts(file);
	const stamp = `${s.mtimeMs}:${s.size}:${cwd}:${agents.map((a) => a.stamp).join(',')}`;
	const cached = cache.get(file);
	if (cached?.stamp === stamp) return cached.note;

	const reader = noteReader();
	const story = storyReader(cwd);
	for await (const line of lines(file)) {
		reader.add(line);
		story.add(line);
	}
	const theirs = [];
	for (const agent of agents) {
		const side = storyReader(cwd, true);
		// one that cannot be read is left out; the session's own story still stands
		try {
			for await (const line of lines(agent.file)) side.add(line);
			theirs.push(side.done());
		} catch {
			// gone since it was listed
		}
	}
	const note = { ...reader.done(), story: withAgents(story.done(), theirs) };
	cache.set(file, { stamp, note });
	// keep the most recently read ones; a note is small but a year of sessions is many
	if (cache.size > 300) cache.delete(cache.keys().next().value!);
	return note;
}

/**
 * The git branch a session was last on, from the end of its transcript.
 * Cheap enough to do for every live session on every refresh (S-50).
 */
export async function lastBranch(file: string, bytes = 256 * 1024): Promise<string | null> {
	const handle = await open(file, 'r');
	try {
		const { size } = await handle.stat();
		const length = Math.min(size, bytes);
		const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
		const all = [...buffer.toString('utf8').matchAll(/"gitBranch":"((?:[^"\\]|\\.)*)"/g)];
		const last = all.at(-1)?.[1];
		return last === undefined ? null : branchOf(JSON.parse(`"${last}"`));
	} finally {
		await handle.close();
	}
}

/**
 * The branches a session was on, in order, each time it changed. More than one means the
 * session moved: it started on one piece of work and went on to another.
 */
export async function branchHistory(file: string): Promise<string[]> {
	const seen: string[] = [];
	for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) {
		// the field sits outside the message, so the last one on a line is the entry's own
		const at = line.lastIndexOf('"gitBranch":"');
		if (at < 0) continue;
		const raw = /^"gitBranch":"((?:[^"\\]|\\.)*)"/.exec(line.slice(at, at + 400))?.[1];
		if (raw === undefined) continue;
		let branch: string | null = null;
		try {
			branch = branchOf(JSON.parse(`"${raw}"`));
		} catch {
			// not a string we can read
		}
		if (branch && branch !== seen.at(-1)) seen.push(branch);
	}
	return seen;
}
