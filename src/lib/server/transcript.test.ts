import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../graph';
import type { Issue, Session } from '../model';
import { collectSessions } from './sessions';
import { findTranscript, lastBranch, noteFrom, readNote } from './transcript';

// Lines in the shape Claude Code 2.1.296 writes them. The words are made up.
const ID = '11111111-2222-4333-8444-555555555555';
const base = { isSidechain: false, userType: 'external', cwd: '/home/dev/app', sessionId: ID, version: '2.1.296', gitBranch: 'dev/eng-24-reconnect' };
const typed = (content: unknown, more = {}) => JSON.stringify({ parentUuid: null, ...base, type: 'user', message: { role: 'user', content }, uuid: 'u', timestamp: '2026-10-10T09:00:00.000Z', ...more });
const toolResult = () => typed([{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(2000) }]);
const said = (content: unknown[], timestamp: string, more = {}) =>
	JSON.stringify({ parentUuid: 'u', ...base, message: { id: 'm', type: 'message', role: 'assistant', content }, type: 'assistant', uuid: 'a', timestamp, ...more });
const prLink = (n: number) => JSON.stringify({ type: 'pr-link', sessionId: ID, prNumber: n, prUrl: `https://github.com/acme/app/pull/${n}`, prRepository: 'acme/app' });
const lastPrompt = (text: string) => JSON.stringify({ type: 'last-prompt', lastPrompt: text, leafUuid: 'x', sessionId: ID });

const LINES = [
	typed('Voice drops on a network switch. Find out why.'),
	said([{ type: 'thinking', thinking: '' }], '2026-10-10T09:01:00.000Z'),
	said([{ type: 'tool_use', id: 't', name: 'Grep', input: {} }], '2026-10-10T09:01:01.000Z'),
	toolResult(),
	said([{ type: 'text', text: 'The client only listens for the socket closing.' }], '2026-10-10T09:05:00.000Z'),
	typed('<command-name>/model</command-name>'),
	typed('this is a summary of the conversation so far', { isCompactSummary: true }),
	typed('injected', { isMeta: true }),
	typed([{ type: 'text', text: 'ok do the ice restart' }]),
	said([{ type: 'text', text: 'a sub-agent talking' }], '2026-10-10T09:30:00.000Z', { isSidechain: true }),
	prLink(118),
	prLink(118),
	said([{ type: 'text', text: 'Done.\n\n\n\nStill open: Firefox.' }, { type: 'tool_use', id: 't2', name: 'Bash', input: {} }], '2026-10-10T09:41:00.000Z'),
	said([{ type: 'tool_use', id: 't3', name: 'Bash', input: {} }], '2026-10-10T09:42:00.000Z'),
	lastPrompt('ok do the ice restart'),
	'{"type":"assistant","message":{"content":[{"type":"text","text":"cut off mid-wri'
];

