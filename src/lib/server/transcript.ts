import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionNote } from '../model';

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

/** A branch name worth showing: not empty, and not a detached HEAD. */
const branchOf = (value: unknown) => (typeof value === 'string' && value && value !== 'HEAD' ? value : null);

/** Takes a transcript one line at a time, so a long one never has to be in memory at once. */
export function noteReader() {
	const note: SessionNote = { firstPrompt: null, lastPrompt: null, lastReply: null, at: null, prs: [] };
	/** The last thing typed, for transcripts that carry no "last-prompt" entry. */
	let typed: string | null = null;
	let marked = false;

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
				if (typeof entry.lastPrompt === 'string' && entry.lastPrompt.trim()) {
					note.lastPrompt = clip(entry.lastPrompt, PROMPT_MAX);
					marked = true;
				}
			} else if (entry.type === 'assistant') {
				const text = textOf(entry);
				if (!text.trim()) return;
				note.lastReply = clip(text, REPLY_MAX);
				note.at = entry.timestamp ?? note.at;
			} else if (entry.type === 'user') {
				if (entry.isMeta || entry.isCompactSummary) return;
				const text = textOf(entry).trim();
				// Text that starts with a tag was put there by Claude Code (a command, a reminder), not typed.
				if (!text || text.startsWith('<')) return;
				typed = clip(text, PROMPT_MAX);
				note.firstPrompt ??= typed;
			}
		},
		done(): SessionNote {
			if (!marked) note.lastPrompt = typed;
			return note;
		}
	};
}

export function noteFrom(lines: Iterable<string>): SessionNote {
	const reader = noteReader();
	for (const line of lines) reader.add(line);
	return reader.done();
}

/** The transcript of a session, or null when it is not on this machine (any more). */
export async function findTranscript(id: string, cwd: string, root = claudeHome()): Promise<string | null> {
	if (!/^[\w-]{6,80}$/.test(id)) return null;
	const projects = join(root, 'projects');
	const exists = (file: string) => stat(file).then((s) => (s.isFile() ? file : null), () => null);
	// Claude Code names the folder after the working directory, with everything but letters and digits as "-".
	const direct = await exists(join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`));
	if (direct) return direct;
	for (const dir of await readdir(projects).catch(() => [] as string[])) {
		const hit = await exists(join(projects, dir, `${id}.jsonl`));
		if (hit) return hit;
	}
	return null;
}

const cache = new Map<string, { stamp: string; note: SessionNote }>();

/** Reads a transcript. Reads it again only when the file has changed. */
export async function readNote(file: string): Promise<SessionNote> {
	const s = await stat(file);
	const stamp = `${s.mtimeMs}:${s.size}`;
	const cached = cache.get(file);
	if (cached?.stamp === stamp) return cached.note;

	const reader = noteReader();
	for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) reader.add(line);
	const note = reader.done();
	cache.set(file, { stamp, note });
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
