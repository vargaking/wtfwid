import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { Snapshot } from '../model';
import { config } from './config';
import { demoSnapshot } from './demo';
import { fetchPullRequests, githubToken } from './github';
import { fetchIssues } from './linear';
import { collectSessions, listSessions } from './sessions';

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

	const { linearKey, linearTeam, githubRepos } = cfg;
	const [issues, prs, sessions] = await Promise.all([
		guard('Linear', recent(`linear ${linearKey} ${linearTeam}`, () => fetchIssues(linearKey, linearTeam))),
		guard('GitHub', recent(`github ${cfg.githubToken} ${githubRepos}`, () => githubToken(cfg.githubToken).then((token) => fetchPullRequests(githubRepos, token)))),
		guard('Claude Code', collectSessions(cfg.home))
	]);
	return { fetchedAt: new Date(now).toISOString(), demo: false, warnings, issues, prs, sessions };
}

/** How long an answer from Linear or GitHub is reused. Shorter than the minute between full refreshes (S-65). */
const REUSE_MS = 45_000;
const answers = new Map<string, { at: number; value: Promise<unknown[]> }>();

/**
 * Runs `job`, or hands back its last answer if that is recent. A session changing state
 * makes the screen refresh at once (S-18); that should re-read the sessions, not ask
 * Linear and GitHub again every few seconds. The key holds the settings, so changing
 * them asks again. A failure is not kept.
 */
export function recent<T>(key: string, job: () => Promise<T[]>, now = Date.now()): Promise<T[]> {
	for (const [k, old] of answers) if (now - old.at >= REUSE_MS) answers.delete(k);
	const id = createHash('sha1').update(key).digest('hex');
	const hit = answers.get(id);
	if (hit) return hit.value as Promise<T[]>;
	const value = job();
	answers.set(id, { at: now, value });
	value.catch(() => answers.get(id)?.value === value && answers.delete(id));
	return value;
}

/**
 * A short value that changes when a session changes state (S-18). Cheap to ask for often:
 * it lists the local sessions and nothing else, so the screen can check every few seconds
 * and only read Linear and GitHub again when something moved.
 */
export async function pulse(): Promise<string> {
	const cfg = await config();
	let beat = '';
	if (cfg.snapshotFile) beat = await stat(cfg.snapshotFile).then((s) => String(s.mtimeMs), () => '');
	else if (cfg.linearKey) {
		// a failure is passed on: "no sessions" would read as every session having ended
		const sessions = await listSessions();
		beat = sessions.map((s) => `${s.id}:${s.state}:${s.waitingFor ?? ''}`).sort().join('|');
	}
	return createHash('sha1').update(beat).digest('hex').slice(0, 16);
}
