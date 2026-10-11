import { buildGraph } from '../graph';
import type { Issue, PullRequest, Session } from '../model';
import { config } from './config';
import { discoverSessions } from './discover';
import { fetchPullDigest, fetchPullRequests, githubToken } from './github';
import { fetchIssues } from './linear';
import { fetchRelay } from './relay';
import { listSessions } from './sessions';
import { homedir } from 'node:os';
import { branchHistory, claudeHome, findTranscript, lastBranch, readNote } from './transcript';

/**
 * Tries each source for real and says what came back (S-79). It reports counts and
 * shapes, never titles or the words of a session, so the result is safe to paste anywhere.
 */
export interface Check {
	name: string;
	/** true: works. false: does not. null: not set up, so there was nothing to try. */
	ok: boolean | null;
	summary: string;
	details: string[];
}

interface Deps {
	cfg: Awaited<ReturnType<typeof config>>;
	fetcher: typeof fetch;
	list: () => Promise<Session[]>;
	/** Where Claude Code keeps its files. */
	claude: string;
	ghToken: (saved: string | null) => Promise<string | null>;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** fetch says exactly this when it got no answer at all. Other TypeErrors are about what was sent. */
const unreachable = (e: unknown) => e instanceof TypeError && e.message === 'fetch failed';
/** A path without the name of whoever is logged in. */
const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);
/** At most this many sessions have their transcripts read. */
const SAMPLE = 20;

async function checkLinear({ cfg, fetcher }: Deps): Promise<{ check: Check; issues: Issue[] }> {
	const name = 'Linear';
	if (!cfg.linearKey) return { check: { name, ok: null, summary: 'No API key is saved.', details: [] }, issues: [] };
	try {
		const issues = await fetchIssues(cfg.linearKey, cfg.linearTeam, fetcher);
		const shown = issues.filter((i) => i.startedAt || i.completedAt).length;
		const where = cfg.linearTeam ? `team ${cfg.linearTeam}` : 'every team';
		if (!issues.length) {
			const hint = cfg.linearTeam ? ' Check the team key: it is the prefix of your issue IDs.' : '';
			return { check: { name, ok: false, summary: `The key works, but ${where} has no issues.${hint}`, details: [] }, issues };
		}
		return {
			check: {
				name,
				ok: true,
				summary: `Read ${plural(issues.length, 'issue')} from ${where}.`,
				details: [
					`${shown} started or completed, so they can appear on the timeline`,
					`${issues.filter((i) => i.project).length} on a project, ${issues.filter((i) => i.milestone).length} on a milestone`,
					`${issues.filter((i) => i.branchName).length} have a branch name`
				]
			},
			issues
		};
	} catch (e) {
		const summary = unreachable(e) ? 'Could not reach Linear. Is this machine online?' : `Linear refused: ${message(e)}`;
		return { check: { name, ok: false, summary, details: [] }, issues: [] };
	}
}

/** What GitHub's answer usually means. */
const WHY: Record<string, string> = {
	'401': ', the token was refused',
	'403': ', the token may not read this repository, or the hourly limit is used up',
	'404': ', no such repository, or the token cannot see it'
};

async function checkGitHub({ cfg, fetcher, ghToken }: Deps): Promise<{ check: Check; prs: PullRequest[]; token: string | null }> {
	const name = 'GitHub';
	if (!cfg.githubRepos.length) return { check: { name, ok: null, summary: 'No repositories are set.', details: [] }, prs: [], token: null };
	const token = await ghToken(cfg.githubToken);
	const all: PullRequest[] = [];
	const details = [token ? (cfg.githubToken ? 'Using the token from the settings or the environment' : 'Using the login of the GitHub CLI') : 'No token: only public repositories can be read'];
	let failed = 0;
	let total = 0;
	for (const repo of cfg.githubRepos) {
		try {
			const prs = await fetchPullRequests([repo], token, fetcher);
			all.push(...prs);
			total += prs.length;
			details.push(`${repo}: ${plural(prs.length, 'pull request')}, ${prs.filter((p) => p.state === 'open' || p.state === 'draft').length} open`);
		} catch (e) {
			failed++;
			const text = message(e).startsWith(repo) ? message(e) : `${repo}: ${message(e)}`;
			details.push(unreachable(e) ? `${repo}: could not reach GitHub` : `${text}${WHY[text.split('HTTP ')[1]] ?? ''}`);
		}
	}
	const n = cfg.githubRepos.length;
	return {
		check: {
			name,
			ok: failed === 0,
			summary: failed ? `Could not read ${failed} of ${plural(n, 'repository', 'repositories')}.` : `Read ${plural(total, 'pull request')} from ${plural(n, 'repository', 'repositories')}.`,
			details
		},
		prs: all,
		token
	};
}

