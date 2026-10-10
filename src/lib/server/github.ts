import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PullRequest } from '../model';

const run = promisify(execFile);
const PAGES = 3; // S-61: the latest 300 pull requests per repository

export function toPullRequest(repo: string, p: any): PullRequest {
	return {
		repo,
		number: p.number,
		title: p.title,
		url: p.html_url,
		branch: p.head?.ref ?? '',
		state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : p.draft ? 'draft' : 'open',
		createdAt: p.created_at
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
			const url = `https://api.github.com/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`;
			const res = await fetcher(url, { headers });
			if (!res.ok) throw new Error(`${repo}: HTTP ${res.status}`);
			const batch: any[] = await res.json();
			prs.push(...batch.map((p) => toPullRequest(repo, p)));
			if (batch.length < 100) break;
		}
	}
	return prs;
}
