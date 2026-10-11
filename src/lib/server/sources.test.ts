import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../graph';
import type { Session } from '../model';
import { demoSnapshot } from './demo';
import { fetchPullRequests, toPullRequest } from './github';
import { fetchIssues } from './linear';
import { collectSessions, remember, toSession } from './sessions';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Claude Code sessions', () => {
	it('S-62 reads an entry as `claude agents --json` prints it', () => {
		// captured from Claude Code 2.1.296
		const entry = { pid: 92, cwd: '/home/claude', kind: 'interactive', startedAt: 1791660811649, sessionId: 'cba26409', name: 'claude-02', status: 'busy' } as const;
		expect(toSession(entry)).toEqual({
			id: 'cba26409',
			name: 'claude-02',
			cwd: '/home/claude',
			kind: 'interactive',
			startedAt: '2026-10-10T19:33:31.649Z',
			state: 'working',
			waitingFor: null,
			gone: false
		});
	});

	it('S-62 maps every documented state', () => {
		const base = { cwd: '/r', kind: 'background', startedAt: 0 } as const;
		expect(toSession({ ...base, state: 'blocked', status: 'waiting', waitingFor: 'permission prompt' })).toMatchObject({ state: 'needs', waitingFor: 'permission prompt' });
		expect(toSession({ ...base, state: 'working' }).state).toBe('working');
		expect(toSession({ ...base, state: 'done' }).state).toBe('done');
		expect(toSession({ ...base, state: 'failed' }).state).toBe('failed');
		expect(toSession({ ...base, state: 'stopped' }).state).toBe('open');
		expect(toSession({ ...base, kind: 'interactive', status: 'idle' }).state).toBe('open');
	});

	const s = (id: string, state: Session['state'], startedAt = '2026-10-01T00:00:00.000Z'): Session => ({ id, name: id, cwd: '/r', kind: 'background', startedAt, state, waitingFor: state === 'needs' ? 'input needed' : null, gone: false });

	it('S-53 keeps sessions that are no longer listed, and stops calling them working or waiting', () => {
		const all = remember([s('a', 'working'), s('b', 'needs'), s('c', 'done'), s('d', 'failed')], [s('e', 'working', '2026-10-02T00:00:00.000Z')]);
		expect(all.map((x) => [x.id, x.state, x.gone, x.waitingFor])).toEqual([
			['a', 'open', true, null],
			['b', 'open', true, null],
			['c', 'done', true, null],
			['d', 'failed', true, null],
			['e', 'working', false, null]
		]);
	});

	it('S-53 takes the listed version of a session it already knows', () => {
		expect(remember([s('a', 'working')], [s('a', 'done')])).toEqual([s('a', 'done')]);
	});

	it('S-53 remembers sessions in a file between runs', async () => {
		const home = await mkdtemp(join(tmpdir(), 'wtfwid-'));
		await collectSessions(home, async () => [s('a', 'working')]);
		const second = await collectSessions(home, async () => [s('b', 'working', '2026-10-02T00:00:00.000Z')]);
		expect(second.map((x) => [x.id, x.gone])).toEqual([['a', true], ['b', false]]);
		expect(JSON.parse(await readFile(join(home, 'sessions.json'), 'utf8'))).toEqual(second);
	});
});

describe('Linear', () => {
	const raw = (n: number) => ({
		identifier: `ENG-${n}`,
		title: 't',
		url: 'u',
		createdAt: 'c',
		startedAt: null,
		completedAt: null,
		canceledAt: null,
		branchName: `eng-${n}-t`,
		state: { name: 'Backlog', type: 'backlog' },
		project: { id: 'p', name: 'Web' },
		projectMilestone: null
	});

	it('S-60 pages through all issues of the team', async () => {
		const calls: any[] = [];
		const fetcher = (async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string);
			calls.push({ auth: (init.headers as any).Authorization, ...body.variables });
			const last = body.variables.after === 'c1';
			return json({ data: { issues: { pageInfo: { hasNextPage: !last, endCursor: 'c1' }, nodes: [raw(last ? 2 : 1)] } } });
		}) as typeof fetch;
		const issues = await fetchIssues('key', 'ENG', fetcher);
		expect(issues.map((i) => i.id)).toEqual(['ENG-1', 'ENG-2']);
		expect(issues[0]).toMatchObject({ stateName: 'Backlog', stateType: 'backlog', project: { id: 'p', name: 'Web' }, milestone: null });
		expect(calls).toEqual([
			{ auth: 'key', filter: { team: { key: { eq: 'ENG' } } }, after: null },
			{ auth: 'key', filter: { team: { key: { eq: 'ENG' } } }, after: 'c1' }
		]);
	});

	it('S-64 reports Linear\'s own error message', async () => {
		const fetcher = (async () => json({ errors: [{ message: 'Authentication required' }] }, 401)) as unknown as typeof fetch;
		await expect(fetchIssues('bad', null, fetcher)).rejects.toThrow('Authentication required');
	});
});

