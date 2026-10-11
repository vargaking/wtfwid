import { describe, expect, it } from 'vitest';
import { buildGraph, matcher } from './graph';
import type { Digest, Issue, Session, Snapshot } from './model';
import { checkoutOf, fileIn, mergeSpans, reason, relate, relationsOf, workOf } from './relations';

const issue = (n: number, over: Partial<Issue> = {}): Issue => ({
	id: `ENG-${n}`,
	title: `Ticket ${n}`,
	url: `https://linear.app/x/issue/ENG-${n}`,
	createdAt: '2026-10-01T08:00:00.000Z',
	startedAt: `2026-10-${String(n).padStart(2, '0')}T09:00:00.000Z`,
	completedAt: null,
	canceledAt: null,
	stateName: 'In Progress',
	stateType: 'started',
	branchName: `eng-${n}-ticket-${n}`,
	project: { id: 'web', name: 'Web' },
	milestone: null,
	...over
});
/** A session on ticket `n`, in a worktree of its own. */
const session = (id: string, n: number | null, over: Partial<Session> = {}): Session => ({
	id,
	name: n === null ? 'scratch' : `ENG-${n} work`,
	cwd: n === null ? '/repo' : `/repo/.claude/worktrees/eng-${n}`,
	kind: 'background',
	startedAt: '2026-10-02T10:00:00.000Z',
	state: 'open',
	waitingFor: null,
	gone: true,
	...over
});
const digest = (files: string[], over: Partial<Digest> = {}): Digest => ({
	stamp: '1:1',
	readAt: 0,
	root: '/repo',
	files: files.map((path) => ({ path, edits: 1 })),
	branches: [],
	spans: [],
	minutes: 0,
	added: 0,
	removed: 0,
	tokens: 0,
	costUSD: null,
	...over
});

/** Tickets 1…n with one session each (`s1`…), related by the given digests. */
function related(count: number, digests: Record<string, Digest>, extra: Session[] = []) {
	const numbers = Array.from({ length: count }, (_, i) => i + 1);
	const snap: Snapshot = {
		fetchedAt: '2026-10-20T12:00:00.000Z',
		demo: false,
		warnings: [],
		issues: numbers.map((n) => issue(n)),
		prs: [],
		sessions: [...numbers.map((n) => session(`s${n}`, n)), ...extra]
	};
	const graph = buildGraph(snap);
	const find = matcher(snap.issues);
	return relate(graph.lanes, digests, (branch) => find(branch)?.id ?? null);
}

describe('where a file is', () => {
	it('S-86: a worktree is taken out of a path, so the same file is the same in every worktree', () => {
		expect(checkoutOf('/repo/.claude/worktrees/eng-12')).toBe('/repo');
		expect(checkoutOf('/repo/.claude/worktrees/eng-12/packages/web/')).toBe('/repo/packages/web');
		expect(checkoutOf('C:\\code\\app\\.claude\\worktrees\\x')).toBe('C:\\code\\app');
		expect(checkoutOf('/repo')).toBe('/repo');
		expect(fileIn('src/a.ts', '/repo')).toBe('src/a.ts');
		// a session in the main checkout that edited a file inside a worktree
		expect(fileIn('.claude/worktrees/eng-12/src/a.ts', '/repo')).toBe('src/a.ts');
		expect(fileIn('/repo/.claude/worktrees/eng-12/src/a.ts', '/repo')).toBe('src/a.ts');
	});

	it('S-86: a file outside the checkout, and a lock file, relate nothing', () => {
		expect(fileIn('/tmp/plan.md', '/repo')).toBeNull();
		expect(fileIn('/repository/src/a.ts', '/repo')).toBeNull();
		expect(fileIn('pnpm-lock.yaml', '/repo')).toBeNull();
		expect(fileIn('packages/web/package-lock.json', '/repo')).toBeNull();
		expect(fileIn('src/a.ts', '')).toBeNull();
	});
});