/** How many pull requests have their files and commits read to see whether sessions sign them. */
const PULLS_SAMPLED = 8;

/**
 * Sessions that run in the cloud are not on this machine at all. What can be known of them
 * comes from the pull requests they open (S-90): this says how much of that is there.
 */
async function checkCloud({ fetcher }: Deps, issues: Issue[], prs: PullRequest[], token: string | null): Promise<Check> {
	const name = 'Cloud sessions';
	if (!prs.length) return { name, ok: null, summary: 'Needs pull requests: a session that runs in the cloud is known by the link it leaves on one.', details: [] };
	const graph = buildGraph({ fetchedAt: '', demo: false, warnings: [], issues, prs, sessions: [] });
	const onTickets = graph.lanes.flatMap((l) => l.nodes).filter((n) => n.status !== null).reduce((sum, n) => sum + n.prs.length, 0);
	const described = prs.filter((p) => p.sessions?.length).length;
	const details = [`${onTickets} of ${plural(prs.length, 'pull request')} belong to a ticket, by their branch or title`, `${described} name a session in their description`];

	// the commits say it too, and more reliably; look at a few
	const sample = [...prs].sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)).slice(0, PULLS_SAMPLED);
	let read = 0;
	let signed = 0;
	for (const pr of token ? sample : []) {
		const pull = await fetchPullDigest(pr, token, Date.now(), fetcher).catch(() => null);
		if (!pull) continue;
		read++;
		if (pull.sessions.length) signed++;
	}
	if (!token) details.push('No GitHub token: the files and commits of pull requests are not read, so tickets are not related by them');
	else if (read) details.push(`Of the ${read} most recent, ${signed} name a session in their commits`);
	else details.push('Could not read the commits of any of the most recent ones');

	const found = described + signed > 0;
	if (!found) details.push('Claude Code adds the link by default; it is missing when "attribution.sessionUrl" is turned off');
	return {
		name,
		ok: found ? true : null,
		summary: found ? `Pull requests name the Claude Code session that made them (${described} of ${prs.length} in the description).` : 'No pull request names a Claude Code session.',
		details
	};
}

async function checkSessions({ list }: Deps): Promise<{ check: Check; sessions: Session[] }> {
	const name = 'Claude Code';
	try {
		const sessions = await list();
		const count = (state: Session['state']) => sessions.filter((s) => s.state === state).length;
		return {
			check: {
				name,
				ok: true,
				summary: `Claude Code lists ${plural(sessions.length, 'session')}.`,
				details: sessions.length ? [`${count('working')} working, ${count('needs')} waiting for you, ${count('failed')} failed, ${count('open') + count('done')} idle or finished`] : []
			},
			sessions
		};
	} catch (e) {
		const missing = (e as NodeJS.ErrnoException)?.code === 'ENOENT';
		const summary = missing ? 'The claude command was not found on the PATH.' : `Could not list sessions: ${message(e).split('\n')[0]}`;
		return { check: { name, ok: false, summary, details: [] }, sessions: [] };
	}
}

async function checkTranscripts({ claude }: Deps, sessions: Session[]): Promise<{ check: Check; sessions: Session[] }> {
	const name = 'Session transcripts';
	if (!sessions.length) return { check: { name, ok: null, summary: 'No sessions to look at.', details: [] }, sessions };
	const sample = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, SAMPLE);
	const seen = { found: 0, asked: 0, replied: 0, branch: 0, prs: 0, moved: 0 };
	const withBranch: Session[] = [];
	for (const s of sample) {
		const file = await findTranscript(s.id, s.cwd, claude).catch(() => null);
		if (!file) {
			withBranch.push(s);
			continue;
		}
		seen.found++;
		const note = await readNote(file).catch(() => null);
		const branches = await branchHistory(file).catch(() => [] as string[]);
		// the timeline links by the branch at the end of the transcript, so this does too
		const branch = await lastBranch(file).catch(() => null);
		if (note?.lastPrompt || note?.firstPrompt) seen.asked++;
		if (note?.lastReply) seen.replied++;
		if (note?.prs.length) seen.prs++;
		if (branches.length) seen.branch++;
		if (branches.length > 1) seen.moved++;
		withBranch.push({ ...s, branch });
	}
	const of = `of the ${sample.length} most recent`;
	const details = [
		`Your prompts readable in ${seen.asked}, Claude's last reply in ${seen.replied}`,
		`Git branch readable in ${seen.branch}; ${seen.moved} moved from one branch to another`,
		`${seen.prs} opened a pull request`
	];
	// Not a fault by itself: sessions that run in the cloud leave nothing here (see "Cloud sessions").
	if (!seen.found) {
		return {
			check: { name, ok: null, summary: `No transcript found for any ${of} sessions. Looked in ${tilde(claude)}/projects.`, details: ['Sessions that run in the cloud leave no transcript on this machine; they are found through their pull requests'] },
			sessions: withBranch
		};
	}
	if (!seen.asked && !seen.replied) {
		return { check: { name, ok: false, summary: `Found ${seen.found} ${of}, but could not read any. The format may differ from the one wtfwid knows.`, details }, sessions: withBranch };
	}
	return { check: { name, ok: true, summary: `Found a transcript for ${seen.found} ${of} sessions.`, details }, sessions: withBranch };
}

