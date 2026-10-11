import { describe, expect, it } from 'vitest';
import { buildGraph, ticketState } from './graph';
import type { Issue, PullRequest, Session, Snapshot } from './model';

const issue = (n: number, over: Partial<Issue> = {}): Issue => ({
	id: `ENG-${n}`,
	title: `Ticket ${n}`,
	url: `https://linear.app/x/issue/ENG-${n}`,
	createdAt: '2026-10-01T08:00:00.000Z',
	startedAt: '2026-10-01T09:00:00.000Z',
	completedAt: null,
	canceledAt: null,
	stateName: 'In Progress',
	stateType: 'started',
	branchName: `eng-${n}-ticket-${n}`,
	project: { id: 'web', name: 'Web' },
	milestone: null,
	...over
});
const session = (id: string, over: Partial<Session> = {}): Session => ({
	id,
	name: null,
	cwd: '/repo',
	kind: 'background',
	startedAt: '2026-10-02T10:00:00.000Z',
	state: 'working',
	waitingFor: null,
	gone: false,
	...over
});
const pr = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
	repo: 'o/r',
	number,
	title: 'A change',
	url: `https://github.com/o/r/pull/${number}`,
	branch: 'some-branch',
	state: 'open',
	createdAt: '2026-10-03T10:00:00.000Z',
	...over
});
const snap = (over: Partial<Snapshot>): Snapshot => ({
	fetchedAt: '2026-10-10T12:00:00.000Z',
	demo: false,
	warnings: [],
	issues: [],
	prs: [],
	sessions: [],
	...over
});
const nodes = (s: Snapshot) => buildGraph(s).lanes.flatMap((l) => l.nodes);

describe('linking', () => {
	it('S-50 links a session by issue identifier in its name, any case', () => {
		const [node] = nodes(snap({ issues: [issue(12)], sessions: [session('a', { name: 'eng-12 reconnect' })] }));
		expect(node.sessions.map((s) => s.id)).toEqual(['a']);
		expect(node.stage).toBe('session');
	});

	it('S-50 links a session by the branch name in its working directory', () => {
		const [node] = nodes(snap({ issues: [issue(12)], sessions: [session('a', { cwd: '/repo/.claude/worktrees/eng-12-ticket-12' })] }));
		expect(node.sessions).toHaveLength(1);
	});

	it('S-50 does not confuse ENG-12 with ENG-120', () => {
		const graph = buildGraph(snap({ issues: [issue(12), issue(120)], sessions: [session('a', { name: 'ENG-120 fix' })] }));
		const byId = Object.fromEntries(graph.lanes.flatMap((l) => l.nodes).map((n) => [n.id, n]));
		expect(byId['ENG-120'].sessions).toHaveLength(1);
		expect(byId['ENG-12'].sessions).toHaveLength(0);
	});

	it('S-51 links a pull request by branch or title', () => {
		const [node] = nodes(snap({ issues: [issue(7)], prs: [pr(1, { branch: 'eng-7-ticket-7' }), pr(2, { title: 'ENG-7 follow-up' })] }));
		expect(node.prs.map((p) => p.number)).toEqual([1, 2]);
		expect(node.stage).toBe('pr');
	});

	it('S-52 puts unmatched sessions and open pull requests on an Unsorted line, and drops unmatched merged ones', () => {
		const graph = buildGraph(snap({ sessions: [session('a', { name: 'scratch' })], prs: [pr(1), pr(2, { state: 'merged' })] }));
		expect(graph.lanes.map((l) => l.kind)).toEqual(['unsorted']);
		expect(graph.lanes[0].nodes.map((n) => n.label)).toEqual(['scratch', '#1']);
	});
});

describe('nodes', () => {
	it('S-30 S-31 draws one node per ticket, shaped by how far it got', () => {
		const made = nodes(
			snap({
				issues: [issue(1), issue(2), issue(3)],
				sessions: [session('a', { name: 'ENG-2 fix' }), session('b', { name: 'ENG-3 fix' }), session('c', { name: 'eng-3 again' })],
				prs: [pr(7, { branch: 'eng-3-ticket-3' })]
			})
		);
		expect(made.map((n) => [n.id, n.stage, n.sessions.length, n.prs.length])).toEqual([
			['ENG-1', 'ticket', 0, 0],
			['ENG-2', 'session', 1, 0],
			['ENG-3', 'pr', 2, 1]
		]);
	});
});