describe('related tickets', () => {
	it('S-86: two tickets whose sessions changed the same file are related, the earlier one first', () => {
		const out = related(3, { s1: digest(['src/a.ts', 'src/only-1.ts']), s2: digest(['src/a.ts']), s3: digest(['src/other.ts']) });
		expect(out).toEqual([{ a: 'ENG-1', b: 'ENG-2', continued: false, weight: 1, shared: 1, files: ['src/a.ts'] }]);
	});

	it('S-86: a file many tickets changed counts for less, and one that most changed for nothing', () => {
		// a.ts: tickets 1 and 2 only. b.ts: 1, 2 and 3. hub.ts: all eight.
		const digests = Object.fromEntries(
			Array.from({ length: 8 }, (_, i) => [`s${i + 1}`, digest(['hub.ts', ...(i < 2 ? ['a.ts'] : []), ...(i < 3 ? ['b.ts'] : [])])])
		);
		const out = related(8, digests);
		const of = (a: string, b: string) => out.find((r) => r.a === a && r.b === b);
		expect(of('ENG-1', 'ENG-2')).toMatchObject({ weight: 1.5, shared: 2, files: ['a.ts', 'b.ts'] });
		expect(of('ENG-1', 'ENG-3')).toMatchObject({ weight: 0.5, shared: 1, files: ['b.ts'] });
		// hub.ts alone relates nobody
		expect(out).toHaveLength(3);
		expect(out[0]).toMatchObject({ a: 'ENG-1', b: 'ENG-2' });
	});

	it('S-86: the same path in two different checkouts is two files', () => {
		const out = related(2, { s1: digest(['src/index.ts']), s2: digest(['src/index.ts'], { root: '/other-repo' }) });
		expect(out).toEqual([]);
	});

	it('S-86: a ticket keeps its strongest few relations', () => {
		// eight tickets, every two of them share a file only they changed; 1 and 2 share three
		const files: Record<number, string[]> = {};
		for (let i = 1; i <= 8; i++) for (let j = i + 1; j <= 8; j++) for (const n of [i, j]) (files[n] ??= []).push(`f${i}-${j}.ts`);
		for (const n of [1, 2]) files[n].push('extra-a.ts', 'extra-b.ts');
		const out = related(8, Object.fromEntries(Object.entries(files).map(([n, list]) => [`s${n}`, digest(list)])));
		expect(out[0]).toMatchObject({ a: 'ENG-1', b: 'ENG-2', weight: 3, shared: 3 });
		// 28 pairs are worth a line; not all of them stay
		expect(out.length).toBeLessThan(28);
		for (let n = 1; n <= 8; n++) expect(relationsOf(out, `ENG-${n}`).length).toBeGreaterThanOrEqual(5);
		// a pair is dropped only when both its tickets already have five stronger or equal ones
		expect(out.every((r) => r.weight >= 1)).toBe(true);
	});

	it('S-86: a session that went from one ticket\'s branch to another\'s relates them, in the way it went', () => {
		const out = related(3, { s3: digest([], { branches: ['main', 'eng-1-ticket-1', 'eng-3-ticket-3'] }) });
		expect(out).toEqual([{ a: 'ENG-1', b: 'ENG-3', continued: true, weight: 0, shared: 0, files: [] }]);
		expect(reason(out[0], 'ENG-3')).toBe('a session came here from this');
		expect(reason(out[0], 'ENG-1')).toBe('a session went on from here to this');
	});

	it('S-86: going back and forth is one relation, the way it first went; it comes before shared files', () => {
		const out = related(3, {
			s1: digest(['x.ts'], { branches: ['eng-2-ticket-2', 'eng-1-ticket-1', 'eng-2-ticket-2'] }),
			s2: digest(['y.ts']),
			s3: digest(['y.ts'])
		});
		expect(out.map((r) => [r.a, r.b, r.continued])).toEqual([
			['ENG-2', 'ENG-1', true],
			['ENG-2', 'ENG-3', false]
		]);
		expect(reason({ ...out[0], shared: 2 }, 'ENG-1')).toBe('a session came here from this · 2 files in common');
	});

	it('S-86: a session with no ticket that began on a ticket\'s branch grew out of that ticket', () => {
		const loose = session('loose', null, { gone: false, name: 'try-something' });
		const out = related(2, { loose: digest([], { branches: ['eng-2-ticket-2', 'spike/new-idea'] }) }, [loose]);
		expect(out).toEqual([{ a: 'ENG-2', b: 'session:loose', continued: true, weight: 0, shared: 0, files: [] }]);
	});

	it('S-86: nothing read yet means no relations', () => {
		expect(related(3, {})).toEqual([]);
		expect(relationsOf(undefined, 'ENG-1')).toEqual([]);
	});
});

describe('the work that went into a ticket', () => {
	it('S-88: adds up its sessions, and joins the stretches of time that overlap', () => {
		const snap: Snapshot = {
			fetchedAt: '2026-10-20T12:00:00.000Z',
			demo: false,
			warnings: [],
			issues: [issue(1)],
			prs: [],
			sessions: [session('a', 1), session('b', 1), session('unread', 1)]
		};
		const [node] = buildGraph(snap).lanes[0].nodes;
		const work = workOf(node, {
			a: digest([], { minutes: 50, spans: [[100, 150]], costUSD: 1.25, tokens: 1000, added: 10, removed: 2 }),
			b: digest([], { minutes: 40, spans: [[140, 160], [300, 320]], costUSD: null, tokens: 500, added: 5, removed: 1 })
		});
		expect(work).toEqual({ minutes: 90, sessions: 2, added: 15, removed: 3, tokens: 1500, costUSD: 1.25, spans: [[100, 160], [300, 320]] });
		expect(workOf(node, {})).toBeUndefined();
	});

	it('S-88: stretches of time come out in order, touching ones as one', () => {
		expect(mergeSpans([[30, 40], [10, 20], [20, 25], [38, 50]])).toEqual([[10, 25], [30, 50]]);
		expect(mergeSpans([])).toEqual([]);
	});
});
