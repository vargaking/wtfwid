import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../graph';
import type { Session, SessionStory } from '../model';
import { demoDigests, demoSnapshot } from './demo';
import { createIndex, digestOf, mergeDigest } from './digest';
import { withDigests } from './related';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';

const session = (id: string, over: Partial<Session> = {}): Session => ({
	id,
	name: null,
	cwd: '/home/dev/app/.claude/worktrees/eng-1',
	kind: 'background',
	startedAt: '2026-10-01T09:00:00.000Z',
	state: 'open',
	waitingFor: null,
	gone: true,
	...over
});

const story = (over: Partial<SessionStory> = {}): SessionStory => ({
	startedAt: null, endedAt: null, activeMinutes: 0, prompts: [], promptCount: 0, files: [], commands: 0, toolCalls: 0,
	added: 0, removed: 0, tokens: { input: 0, output: 0, cached: 0 }, costUSD: null, branches: [], recent: [], spans: [],
	...over
});

// one line of a transcript, in the shape Claude Code 2.1.296 writes: an edit of one file
const edit = (file: string, at: string, cwd: string, branch = 'main') =>
	JSON.stringify({
		parentUuid: null,
		isSidechain: false,
		message: { id: `m-${at}`, role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: `${cwd}/${file}`, old_string: 'a', new_string: 'b\nc' } }], usage: { input_tokens: 10, output_tokens: 5 } },
		type: 'assistant',
		timestamp: at,
		cwd,
		gitBranch: branch
	});

async function folders(transcripts: Record<string, string[]> = {}) {
	const root = await mkdtemp(join(tmpdir(), 'wtfwid-index-'));
	const claude = join(root, 'claude');
	const home = join(root, 'home');
	const put = async (id: string, lines: string[], folder = '-home-dev-app') => {
		await mkdir(join(claude, 'projects', folder), { recursive: true });
		await writeFile(join(claude, 'projects', folder, `${id}.jsonl`), lines.join('\n') + '\n');
	};
	for (const [id, lines] of Object.entries(transcripts)) await put(id, lines);
	return { claude, home, put, file: (id: string) => join(claude, 'projects', '-home-dev-app', `${id}.jsonl`) };
}

describe('what is kept of a session', () => {
	it('S-86: the checkout without its worktree, the files, the branches, and when it was at it in minutes', () => {
		const d = digestOf(
			story({
				files: [{ path: 'src/a.ts', edits: 3, created: false }],
				branches: ['main', 'eng-1'],
				spans: [[Date.parse('2026-10-01T09:00:00Z'), Date.parse('2026-10-01T09:30:20Z')], [Date.parse('2026-10-01T11:00:00Z'), Date.parse('2026-10-01T11:00:05Z')]],
				activeMinutes: 31,
				added: 12,
				removed: 4,
				tokens: { input: 100, output: 50, cached: 9999 },
				costUSD: 0.5
			}),
			'/home/dev/app/.claude/worktrees/eng-1',
			'5:6',
			77
		);
		const m = (iso: string) => Date.parse(iso) / 60_000;
		expect(d).toEqual({
			stamp: '5:6',
			readAt: 77,
			root: '/home/dev/app',
			files: [{ path: 'src/a.ts', edits: 3 }],
			branches: ['main', 'eng-1'],
			spans: [[m('2026-10-01T09:00:00Z'), m('2026-10-01T09:30:00Z')], [m('2026-10-01T11:00:00Z'), m('2026-10-01T11:00:00Z')]],
			minutes: 30,
			added: 12,
			removed: 4,
			tokens: 150,
			costUSD: 0.5
		});
	});

	it('S-86: keeps the files a session edited most, not every one', () => {
		const files = Array.from({ length: 400 }, (_, i) => ({ path: `f${i}.ts`, edits: 400 - i, created: false }));
		expect(digestOf(story({ files }), '/r', 's', 0).files).toHaveLength(150);
	});
});

