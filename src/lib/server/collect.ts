import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { Snapshot } from '../model';
import { config } from './config';
import { demoSnapshot } from './demo';
import { fetchPullRequests, githubToken } from './github';
import { fetchIssues } from './linear';
import { fetchRelay, type RelayState } from './relay';
import { collectSessions, listSessions } from './sessions';

/**
 * Reads all three sources. A source that fails becomes a warning, not an error (S-64).
 * With no Linear key there is nothing to read yet: the screen shows first-run setup.
 * Demo data is only shown when asked for (S-63).
 */
export async function collect(now = Date.now(), demo = false): Promise<Snapshot> {
	if (demo) return demoSnapshot(now);
	const cfg = await config();
	if (cfg.snapshotFile) {
		const saved: Snapshot = JSON.parse(await readFile(cfg.snapshotFile, 'utf8'));
		// a relay still counts: it is how a saved snapshot is tried together with live cloud sessions
		const cloud = await relayState(cfg, now).catch(() => ({ sessions: [], notes: [] }) as RelayState);
		return cloud.sessions.length || cloud.notes.length ? { ...saved, sessions: [...saved.sessions, ...cloud.sessions], notes: cloud.notes } : saved;
	}
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
	const [issues, prs, sessions, cloud] = await Promise.all([
		guard('Linear', recent(`linear ${linearKey} ${linearTeam}`, () => fetchIssues(linearKey, linearTeam))),
		guard('GitHub', recent(`github ${cfg.githubToken} ${githubRepos}`, () => githubToken(cfg.githubToken).then((token) => fetchPullRequests(githubRepos, token)))),
		guard('Claude Code', collectSessions(cfg.home)),
		// S-91: what sessions in the cloud reported about themselves, if a relay is set up
		relayState(cfg, now).catch((e: Error) => {
			warnings.push(`Cloud sessions: ${e.message}`);
			return { sessions: [], notes: [] } as RelayState;
		})
	]);
	return { fetchedAt: new Date(now).toISOString(), demo: false, warnings, issues, prs, sessions: [...sessions, ...cloud.sessions], notes: cloud.notes };
}

/** How long an answer from the relay is reused: the follower asks every few seconds, the page with it. */
const RELAY_REUSE_MS = 5000;
let relayAnswer: { key: string; at: number; value: Promise<RelayState> } | null = null;

/** The relay's state, or nothing when none is set up. Two askers at the same moment share one request. */
export function relayState(cfg: { relayUrl: string | null; relayToken: string | null }, now = Date.now()): Promise<RelayState> {
	if (!cfg.relayUrl || !cfg.relayToken) return Promise.resolve({ sessions: [], notes: [] });
	const key = `${cfg.relayUrl} ${cfg.relayToken}`;
	if (relayAnswer && relayAnswer.key === key && now - relayAnswer.at < RELAY_REUSE_MS) return relayAnswer.value;
	const asked = { key, at: now, value: fetchRelay(cfg.relayUrl, cfg.relayToken, now) };
	relayAnswer = asked;
	// a failure is not kept: the next asker tries again
	asked.value.catch(() => relayAnswer === asked && (relayAnswer = null));
	return asked.value;
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
	const mark = (sessions: { id: string; state: string; waitingFor: string | null }[]) => sessions.map((s) => `${s.id}:${s.state}:${s.waitingFor ?? ''}`).sort().join('|');
	let beat = '';
	if (cfg.snapshotFile) beat = await stat(cfg.snapshotFile).then((s) => String(s.mtimeMs), () => '');
	// a failure is passed on: "no sessions" would read as every session having ended
	else if (cfg.linearKey) beat = mark(await listSessions());
	// Sessions in the cloud change state too (S-91). A relay that cannot be reached changes nothing.
	beat += `|${mark(await relayState(cfg).then((r) => r.sessions, () => []))}`;
	return createHash('sha1').update(beat).digest('hex').slice(0, 16);
}