describe('which tickets appear', () => {
	it('S-32 hides untouched backlog but shows it once a session exists', () => {
		const backlog = issue(1, { startedAt: null, stateName: 'Backlog', stateType: 'backlog' });
		expect(nodes(snap({ issues: [backlog] }))).toHaveLength(0);
		expect(nodes(snap({ issues: [backlog], sessions: [session('a', { name: 'ENG-1' })] }))).toHaveLength(1);
	});

	it('S-33 hides cancelled and duplicate issues', () => {
		const issues = [issue(1, { stateType: 'canceled', canceledAt: '2026-10-02T00:00:00.000Z' }), issue(2, { stateType: 'duplicate' })];
		expect(nodes(snap({ issues }))).toHaveLength(0);
	});

	it('S-34 places a ticket at the start of work, falling back to its first session', () => {
		const a = issue(1);
		const b = issue(2, { startedAt: null });
		const got = nodes(snap({ issues: [a, b], sessions: [session('s', { name: 'ENG-2', startedAt: '2026-10-05T00:00:00.000Z' })] }));
		expect(Object.fromEntries(got.map((n) => [n.id, n.at]))).toEqual({
			'ENG-1': '2026-10-01T09:00:00.000Z',
			'ENG-2': '2026-10-05T00:00:00.000Z'
		});
	});
});

describe('state', () => {
	const done = issue(1, { completedAt: '2026-10-02T00:00:00.000Z', stateName: 'Done', stateType: 'completed' });
	const cases: [string, Issue, Session[], PullRequest[], string][] = [
		['S-40 a waiting session wins over everything', done, [session('a', { state: 'needs' })], [], 'needs'],
		['S-40 a waiting session that is gone does not count', issue(1), [session('a', { state: 'needs', gone: true })], [], 'open'],
		['S-41 the latest session failed', issue(1), [session('a', { state: 'done', startedAt: '2026-10-01T00:00:00.000Z' }), session('b', { state: 'failed' })], [], 'failed'],
		['S-41 an earlier failure followed by a later session is not failed', issue(1), [session('a', { state: 'failed', startedAt: '2026-10-01T00:00:00.000Z' }), session('b', { state: 'working' })], [], 'working'],
		['S-41 a failed session on a completed issue is done', done, [session('a', { state: 'failed' })], [], 'done'],
		['S-42 a busy session', issue(1), [session('a')], [pr(1)], 'working'],
		['S-43 completed', done, [], [pr(1, { state: 'merged' })], 'done'],
		['S-44 status name contains review', issue(1, { stateName: 'In Review' }), [], [], 'review'],
		['S-44 an open pull request', issue(1), [], [pr(1)], 'review'],
		['S-44 a draft pull request is not review', issue(1), [], [pr(1, { state: 'draft' })], 'open'],
		['S-45 otherwise open', issue(1), [], [], 'open']
	];
	it.each(cases)('%s', (_name, i, sessions, prs, expected) => {
		expect(ticketState(i, sessions, prs)).toBe(expected);
	});
});

describe('lines', () => {
	const voice = { id: 'm-voice', name: 'Voice' };
	const share = { id: 'm-share', name: 'Screen share' };
	const issues = [
		issue(1),
		issue(2, { milestone: voice, startedAt: '2026-10-02T09:00:00.000Z' }),
		issue(3, { milestone: share, startedAt: '2026-10-04T09:00:00.000Z' }),
		issue(4, { project: null, startedAt: '2026-10-06T09:00:00.000Z' }),
		issue(5, { project: { id: 'old', name: 'Old' }, startedAt: '2026-09-01T09:00:00.000Z', completedAt: '2026-09-02T09:00:00.000Z' })
	];
	const graph = buildGraph(snap({ issues }));

	it('S-11 S-20 S-21 S-22 makes a trunk per project and a branch per milestone', () => {
		expect(graph.lanes.map((l) => [l.name, l.kind, l.parent])).toEqual([
			['Old', 'project', null],
			['Web', 'project', null],
			['Screen share', 'milestone', 'p:web'],
			['Voice', 'milestone', 'p:web'],
			['No project', 'project', null]
		]);
	});

	it('S-23 orders a project\'s milestones newest first', () => {
		const web = graph.lanes.filter((l) => l.parent === 'p:web').map((l) => l.name);
		expect(web).toEqual(['Screen share', 'Voice']);
	});

	it('S-12 marks a line closed only when everything on and under it is done', () => {
		expect(Object.fromEntries(graph.lanes.map((l) => [l.name, l.closed]))).toEqual({
			Old: true,
			Web: false,
			'Screen share': false,
			Voice: false,
			'No project': false
		});
	});
});