describe('reading a transcript again', () => {
	const d = (over: Partial<ReturnType<typeof digestOf>>) => ({ ...digestOf(story(), '/r', 's', 0), ...over });

	it('S-86: a transcript that only grew gives the same as reading it fresh', () => {
		const had = d({ files: [{ path: 'a.ts', edits: 2 }], branches: ['main', 'eng-1'], spans: [[100, 130]], minutes: 30, tokens: 500, costUSD: 1, added: 10, removed: 2 });
		const fresh = d({ stamp: 'later', files: [{ path: 'a.ts', edits: 5 }, { path: 'b.ts', edits: 1 }], branches: ['main', 'eng-1', 'eng-2'], spans: [[100, 150], [300, 320]], minutes: 70, tokens: 900, costUSD: 2.5, added: 30, removed: 4 });
		expect(mergeDigest(had, fresh)).toEqual(fresh);
		expect(mergeDigest(undefined, fresh)).toBe(fresh);
	});

	it('S-86: a transcript Claude Code rewrote shorter loses nothing that was known', () => {
		// before: three hours of work on a.ts and b.ts. After compacting, the file starts in the last half hour.
		const had = d({ files: [{ path: 'a.ts', edits: 9 }, { path: 'b.ts', edits: 4 }], branches: ['main', 'eng-1', 'eng-2'], spans: [[100, 200], [300, 380]], minutes: 180, tokens: 90_000, costUSD: 12, added: 400, removed: 90 });
		const fresh = d({ stamp: 'later', readAt: 9, files: [{ path: 'b.ts', edits: 1 }, { path: 'c.ts', edits: 3 }], branches: ['eng-1', 'eng-2', 'eng-3'], spans: [[350, 380], [500, 520]], minutes: 50, tokens: 20_000, costUSD: 14, added: 60, removed: 5 });
		expect(mergeDigest(had, fresh)).toMatchObject({
			stamp: 'later',
			readAt: 9,
			files: [{ path: 'a.ts', edits: 9 }, { path: 'b.ts', edits: 4 }, { path: 'c.ts', edits: 3 }],
			// joined where they overlap, so going back to eng-1 is not invented
			branches: ['main', 'eng-1', 'eng-2', 'eng-3'],
			spans: [[100, 200], [300, 380], [500, 520]],
			minutes: 200,
			tokens: 90_000,
			costUSD: 14,
			added: 400,
			removed: 90
		});
	});
});

