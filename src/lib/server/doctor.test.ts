import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Session } from '../model';
import { asText, checkAll } from './doctor';
import { branchHistory } from './transcript';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';

const cfg = (over = {}) => ({ linearKey: 'key', linearTeam: 'ENG', githubToken: null, githubRepos: ['o/r', 'o/private'], home: '/nowhere', snapshotFile: null, ...over });
const issue = (n: number, over = {}) => ({
	identifier: `ENG-${n}`, title: 'secret title', url: 'u', createdAt: 'c', startedAt: n % 2 ? '2026-10-01T09:00:00.000Z' : null, completedAt: null, canceledAt: null,
	branchName: `dev/eng-${n}-thing`, state: { name: 'Todo', type: 'unstarted' }, project: { id: 'p', name: 'Web' }, projectMilestone: n === 1 ? { id: 'm', name: 'Voice' } : null, ...over
});
const pull = (number: number, state = 'open') => ({ number, title: 'secret pr', html_url: 'u', head: { ref: 'b' }, state, draft: false, merged_at: null, created_at: 'c' });
const fetcher = (async (url: string) => {
	if (url.includes('linear.app')) return json({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issue(1), issue(2), issue(3)] } } });
	if (url.includes('/repos/o/private/')) return json({ message: 'Not Found' }, 404);
	return json([pull(1), pull(2, 'closed')]);
}) as typeof fetch;

const session = (id: string, over: Partial<Session> = {}): Session => ({ id, name: 'claude-07', cwd: '/home/dev/app', kind: 'interactive', startedAt: '2026-10-10T09:00:00.000Z', state: 'working', waitingFor: null, gone: false, ...over });
const many = (n: number) => Array.from({ length: n }, (_, i) => session(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, { name: i < 3 ? `ENG-${i + 1} work` : 'scratch', startedAt: new Date(Date.parse('2026-10-10T09:00:00.000Z') - i * 3_600_000).toISOString() }));
const entry = (type: string, text: string, gitBranch: string) =>
	JSON.stringify({ parentUuid: null, isSidechain: false, cwd: '/home/dev/app', sessionId: ID, gitBranch, type, message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] }, timestamp: '2026-10-10T09:00:00.000Z' });

async function claudeDir(lines: string[]) {
	const root = await mkdtemp(join(tmpdir(), 'wtfwid-claude-'));
	await mkdir(join(root, 'projects', '-home-dev-app'), { recursive: true });
	await writeFile(join(root, 'projects', '-home-dev-app', `${ID}.jsonl`), lines.join('\n') + '\n');
	return root;
}
const LINES = [entry('user', 'a secret prompt', 'main'), entry('assistant', 'a secret reply', 'main'), entry('user', 'the last secret prompt', 'dev/eng-3-thing'), entry('assistant', 'the last secret reply', 'dev/eng-3-thing')];

