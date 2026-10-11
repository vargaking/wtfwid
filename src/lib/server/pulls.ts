import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PullDigest, PullRequest } from '../model';
import { pullKey } from '../relations';
import { fetchPullDigest, RateLimited } from './github';

/**
 * Keeps what was read of each pull request (S-56, S-90): the files it changes, its commits
 * and the sessions that made them. The list of pull requests says none of that, so each one
 * costs two more requests; they are made once, again only when GitHub says the pull request
 * changed, a few at a time, and the answers are kept in `~/.wtfwid/pulls.json`.
 */

/** How long one question may wait for GitHub. The rest is read afterwards. */
const BUDGET_MS = 1000;
/** Pull requests read in one go. The next refresh carries on, so a long history arrives in a few rounds. */
const PER_PASS = 80;
/** Requests to GitHub at the same time. */
const AT_ONCE = 4;
/** A pull request that could not be read is left alone for this long. */
const RETRY_MS = 30 * 60_000;
/** After GitHub says to slow down, nothing is asked for this long. */
const PAUSE_MS = 15 * 60_000;
const VERSION = 1;

export interface PullIndexOptions {
	budgetMs?: number;
	perPass?: number;
	now?: () => number;
	/** Reads one pull request. Tests count the calls. */
	read?: (pr: PullRequest, token: string | null, now: number) => Promise<PullDigest>;
}

export function createPullIndex(home: string, options: PullIndexOptions = {}) {
	const file = join(home, 'pulls.json');
	const now = options.now ?? Date.now;
	const read = options.read ?? ((pr: PullRequest, token: string | null, at: number) => fetchPullDigest(pr, token, at));
	let known: Promise<Map<string, PullDigest>> | null = null;
	let busy = false;
	let behind: Promise<void> | null = null;
	let pausedUntil = 0;
	const failed = new Map<string, number>();

	const load = () =>
		(known ??= readFile(file, 'utf8')
			.then(JSON.parse)
			.catch(() => null)
			.then((stored: { version?: number; pulls?: Record<string, PullDigest> } | null) => {
				const pulls = stored?.version === VERSION && stored.pulls && typeof stored.pulls === 'object' ? stored.pulls : {};
				return new Map(Object.entries(pulls));
			}));

	async function save(all: Map<string, PullDigest>) {
		await mkdir(home, { recursive: true });
		const draft = `${file}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(draft, JSON.stringify({ version: VERSION, pulls: Object.fromEntries(all) }), { mode: 0o600 });
		await chmod(draft, 0o600).catch(() => {});
		await rename(draft, file);
	}

	/**
	 * What is known of these pull requests, by `owner/repo#number`. The ones that are new or
	 * have changed are read, most recently changed first: for a short while before answering,
	 * the rest afterwards, and `onMore` is called when more is in.
	 */
	async function digests(prs: PullRequest[], token: string | null, onMore?: () => void): Promise<Record<string, PullDigest>> {
		const all = await load();
		const answer = () => Object.fromEntries(prs.flatMap((p) => (all.has(pullKey(p)) ? [[pullKey(p), all.get(pullKey(p))!] as const] : [])));
		if (busy || now() < pausedUntil) return answer();
		busy = true;
		let handedOver = false;
		try {
			const stale = prs
				.filter((p) => {
					const key = pullKey(p);
					if (now() - (failed.get(key) ?? -Infinity) < RETRY_MS) return false;
					return all.get(key)?.stamp !== (p.updatedAt ?? '');
				})
				.sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
				.slice(0, options.perPass ?? PER_PASS);
			if (!stale.length) return answer();

			let changed = false;
			let stopped = false;
			let next = 0;
			const readOne = async (pr: PullRequest) => {
				try {
					all.set(pullKey(pr), await read(pr, token, now()));
					changed = true;
				} catch (error) {
					if (error instanceof RateLimited) {
						pausedUntil = now() + PAUSE_MS;
						stopped = true;
					} else failed.set(pullKey(pr), now());
				}
			};
			/** Reads the next ones, a few at a time, until `until` says stop or there are none left. */
			const run = async (until: () => boolean) => {
				const worker = async () => {
					while (next < stale.length && !stopped && !until()) await readOne(stale[next++]);
				};
				await Promise.all(Array.from({ length: AT_ONCE }, worker));
			};

			const started = now();
			const budget = options.budgetMs ?? BUDGET_MS;
			await run(() => now() - started >= budget);
			if (next >= stale.length || stopped) {
				if (changed) await save(all).catch(() => {});
				return answer();
			}

			handedOver = true;
			const before = changed;
			changed = false;
			behind = (async () => {
				try {
					await run(() => false);
					if (changed || before) await save(all).catch(() => {});
				} finally {
					busy = false;
					behind = null;
				}
				// only when there is something new to show: a round that read nothing must not ask for another
				if (changed) onMore?.();
			})();
			behind.catch(() => {});
			return answer();
		} finally {
			if (!handedOver) busy = false;
		}
	}

	return {
		digests,
		/** Resolves when nothing is being read in the background. For tests. */
		settled: () => behind ?? Promise.resolve()
	};
}

type PullIndex = ReturnType<typeof createPullIndex>;
const slot = globalThis as { __wtfwidPulls?: { home: string; index: PullIndex } };

/** The one index of this process, for the folder wtfwid keeps its files in. */
export function pullIndex(home: string): PullIndex {
	if (slot.__wtfwidPulls?.home !== home) slot.__wtfwidPulls = { home, index: createPullIndex(home) };
	return slot.__wtfwidPulls.index;
}