describe('session transcripts', () => {
	it('S-55 reads what a session was asked and what it last said', () => {
		expect(noteFrom(LINES)).toEqual({
			firstPrompt: 'Voice drops on a network switch. Find out why.',
			lastPrompt: 'ok do the ice restart',
			lastReply: 'Done.\n\nStill open: Firefox.',
			at: '2026-10-10T09:41:00.000Z',
			prs: [{ repo: 'acme/app', number: 118, url: 'https://github.com/acme/app/pull/118' }]
		});
	});

	it('S-55 uses the last thing typed when the transcript does not mark a last prompt', () => {
		const note = noteFrom(LINES.filter((l) => !l.includes('"last-prompt"')));
		expect(note.lastPrompt).toBe('ok do the ice restart');
	});

	it('S-55 cuts long text short', () => {
		const note = noteFrom([typed('a'.repeat(900)), said([{ type: 'text', text: 'b'.repeat(5000) }], '2026-10-10T09:41:00.000Z')]);
		expect(note.firstPrompt).toHaveLength(400);
		expect(note.lastReply).toHaveLength(1200);
		expect(note.lastReply?.endsWith('…')).toBe(true);
	});

	it('S-55 says nothing about an empty or foreign file', () => {
		expect(noteFrom(['', 'not json', '{"type":"something-new","message":"hi"}'])).toEqual({ firstPrompt: null, lastPrompt: null, lastReply: null, at: null, prs: [] });
	});

	async function claudeDir(folder: string, lines: string[]) {
		const root = await mkdtemp(join(tmpdir(), 'wtfwid-claude-'));
		await mkdir(join(root, 'projects', folder), { recursive: true });
		await writeFile(join(root, 'projects', folder, `${ID}.jsonl`), lines.join('\n') + '\n');
		return root;
	}

	it('S-55 finds a transcript by the folder Claude Code names after the working directory', async () => {
		const root = await claudeDir('-home-dev-my-app', LINES);
		const file = await findTranscript(ID, '/home/dev/my.app', root);
		expect(file).toBe(join(root, 'projects', '-home-dev-my-app', `${ID}.jsonl`));
		expect((await readNote(file!)).lastReply).toBe('Done.\n\nStill open: Firefox.');
	});

	it('S-55 looks in the other folders when the name does not match, and gives up quietly', async () => {
		const root = await claudeDir('somewhere-else', LINES);
		expect(await findTranscript(ID, '/home/dev/app', root)).toBe(join(root, 'projects', 'somewhere-else', `${ID}.jsonl`));
		expect(await findTranscript('00000000-0000-4000-8000-000000000000', '/home/dev/app', root)).toBeNull();
		expect(await findTranscript(ID, '/home/dev/app', join(root, 'missing'))).toBeNull();
	});

	it('S-55 never turns a session id into a path outside the transcripts', async () => {
		const root = await claudeDir('-home-dev-app', LINES);
		for (const id of ['../../etc/passwd', `../-home-dev-app/${ID}`, 'a/b', '..', '']) expect(await findTranscript(id, '/home/dev/app', root)).toBeNull();
	});

	it('S-50 reads the branch a session was last on', async () => {
		const root = await claudeDir('-home-dev-app', [...LINES, typed('next', { gitBranch: 'dev/eng-25-echo' })]);
		const file = (await findTranscript(ID, '/home/dev/app', root))!;
		expect(await lastBranch(file)).toBe('dev/eng-25-echo');
		const detached = await claudeDir('-home-dev-app', [typed('x', { gitBranch: 'HEAD' })]);
		expect(await lastBranch((await findTranscript(ID, '/home/dev/app', detached))!)).toBeNull();
	});

	const session = (over: Partial<Session> = {}): Session => ({ id: ID, name: 'claude-07', cwd: '/home/dev/app', kind: 'interactive', startedAt: '2026-10-10T09:00:00.000Z', state: 'working', waitingFor: null, gone: false, ...over });

	it('S-50 remembers the branch with the session, and keeps it when the transcript is gone', async () => {
		const home = await mkdtemp(join(tmpdir(), 'wtfwid-'));
		const root = await claudeDir('-home-dev-app', LINES);
		const [first] = await collectSessions(home, async () => [session()], root);
		expect(first.branch).toBe('dev/eng-24-reconnect');
		const [later] = await collectSessions(home, async () => [session()], join(root, 'missing'));
		expect(later.branch).toBe('dev/eng-24-reconnect');
		const [ended] = await collectSessions(home, async () => [], root);
		expect(ended).toMatchObject({ gone: true, branch: 'dev/eng-24-reconnect' });
	});

	it('S-50 links a session to its ticket by the branch it is on, whatever it is called', () => {
		const issue: Issue = {
			id: 'ENG-24', title: 'Reconnect', url: 'https://linear.app/x/issue/ENG-24', createdAt: '2026-10-09T09:00:00.000Z', startedAt: null, completedAt: null, canceledAt: null,
			stateName: 'Todo', stateType: 'unstarted', branchName: 'dev/eng-24-reconnect', project: null, milestone: null
		};
		const snap = (sessions: Session[]) => ({ fetchedAt: '2026-10-10T12:00:00.000Z', demo: false, warnings: [], issues: [issue], prs: [], sessions });
		const linked = buildGraph(snap([session({ branch: 'dev/eng-24-reconnect' })]));
		expect(linked.lanes.map((l) => l.name)).toEqual(['No project']);
		expect(linked.lanes[0].nodes[0]).toMatchObject({ id: 'ENG-24', state: 'working', stage: 'session' });
		// without the branch there is nothing to go on
		expect(buildGraph(snap([session()])).lanes.map((l) => l.name)).toEqual(['Unsorted']);
	});
});