describe('GitHub', () => {
	const raw = (number: number, over: object = {}) => ({ number, title: 't', html_url: 'u', head: { ref: 'b' }, state: 'open', draft: false, merged_at: null, created_at: 'c', ...over });

	it('S-61 reads the four pull request states', () => {
		expect(toPullRequest('o/r', raw(1)).state).toBe('open');
		expect(toPullRequest('o/r', raw(1, { draft: true })).state).toBe('draft');
		expect(toPullRequest('o/r', raw(1, { state: 'closed' })).state).toBe('closed');
		expect(toPullRequest('o/r', raw(1, { state: 'closed', merged_at: 'm' })).state).toBe('merged');
	});

	it('S-61 stops paging at a short page and at 300 pull requests', async () => {
		const urls: string[] = [];
		const pages = (sizes: number[]) =>
			(async (url: string) => {
				urls.push(url);
				const page = Number(new URL(url).searchParams.get('page'));
				return json(Array.from({ length: sizes[page - 1] ?? 0 }, (_, i) => raw(page * 1000 + i)));
			}) as typeof fetch;
		expect(await fetchPullRequests(['o/short'], 'tok', pages([100, 5]))).toHaveLength(105);
		expect(await fetchPullRequests(['o/long'], 'tok', pages([100, 100, 100, 100]))).toHaveLength(300);
		expect(urls.map((u) => new URL(u).pathname + ':' + new URL(u).searchParams.get('page'))).toEqual([
			'/repos/o/short/pulls:1',
			'/repos/o/short/pulls:2',
			'/repos/o/long/pulls:1',
			'/repos/o/long/pulls:2',
			'/repos/o/long/pulls:3'
		]);
	});
});

describe('read only', () => {
	it('S-03 only ever reads from Linear and GitHub', async () => {
		const sent: { url: string; method: string; body: string }[] = [];
		const fetcher = (async (url: string, init: RequestInit = {}) => {
			sent.push({ url, method: init.method ?? 'GET', body: String(init.body ?? '') });
			if (url.includes('linear.app')) return json({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
			return json([]);
		}) as typeof fetch;
		await fetchIssues('key', 'ENG', fetcher);
		await fetchPullRequests(['o/r'], 'tok', fetcher);

		const [linear, github] = sent;
		expect(sent).toHaveLength(2);
		// GraphQL is always a POST; what matters is that the document is a query
		expect(JSON.parse(linear.body).query.trimStart().startsWith('query ')).toBe(true);
		expect(linear.body).not.toMatch(/\bmutation\b/);
		expect(github).toMatchObject({ method: 'GET', body: '' });
	});
});

describe('demo data', () => {
	it('S-63 runs through the same graph builder and shows every state', () => {
		const graph = buildGraph(demoSnapshot(Date.parse('2026-10-10T12:00:00.000Z')));
		expect(graph.demo).toBe(true);
		const states = new Set(graph.lanes.flatMap((l) => l.nodes).map((n) => n.state));
		expect([...states].sort()).toEqual(['done', 'failed', 'needs', 'open', 'review', 'working']);
		expect(graph.lanes.some((l) => l.kind === 'milestone' && l.closed)).toBe(true);
		expect(graph.lanes.at(-1)?.kind).toBe('unsorted');
	});
});