/** How many sessions end up on a ticket (S-50), which is what makes the timeline useful. */
function checkLinking(issues: Issue[], recent: Session[], past: Session[]): Check {
	const name = 'Sessions on tickets';
	const sessions = [...recent, ...past];
	if (!issues.length || !sessions.length) return { name, ok: null, summary: 'Needs both Linear issues and sessions.', details: [] };
	const link = (list: Session[]) => {
		const graph = buildGraph({ fetchedAt: '', demo: false, warnings: [], issues, prs: [], sessions: list });
		return list.length - (graph.lanes.find((l) => l.kind === 'unsorted')?.nodes.length ?? 0);
	};
	const matched = link(sessions);
	const byNameOnly = link(sessions.map((s) => ({ ...s, branch: null })));
	return {
		name,
		// one or two stray sessions that match nothing are not a fault: most work may run in the cloud
		ok: matched > 0 ? true : sessions.length < 3 ? null : false,
		summary: `${matched} of ${plural(sessions.length, 'session')} belong to a ticket (${plural(recent.length, 'recent one')}, ${past.length} from disk).`,
		details: [`${byNameOnly} by their name or folder, ${matched - byNameOnly} more by the branch they are on`, ...(matched ? [] : ['Work on the branch Linear suggests for the issue, or name the session after it: claude -n "ENG-123 …"'])]
	};
}

/** The relay that sessions in the cloud report to (S-91), if one is set up. */
async function checkRelay({ cfg, fetcher }: Deps): Promise<Check> {
	const name = 'Relay';
	if (!cfg.relayUrl || !cfg.relayToken) {
		return { name, ok: null, summary: 'No relay is set.', details: ['Without one, wtfwid cannot say whether a session in the cloud is working or waiting for you'] };
	}
	try {
		const { sessions, notes } = await fetchRelay(cfg.relayUrl, cfg.relayToken, Date.now(), fetcher);
		const count = (state: Session['state']) => sessions.filter((s) => !s.gone && s.state === state).length;
		const details = [`${count('working')} working, ${count('needs')} waiting for you, ${sessions.filter((s) => s.gone).length} ended`, `${plural(notes.length, 'note')} left through the connector`];
		if (!sessions.length) details.push('No session has reported yet: check the hook in the repository, the two variables in the cloud environment, and that the relay is on its list of allowed domains');
		return { name, ok: true, summary: `The relay answered: ${plural(sessions.length, 'session')} reported in the last six weeks.`, details };
	} catch (e) {
		return { name, ok: false, summary: `Could not read the relay: ${message(e)}.`, details: [] };
	}
}

export async function checkAll(over: Partial<Deps> = {}): Promise<Check[]> {
	const deps: Deps = { cfg: over.cfg ?? (await config()), fetcher: fetch, list: listSessions, claude: claudeHome(), ghToken: githubToken, ...over };
	const [linear, github, listed] = await Promise.all([checkLinear(deps), checkGitHub(deps), checkSessions(deps)]);
	const transcripts = await checkTranscripts(deps, listed.sessions);
	// S-83: past sessions found as transcripts count too; most of the history is there
	const live = new Set(listed.sessions.map((s) => s.id));
	const past = (await discoverSessions(deps.claude).catch(() => [] as Session[])).filter((s) => !live.has(s.id));
	if (listed.check.ok) listed.check.details.push(`${plural(past.length, 'more past session')} found as transcripts on disk`);
	const [cloud, relay] = await Promise.all([checkCloud(deps, linear.issues, github.prs, github.token), checkRelay(deps)]);
	return [linear.check, github.check, listed.check, transcripts.check, checkLinking(linear.issues, transcripts.sessions, past), cloud, relay];
}

/** The same result as plain text, to paste into a chat or an issue. */
export function asText(checks: Check[]): string {
	const mark = (ok: boolean | null) => (ok === true ? 'ok  ' : ok === false ? 'FAIL' : '-   ');
	return checks.map((c) => [`${mark(c.ok)} ${c.name}: ${c.summary}`, ...c.details.map((d) => `       ${d}`)].join('\n')).join('\n');
}
