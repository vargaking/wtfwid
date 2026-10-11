import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PullDigest, PullRequest } from '../model';

const run = promisify(execFile);
const PAGES = 3; // S-61: the latest 300 pull requests per repository

/** Where GitHub's API is. Another address only to try wtfwid against a stand-in while developing. */
export const githubApi = () => (process.env.WTFWID_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');

const SESSION_LINK = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g;

/** The links to Claude Code sessions in a text, each once, in the order they appear (S-90). */
export function sessionLinks(text: unknown): string[] {
	return typeof text === 'string' ? [...new Set(text.match(SESSION_LINK) ?? [])] : [];
}

export function toPullRequest(repo: string, p: any): PullRequest {
	const sessions = sessionLinks(p.body);
	return {
		repo,
		number: p.number,
		title: p.title,
		url: p.html_url,
		branch: p.head?.ref ?? '',
		state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : p.draft ? 'draft' : 'open',
		createdAt: p.created_at,
		...(typeof p.updated_at === 'string' && { updatedAt: p.updated_at }),
		...(sessions.length && { sessions })
	};
}

/** Uses the token from the environment, else the one the GitHub CLI is logged in with. */
export async function githubToken(fromEnv: string | null): Promise<string | null> {
	if (fromEnv) return fromEnv;
	try {
		return (await run('gh', ['auth', 'token'], { timeout: 5000 })).stdout.trim() || null;
	} catch {
		return null;
	}
}

export async function fetchPullRequests(repos: string[], token: string | null, fetcher: typeof fetch = fetch): Promise<PullRequest[]> {
	const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'wtfwid' };
	if (token) headers.Authorization = `Bearer ${token}`;
	const prs: PullRequest[] = [];
	for (const repo of repos) {
		for (let page = 1; page <= PAGES; page++) {
			const url = `${githubApi()}/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`;
			const res = await fetcher(url, { headers });
			if (!res.ok) throw new Error(`${repo}: HTTP ${res.status}`);
			const batch: any[] = await res.json();
			prs.push(...batch.map((p) => toPullRequest(repo, p)));
			if (batch.length < 100) break;
		}
	}
	return prs;
}

/** At most this many files are kept per pull request: the ones it changes most. */
const FILES_KEPT = 150;
/** GitHub lists at most 3000 files and 250 commits of a pull request; this reads up to 300 of each. */
const DETAIL_PAGES = 3;

/** GitHub said no for a reason that will pass: asking again right away would only make it worse. */
export class RateLimited extends Error {}

async function pages(url: string, headers: Record<string, string>, fetcher: typeof fetch): Promise<any[]> {
	const all: any[] = [];
	for (let page = 1; page <= DETAIL_PAGES; page++) {
		const res = await fetcher(`${url}?per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(15_000) });
		if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) throw new RateLimited('GitHub asked wtfwid to slow down');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const batch: unknown = await res.json();
		if (!Array.isArray(batch)) break;
		all.push(...batch);
		if (batch.length < 100) break;
	}
	return all;
}

/**
 * The files a pull request changes and its commits (S-56, S-90). Two requests for most pull
 * requests. Only reads: nothing is ever written to GitHub (S-03).
 */
export async function fetchPullDigest(pr: Pick<PullRequest, 'repo' | 'number' | 'updatedAt'>, token: string | null, now: number, fetcher: typeof fetch = fetch): Promise<PullDigest> {
	const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'wtfwid' };
	if (token) headers.Authorization = `Bearer ${token}`;
	const base = `${githubApi()}/repos/${pr.repo}/pulls/${pr.number}`;
	const [files, commits] = await Promise.all([pages(`${base}/files`, headers, fetcher), pages(`${base}/commits`, headers, fetcher)]);

	const count = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
	const changed = files
		.filter((f) => typeof f?.filename === 'string')
		.map((f) => ({ path: f.filename as string, changes: count(f.changes), added: count(f.additions), removed: count(f.deletions) }));
	const sessions: string[] = [];
	const made: [number, number][] = [];
	for (const c of commits) {
		const at = Date.parse(c?.commit?.author?.date ?? c?.commit?.committer?.date ?? '');
		if (Number.isNaN(at)) continue;
		// the trailer Claude Code writes; the last link in the message if there are several
		const link = sessionLinks(c.commit.message).at(-1);
		if (link && !sessions.includes(link)) sessions.push(link);
		made.push([Math.round(at / 60_000), link ? sessions.indexOf(link) : -1]);
	}
	return {
		stamp: pr.updatedAt ?? '',
		readAt: now,
		files: changed
			.sort((a, b) => b.changes - a.changes || a.path.localeCompare(b.path))
			.slice(0, FILES_KEPT)
			.map(({ path, changes }) => ({ path, changes })),
		added: changed.reduce((sum, f) => sum + f.added, 0),
		removed: changed.reduce((sum, f) => sum + f.removed, 0),
		commits: made.sort((a, b) => a[0] - b[0]),
		sessions
	};
}
