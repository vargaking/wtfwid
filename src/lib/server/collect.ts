import { readFile } from 'node:fs/promises';
import type { Snapshot } from '../model';
import { config } from './config';
import { demoSnapshot } from './demo';
import { fetchPullRequests, githubToken } from './github';
import { fetchIssues } from './linear';
import { collectSessions } from './sessions';

/**
 * Reads all three sources. A source that fails becomes a warning, not an error (S-64).
 * With no Linear key there is nothing to read yet: the screen shows first-run setup.
 * Demo data is only shown when asked for (S-63).
 */
export async function collect(now = Date.now(), demo = false): Promise<Snapshot> {
	if (demo) return demoSnapshot(now);
	const cfg = await config();
	if (cfg.snapshotFile) return JSON.parse(await readFile(cfg.snapshotFile, 'utf8'));
	if (!cfg.linearKey) {
		return { fetchedAt: new Date(now).toISOString(), demo: false, setup: true, warnings: [], issues: [], prs: [], sessions: [] };
	}

	const warnings: string[] = [];
	const guard = <T>(source: string, job: Promise<T[]>): Promise<T[]> =>
		job.catch((e: Error) => {
			warnings.push(`${source}: ${e.message}`);
			return [];
		});

	const [issues, prs, sessions] = await Promise.all([
		guard('Linear', fetchIssues(cfg.linearKey, cfg.linearTeam)),
		guard('GitHub', githubToken(cfg.githubToken).then((token) => fetchPullRequests(cfg.githubRepos, token))),
		guard('Claude Code', collectSessions(cfg.home))
	]);
	return { fetchedAt: new Date(now).toISOString(), demo: false, warnings, issues, prs, sessions };
}
