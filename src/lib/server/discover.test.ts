import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../graph';
import type { Issue, Session } from '../model';
import { discoverSessions } from './discover';
import { collectSessions, remember } from './sessions';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';

// Lines in the shape Claude Code 2.1.296 writes them: the fields about the entry come after the message.
const line = (type: string, text: string, at: string, more: Record<string, unknown> = {}) =>
	JSON.stringify({ parentUuid: null, isSidechain: false, message: { role: type, content: text }, type, timestamp: at, cwd: '/home/dev/app', sessionId: A, version: '2.1.296', gitBranch: 'main', ...more });
const mark = (entry: Record<string, unknown>) => JSON.stringify({ ...entry, sessionId: A });

async function claudeDir(files: Record<string, string[]>) {
	const root = await mkdtemp(join(tmpdir(), 'wtfwid-claude-'));
	for (const [path, lines] of Object.entries(files)) {
		await mkdir(join(root, 'projects', path, '..'), { recursive: true });
		await writeFile(join(root, 'projects', path), lines.join('\n') + '\n');
	}
	return root;
}

describe('past sessions on disk', () => {
	it('S-83 reads a session from its transcript: where, when, its name and its branch', async () => {
		const root = await claudeDir({
			[`-home-dev-app/${A}.jsonl`]: [
				mark({ type: 'mode', mode: 'normal' }),
				line('user', 'fix the reconnect', '2026-10-01T09:00:00.000Z'),
				line('assistant', 'x'.repeat(50_000), '2026-10-01T09:05:00.000Z', { gitBranch: 'dev/eng-24-reconnect' }),
				mark({ type: 'ai-title', aiTitle: 'Fix reconnect' }),
				line('assistant', 'done', '2026-10-01T10:30:00.000Z', { gitBranch: 'dev/eng-24-reconnect' }),
				mark({ type: 'last-prompt', lastPrompt: 'fix the reconnect' })
			]
		});
		expect(await discoverSessions(root)).toEqual([
			{
				id: A, name: 'Fix reconnect', cwd: '/home/dev/app', kind: 'interactive', startedAt: '2026-10-01T09:00:00.000Z', state: 'open', waitingFor: null, gone: true,
				branch: 'dev/eng-24-reconnect', fromDisk: true, lastAt: '2026-10-01T10:30:00.000Z'
			}
		]);
	});

	it('S-83 prefers the name you gave a session to the one Claude Code made up', async () => {
		const root = await claudeDir({
			[`p/${A}.jsonl`]: [line('user', 'x', '2026-10-01T09:00:00.000Z'), mark({ type: 'ai-title', aiTitle: 'Made up' }), mark({ type: 'custom-title', customTitle: 'ENG-24 "reconnect"' }), mark({ type: 'ai-title', aiTitle: 'Made up again' })]
		});
		expect((await discoverSessions(root))[0].name).toBe('ENG-24 "reconnect"');
	});

	it('S-83 skips what is not a session of its own, and survives odd files', async () => {
		const root = await claudeDir({
			[`p/${A}.jsonl`]: [line('user', 'a real one', '2026-10-02T09:00:00.000Z', { gitBranch: 'HEAD' })],
			[`p/${B}.jsonl`]: [line('user', 'a sub-agent', '2026-10-02T09:00:00.000Z', { isSidechain: true })],
			'p/agent-12ab.jsonl': [line('user', 'not a session file', '2026-10-02T09:00:00.000Z')],
			'p/cccccccc-3333-4333-8333-333333333333.jsonl': ['not json', '{"type":"mode"}'],
			'p/notes.txt': ['hello']
		});
		const found = await discoverSessions(root);
		expect(found.map((s) => [s.id, s.branch])).toEqual([[A, null]]); // a detached HEAD is no branch
		expect(await discoverSessions(join(root, 'nothing-here'))).toEqual([]);
	});

	it('S-83 takes the newer file when a session moved folder', async () => {
		const root = await claudeDir({
			[`-home-dev/${A}.jsonl`]: [line('user', 'x', '2026-10-01T09:00:00.000Z', { cwd: '/home/dev' })],
			[`-home-dev-app/${A}.jsonl`]: [line('user', 'y', '2026-10-01T12:00:00.000Z', { cwd: '/home/dev/app', gitBranch: 'dev/eng-9' })]
		});
		await utimes(join(root, 'projects', '-home-dev', `${A}.jsonl`), new Date(), new Date(Date.now() - 60_000));
		// where it is now, but begun when its first file was
		expect((await discoverSessions(root)).map((s) => [s.cwd, s.branch, s.startedAt])).toEqual([['/home/dev/app', 'dev/eng-9', '2026-10-01T09:00:00.000Z']]);
	});

	const listed = (id: string, over: Partial<Session> = {}): Session => ({ id, name: null, cwd: '/home/dev/app', kind: 'interactive', startedAt: '2026-10-05T09:00:00.000Z', state: 'working', waitingFor: null, gone: false, ...over });
	const disk = (id: string, over: Partial<Session> = {}): Session => ({ ...listed(id), state: 'open', gone: true, fromDisk: true, name: 'From its transcript', branch: 'dev/eng-24', lastAt: '2026-10-05T10:00:00.000Z', ...over });

	it('S-83 adds a session found on disk once, and lets the listed version win', () => {
		expect(remember([], [], [disk(A)])).toEqual([disk(A)]);
		// listed now: what Claude Code says about it stands
		expect(remember([], [listed(A)], [disk(A)])).toEqual([listed(A)]);
		// seen listed before, gone now: it stays a session wtfwid saw, with what its transcript knows
		expect(remember([listed(A)], [], [disk(A)])).toEqual([{ ...listed(A), state: 'open', gone: true, name: 'From its transcript', branch: 'dev/eng-24', lastAt: '2026-10-05T10:00:00.000Z' }]);
		// already remembered from disk: not added a second time
		expect(remember([disk(A)], [], [disk(A, { lastAt: '2026-10-06T10:00:00.000Z' })])).toEqual([disk(A, { lastAt: '2026-10-06T10:00:00.000Z' })]);
	});

	it('S-83 keeps a found session after its transcript is deleted', async () => {
		const home = await mkdtemp(join(tmpdir(), 'wtfwid-'));
		const root = await claudeDir({ [`p/${A}.jsonl`]: [line('user', 'x', '2026-10-01T09:00:00.000Z', { gitBranch: 'dev/eng-24' })] });
		expect((await collectSessions(home, async () => [], root)).map((s) => [s.id, s.fromDisk, s.branch])).toEqual([[A, true, 'dev/eng-24']]);
		// Claude Code clears old transcripts after a few weeks
		expect((await collectSessions(home, async () => [], join(root, 'gone'))).map((s) => [s.id, s.branch])).toEqual([[A, 'dev/eng-24']]);
	});

	it('S-83 draws a found session on its ticket, and leaves out the ones that match no ticket', () => {
		const issue: Issue = {
			id: 'ENG-24', title: 'Reconnect', url: 'u', createdAt: '2026-10-01T08:00:00.000Z', startedAt: null, completedAt: null, canceledAt: null,
			stateName: 'Backlog', stateType: 'backlog', branchName: 'dev/eng-24-reconnect', project: null, milestone: null
		};
		const graph = buildGraph({
			fetchedAt: '2026-10-10T12:00:00.000Z', demo: false, warnings: [], issues: [issue], prs: [],
			sessions: [disk(A, { branch: 'dev/eng-24-reconnect' }), disk(B, { branch: 'some/other-project', cwd: '/home/dev/elsewhere' }), listed('live-one', { name: 'scratch' })]
		});
		// the ticket appears because a session worked on it; the unmatched live session is still shown, the unmatched past one is not
		expect(graph.lanes.map((l) => [l.name, l.nodes.map((n) => n.id)])).toEqual([['No project', ['ENG-24']], ['Unsorted', ['session:live-one']]]);
		expect(graph.lanes[0].nodes[0]).toMatchObject({ stage: 'session', state: 'open' });
	});
});