describe('the index of sessions', () => {
	it('S-86: reads a real transcript, and the same file in two worktrees comes out as the same file', async () => {
		const cwd1 = '/home/dev/app/.claude/worktrees/eng-1';
		const cwd2 = '/home/dev/app/.claude/worktrees/eng-2';
		const dirs = await folders({
			[A]: [edit('src/shared.ts', '2026-10-01T09:00:00.000Z', cwd1), edit('src/shared.ts', '2026-10-01T09:02:00.000Z', cwd1, 'eng-1')],
			[B]: [edit('src/shared.ts', '2026-10-02T09:00:00.000Z', cwd2)]
		});
		const index = createIndex(dirs.home, { claude: dirs.claude });
		const out = await index.digests([session(A, { cwd: cwd1 }), session(B, { cwd: cwd2 })]);
		expect(out[A]).toMatchObject({ root: '/home/dev/app', files: [{ path: 'src/shared.ts', edits: 2 }], branches: ['main', 'eng-1'], minutes: 2 });
		expect(out[B]).toMatchObject({ root: '/home/dev/app', files: [{ path: 'src/shared.ts', edits: 1 }] });
		expect(out[A].spans).toEqual([[Date.parse('2026-10-01T09:00:00Z') / 60_000, Date.parse('2026-10-01T09:02:00Z') / 60_000]]);
	});

	it('S-86: a transcript is read once, again when it changed, and kept when it is gone', async () => {
		const dirs = await folders({ [A]: ['{}'], [B]: ['{}'] });
		const reads: string[] = [];
		const read = async (file: string) => (reads.push(file.slice(-42, -6)), story({ files: [{ path: `v${reads.length}.ts`, edits: 1, created: false }] }));
		const index = createIndex(dirs.home, { claude: dirs.claude, read });
		const both = [session(A), session(B)];

		await index.digests(both);
		expect(reads.sort()).toEqual([A, B]);
		await index.digests(both);
		expect(reads).toHaveLength(2);

		// A's transcript grows: only A is read again
		await writeFile(dirs.file(A), '{}\n{}\n');
		const after = await index.digests(both);
		expect(reads).toHaveLength(3);
		// what the first reading found is still there next to what the new one found
		expect(after[A].files.map((f) => f.path)).toEqual(['v1.ts', 'v3.ts']);

		// Claude Code deletes B's transcript: what was read stands, also for a fresh start of the app
		await rm(dirs.file(B));
		expect((await index.digests(both))[B]).toBeDefined();
		const restarted = createIndex(dirs.home, { claude: dirs.claude, read });
		const again = await restarted.digests(both);
		expect(again[B]).toBeDefined();
		expect(again[A].files.map((f) => f.path)).toEqual(['v1.ts', 'v3.ts']);
		expect(reads).toHaveLength(3);
	});

	it('S-86: a running session, which writes all the time, is read again at most every two minutes', async () => {
		const dirs = await folders({ [A]: ['{}'] });
		let reads = 0;
		let clock = 1_000_000;
		const index = createIndex(dirs.home, { claude: dirs.claude, read: async () => (reads++, story()), now: () => clock });
		const live = [session(A, { gone: false, state: 'working' })];
		await index.digests(live);
		await writeFile(dirs.file(A), '{}\n{}\n');
		clock += 30_000;
		await index.digests(live);
		expect(reads).toBe(1);
		clock += 120_000;
		await index.digests(live);
		expect(reads).toBe(2);
		// once it has ended, a change is read at once
		await writeFile(dirs.file(A), '{}\n{}\n{}\n');
		await index.digests([session(A)]);
		expect(reads).toBe(3);
	});

	it('S-86: when there is more to read than fits, it answers with what it has and reads the rest afterwards', async () => {
		const dirs = await folders({ [A]: ['{}'], [B]: ['{}'], [C]: ['{}'] });
		let clock = 0;
		const read = async () => ((clock += 1000), story());
		const index = createIndex(dirs.home, { claude: dirs.claude, read, now: () => clock, budgetMs: 1500 });
		// newest first: C, then B, then A
		const all = [session(A, { startedAt: '2026-10-01T00:00:00Z' }), session(B, { startedAt: '2026-10-02T00:00:00Z' }), session(C, { startedAt: '2026-10-03T00:00:00Z' })];
		let told = 0;
		const first = await index.digests(all, () => told++);
		expect(Object.keys(first).sort()).toEqual([B, C]);
		await index.settled();
		expect(told).toBe(1);
		expect(Object.keys(await index.digests(all, () => told++)).sort()).toEqual([A, B, C]);
		expect(told).toBe(1);
	});

	it('S-86: the index is kept readable only by you, and a broken one just means reading again', async () => {
		const dirs = await folders({ [A]: ['{}'] });
		let reads = 0;
		const read = async () => (reads++, story());
		await createIndex(dirs.home, { claude: dirs.claude, read }).digests([session(A)]);
		const file = join(dirs.home, 'index.json');
		if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect(Object.keys(JSON.parse(await readFile(file, 'utf8')).sessions)).toEqual([A]);

		await writeFile(file, '{ not json');
		const out = await createIndex(dirs.home, { claude: dirs.claude, read }).digests([session(A)]);
		expect(out[A]).toBeDefined();
		expect(reads).toBe(2);
	});

	it('S-86: a session with no transcript and nothing kept is simply not in the answer', async () => {
		const dirs = await folders();
		expect(await createIndex(dirs.home, { claude: dirs.claude }).digests([session(A)])).toEqual({});
	});

	it('S-86: a session that changed folder is read from the file written to last', async () => {
		const dirs = await folders({ [A]: ['{}'] });
		await dirs.put(A, ['{}', '{}'], '-home-dev-other');
		const old = new Date('2026-01-01T00:00:00Z');
		await utimes(dirs.file(A), old, old);
		const seen: string[] = [];
		await createIndex(dirs.home, { claude: dirs.claude, read: async (file) => (seen.push(file), story()) }).digests([session(A)]);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain('-home-dev-other');
	});
});

describe('relations on a graph', () => {
	it('S-86, S-88: the demo has relations and work to show, made the same way as real ones', () => {
		const now = Date.parse('2026-10-10T12:00:00.000Z');
		const snapshot = demoSnapshot(now);
		const graph = withDigests(buildGraph(snapshot), snapshot, demoDigests(now));
		const of = (a: string, b: string) => graph.relations!.find((r) => r.a === a && r.b === b);
		// screen share began in a session that was on the voice room ticket
		expect(of('DEMO-20', 'DEMO-30')).toMatchObject({ continued: true, shared: 2 });
		expect(of('DEMO-45', 'DEMO-47')).toMatchObject({ continued: true });
		expect(of('DEMO-10', 'DEMO-11')).toMatchObject({ continued: false, files: ['src/messages/store.ts'] });
		const node = graph.lanes.flatMap((l) => l.nodes).find((n) => n.id === 'DEMO-24')!;
		expect(node.work!.minutes).toBeGreaterThan(0);
		expect(node.work!.spans.length).toBeGreaterThan(1);
		// a ticket nobody ran a session on has no work to show
		expect(graph.lanes.flatMap((l) => l.nodes).find((n) => n.id === 'DEMO-33')!.work).toBeUndefined();
	});
});
