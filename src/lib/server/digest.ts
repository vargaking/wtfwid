import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Digest, Session, SessionStory } from '../model';
import { checkoutOf, mergeSpans } from '../relations';
import { claudeHome, readNote } from './transcript';

/**
 * Keeps a short digest of every session wtfwid has read (S-86): the files it changed, the
 * branches it was on and when it was at it. Reading a transcript takes a moment and Claude
 * Code deletes transcripts after a few weeks, so each one is read once, when it is new or
 * has changed, and what was learned is kept in `~/.wtfwid/index.json` for good.
 */

/** At most this many files are kept per session: the ones it edited most. */
const FILES_KEPT = 150;
/** A running session writes all the time. Its digest is read again at most this often. */
const LIVE_REREAD_MS = 2 * 60_000;
/** How long one question may wait for transcripts to be read. The rest is read afterwards. */
const BUDGET_MS = 1200;
const VERSION = 1;

const TRANSCRIPT = /^([\w-]{6,80})\.jsonl$/;

export function digestOf(story: SessionStory, cwd: string, stamp: string, now: number): Digest {
	const minute = (ms: number) => Math.round(ms / 60_000);
	const spans = story.spans.map(([from, to]): [number, number] => [minute(from), minute(to)]);
	return {
		stamp,
		readAt: now,
		root: checkoutOf(cwd),
		files: story.files.slice(0, FILES_KEPT).map((f) => ({ path: f.path, edits: f.edits })),
		branches: story.branches,
		spans,
		// counted from the stretches, so it stays right when readings are merged
		minutes: spans.reduce((sum, [from, to]) => sum + to - from, 0),
		added: story.added,
		removed: story.removed,
		tokens: story.tokens.input + story.tokens.output,
		costUSD: story.costUSD
	};
}

/** `later` joined onto `earlier`, where the end of one is the start of the other. */
function joined(earlier: string[], later: string[]): string[] {
	for (let overlap = Math.min(earlier.length, later.length); overlap > 0; overlap--) {
		if (later.slice(0, overlap).every((b, i) => b === earlier[earlier.length - overlap + i])) return [...earlier, ...later.slice(overlap)];
	}
	return [...earlier, ...later];
}

/**
 * What is known of a session after reading its transcript again. Claude Code rewrites a
 * transcript shorter when it compacts a long conversation, so a later reading can hold
 * less than an earlier one did: nothing that was known is dropped. Time is the union of
 * both readings. A file keeps its higher count, and the totals their higher value: where
 * the two readings overlap cannot be told, so this may count low, never double.
 */
export function mergeDigest(had: Digest | undefined, fresh: Digest): Digest {
	if (!had) return fresh;
	const files = new Map(had.files.map((f) => [f.path, f.edits]));
	for (const f of fresh.files) files.set(f.path, Math.max(files.get(f.path) ?? 0, f.edits));
	const spans = mergeSpans([...had.spans, ...fresh.spans]);
	return {
		...fresh,
		files: [...files]
			.map(([path, edits]) => ({ path, edits }))
			.sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path))
			.slice(0, FILES_KEPT),
		branches: joined(had.branches, fresh.branches),
		spans,
		minutes: spans.reduce((sum, [from, to]) => sum + to - from, 0),
		added: Math.max(had.added, fresh.added),
		removed: Math.max(had.removed, fresh.removed),
		tokens: Math.max(had.tokens, fresh.tokens),
		costUSD: had.costUSD === null ? fresh.costUSD : fresh.costUSD === null ? had.costUSD : Math.max(had.costUSD, fresh.costUSD)
	};
}

/** Every transcript under `root`, by session id. A session that changed folder has several. */
async function transcripts(root: string): Promise<Map<string, string[]>> {
	const projects = join(root, 'projects');
	const found = new Map<string, string[]>();
	for (const folder of await readdir(projects).catch(() => [] as string[])) {
		for (const name of await readdir(join(projects, folder)).catch(() => [] as string[])) {
			const id = TRANSCRIPT.exec(name)?.[1];
			if (id) found.set(id, [...(found.get(id) ?? []), join(projects, folder, name)]);
		}
	}
	return found;
}

/** The file of a session that was written to last, with its stamp. */
async function newest(files: string[]): Promise<{ file: string; stamp: string } | null> {
	let best: { file: string; stamp: string; at: number } | null = null;
	for (const file of files) {
		const info = await stat(file).catch(() => null);
		if (info?.isFile() && info.size && (!best || info.mtimeMs > best.at)) best = { file, stamp: `${info.mtimeMs}:${info.size}`, at: info.mtimeMs };
	}
	return best;
}