describe('checking the connections', () => {
	it('S-79 reports what each source gave back, in counts', async () => {
		const claude = await claudeDir(LINES);
		const checks = await checkAll({ cfg: cfg(), fetcher, list: async () => [session(ID), session(OTHER, { name: 'ENG-1 fix', state: 'needs' })], claude, ghToken: async () => 'tok' });
		expect(asText(checks)).toBe(
			[
				'ok   Linear: Read 3 issues from team ENG.',
				'       2 started or completed, so they can appear on the timeline',
				'       3 on a project, 1 on a milestone',
				'       3 have a branch name',
				'FAIL GitHub: Could not read 1 of 2 repositories.',
				'       Using the login of the GitHub CLI',
				'       o/r: 2 pull requests, 1 open',
				'       o/private: HTTP 404, no such repository, or the token cannot see it',
				'ok   Claude Code: Claude Code lists 2 sessions.',
				'       1 working, 1 waiting for you, 0 failed, 0 idle or finished',
				'       0 more past sessions found as transcripts on disk',
				'ok   Session transcripts: Found a transcript for 1 of the 2 most recent sessions.',
				"       Your prompts readable in 1, Claude's last reply in 1",
				'       Git branch readable in 1; 1 moved from one branch to another',
				'       0 opened a pull request',
				'ok   Sessions on tickets: 2 of 2 sessions belong to a ticket (2 recent ones, 0 from disk).',
				'       1 by their name or folder, 1 more by the branch they are on'
			].join('\n')
		);
	});

	it('S-79 never repeats a title, a prompt or a reply', async () => {
		const claude = await claudeDir(LINES);
		const told = session(ID, { name: 'secret session name', waitingFor: 'secret question', state: 'needs' });
		const checks = await checkAll({ cfg: cfg(), fetcher, list: async () => [told], claude, ghToken: async () => 'tok' });
		// every prompt and reply in the transcript, the issue and pull request titles, the session's name and what it waits for
		expect(JSON.stringify(checks)).not.toContain('secret');
		expect(asText(checks)).not.toContain('secret');
		// and it did read them: the transcript check found a prompt and a reply
		expect(checks[3].details[0]).toBe("Your prompts readable in 1, Claude's last reply in 1");
	});

	it('S-79 says "not set" for what is not set up, without trying it', async () => {
		let asked = 0;
		const counting = (async () => (asked++, json([]))) as unknown as typeof fetch;
		const checks = await checkAll({ cfg: cfg({ linearKey: null, githubRepos: [] }), fetcher: counting, list: async () => [], claude: '/nowhere', ghToken: async () => null });
		expect(checks.map((c) => [c.name, c.ok])).toEqual([['Linear', null], ['GitHub', null], ['Claude Code', true], ['Session transcripts', null], ['Sessions on tickets', null]]);
		expect(asked).toBe(0);
	});

	it('S-79 passes on what went wrong in words that say what to fix', async () => {
		const refused = (async (url: string) => (url.includes('linear.app') ? json({ errors: [{ message: 'Authentication required, not authenticated' }] }, 401) : json({}, 401))) as typeof fetch;
		const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
		const checks = await checkAll({ cfg: cfg({ githubRepos: ['o/r'], githubToken: 'bad' }), fetcher: refused, list: async () => Promise.reject(missing), claude: '/nowhere', ghToken: async (t) => t });
		expect(checks.slice(0, 3).map((c) => [c.ok, c.summary, ...c.details])).toEqual([
			[false, 'Linear refused: Authentication required, not authenticated'],
			[false, 'Could not read 1 of 1 repository.', 'Using the token from the settings or the environment', 'o/r: HTTP 401, the token was refused'],
			[false, 'The claude command was not found on the PATH.']
		]);
		const offline = (async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
		const [linear, github] = await checkAll({ cfg: cfg({ githubRepos: ['o/r'] }), fetcher: offline, list: async () => [], claude: '/nowhere', ghToken: async () => null });
		expect(linear.summary).toBe('Could not reach Linear. Is this machine online?');
		expect(github.details).toEqual(['No token: only public repositories can be read', 'o/r: could not reach GitHub']);
	});

	it('S-79 notices a wrong team key, and transcripts it cannot read', async () => {
		const empty = (async () => json({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } })) as unknown as typeof fetch;
		const claude = await claudeDir(['{"type":"something-else","payload":1}', 'not json at all']);
		const checks = await checkAll({ cfg: cfg({ githubRepos: [] }), fetcher: empty, list: async () => [session(ID)], claude, ghToken: async () => null });
		expect(checks[0]).toMatchObject({ ok: false, summary: 'The key works, but team ENG has no issues. Check the team key: it is the prefix of your issue IDs.' });
		expect(checks[3]).toMatchObject({ ok: false, summary: 'Found 1 of the 1 most recent, but could not read any. The format may differ from the one wtfwid knows.' });
		const gone = await checkAll({ cfg: cfg({ githubRepos: [] }), fetcher: empty, list: async () => [session(OTHER)], claude, ghToken: async () => null });
		expect(gone[3]).toMatchObject({ ok: false, summary: `No transcript found for any of the 1 most recent sessions. Looked in ${claude}/projects.` });
	});

	it('S-79 says how many sessions it looked at when there are more than it reads', async () => {
		const checks = await checkAll({ cfg: cfg({ githubRepos: [] }), fetcher, list: async () => many(30), claude: '/nowhere', ghToken: async () => null });
		expect(checks[2].summary).toBe('Claude Code lists 30 sessions.');
		expect(checks[3].summary).toBe('No transcript found for any of the 20 most recent sessions. Looked in /nowhere/projects.');
		expect(checks[4].summary).toBe('3 of 20 sessions belong to a ticket (20 recent ones, 0 from disk).');
	});

	it('S-79 counts the past sessions found on disk, and how many of them land on a ticket', async () => {
		const claude = await claudeDir(LINES); // one transcript, last on dev/eng-3-thing
		const checks = await checkAll({ cfg: cfg({ githubRepos: [] }), fetcher, list: async () => [session(OTHER, { name: 'scratch' })], claude, ghToken: async () => null });
		expect(checks[2].details.at(-1)).toBe('1 more past session found as transcripts on disk');
		expect(checks[4].summary).toBe('1 of 2 sessions belong to a ticket (1 recent one, 1 from disk).');
	});

	it('S-79 tells a refused request from a machine that is offline, and keeps your name out of paths', async () => {
		// a key with a character a request cannot carry never leaves the machine: that is not "offline"
		const invalid = (async () => Promise.reject(new TypeError('Headers.append: "k\u200b" is an invalid header value.'))) as unknown as typeof fetch;
		const [linear, github] = await checkAll({ cfg: cfg({ githubRepos: ['o/r'] }), fetcher: invalid, list: async () => [], claude: '/nowhere', ghToken: async () => null });
		expect(linear.summary).toMatch(/^Linear refused: Headers.append/);
		expect(github.details[1]).toMatch(/^o\/r: Headers.append/);
		const home = (await import('node:os')).homedir();
		const [, , , transcripts] = await checkAll({ cfg: cfg({ linearKey: null, githubRepos: [] }), fetcher, list: async () => [session(ID)], claude: `${home}/.claude`, ghToken: async () => null });
		expect(transcripts.summary).toBe('No transcript found for any of the 1 most recent sessions. Looked in ~/.claude/projects.');
	});

	it('S-79 reads the branches a session moved through, in order', async () => {
		const claude = await claudeDir([...LINES, entry('user', 'x', 'HEAD'), entry('user', 'back', 'main'), entry('user', 'still', 'main')]);
		expect(await branchHistory(join(claude, 'projects', '-home-dev-app', `${ID}.jsonl`))).toEqual(['main', 'dev/eng-3-thing', 'main']);
	});
});