export interface IndexOptions {
	/** Where Claude Code keeps its files; tests point it somewhere else. */
	claude?: string;
	budgetMs?: number;
	now?: () => number;
	/** Reads one transcript. Tests count the calls. */
	read?: (file: string, cwd: string) => Promise<SessionStory | undefined>;
}

export function createIndex(home: string, options: IndexOptions = {}) {
	const file = join(home, 'index.json');
	const now = options.now ?? Date.now;
	const read = options.read ?? ((path: string, cwd: string) => readNote(path, cwd).then((note) => note.story));
	let known: Map<string, Digest> | null = null;
	let behind: Promise<void> | null = null;

	async function load(): Promise<Map<string, Digest>> {
		if (known) return known;
		const stored: unknown = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
		const sessions = (stored as { version?: number; sessions?: Record<string, Digest> } | null)?.version === VERSION ? (stored as { sessions?: Record<string, Digest> }).sessions : null;
		// anything else (no file, an older shape, a broken file) just means reading again
		known = new Map(sessions && typeof sessions === 'object' ? Object.entries(sessions) : []);
		return known;
	}

	async function save(all: Map<string, Digest>) {
		await mkdir(home, { recursive: true });
		const draft = `${file}.${process.pid}.tmp`;
		// it names your files and folders: readable only by you, like the settings
		await writeFile(draft, JSON.stringify({ version: VERSION, sessions: Object.fromEntries(all) }), { mode: 0o600 });
		await chmod(draft, 0o600).catch(() => {});
		await rename(draft, file);
	}

	/**
	 * The digests of these sessions, by id. A transcript that is new or has changed is read
	 * first, for a short while; if there are more than fit, the answer comes back without
	 * them, they are read afterwards, and `onMore` is called when they are in.
	 */
	async function digests(sessions: Session[], onMore?: () => void): Promise<Record<string, Digest>> {
		const all = await load();
		const answer = () => Object.fromEntries(sessions.flatMap((s) => (all.has(s.id) ? [[s.id, all.get(s.id)!] as const] : [])));
		if (behind) return answer(); // still catching up from last time

		const onDisk = await transcripts(options.claude ?? claudeHome());
		const stale: { session: Session; file: string; stamp: string }[] = [];
		// newest work first: that is what is on screen
		for (const session of [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
			const files = onDisk.get(session.id);
			if (!files) continue; // its transcript is gone: what was read before stands
			const current = await newest(files);
			if (!current) continue;
			const had = all.get(session.id);
			if (had?.stamp === current.stamp) continue;
			if (had && !session.gone && now() - had.readAt < LIVE_REREAD_MS) continue;
			stale.push({ session, ...current });
		}
		if (!stale.length) return answer();

		const started = now();
		const budget = options.budgetMs ?? BUDGET_MS;
		let changed = false;
		const readOne = async (item: (typeof stale)[number]) => {
			const story = await read(item.file, item.session.cwd).catch(() => undefined);
			if (!story) return;
			all.set(item.session.id, mergeDigest(all.get(item.session.id), digestOf(story, item.session.cwd, item.stamp, now())));
			changed = true;
		};

		let next = 0;
		while (next < stale.length && now() - started < budget) await readOne(stale[next++]);
		const rest = stale.slice(next);
		if (!rest.length) {
			if (changed) await save(all).catch(() => {});
			return answer();
		}

		behind = (async () => {
			try {
				for (const item of rest) await readOne(item);
				if (changed) await save(all).catch(() => {});
			} finally {
				behind = null;
			}
			onMore?.();
		})();
		behind.catch(() => {});
		return answer();
	}

	return {
		digests,
		/** Resolves when nothing is being read in the background. For tests. */
		settled: () => behind ?? Promise.resolve()
	};
}

type Index = ReturnType<typeof createIndex>;
const slot = globalThis as { __wtfwidIndex?: { home: string; index: Index } };

/** The one index of this process, for the folder wtfwid keeps its files in. */
export function sessionIndex(home: string): Index {
	if (slot.__wtfwidIndex?.home !== home) slot.__wtfwidIndex = { home, index: createIndex(home) };
	return slot.__wtfwidIndex.index;
}
