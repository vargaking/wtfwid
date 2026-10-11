import { describe, expect, it } from 'vitest';
import type { GraphNode, Session, SessionNote } from './model';
import { contextPack, resumeCommand } from './pack';

const ID = '11111111-2222-4333-8444-555555555555';
const session = (over: Partial<Session> = {}): Session => ({ id: ID, name: 'claude-07', cwd: '/home/dev/app', kind: 'interactive', startedAt: '2026-10-10T09:00:00.000Z', state: 'open', waitingFor: null, gone: true, branch: 'dev/eng-24-reconnect', ...over });
const note: SessionNote = {
	firstPrompt: 'Voice drops on a network switch. Find out why.',
	lastPrompt: 'ok do the ice restart',
	lastReply: 'Done.\n\nStill open: Firefox.',
	at: '2026-10-10T09:41:00.000Z',
	prs: [{ repo: 'acme/app', number: 118, url: 'https://github.com/acme/app/pull/118' }, { repo: 'acme/app', number: 119, url: 'https://github.com/acme/app/pull/119' }]
};
const ticket = (over: Partial<GraphNode> = {}): GraphNode => ({
	id: 'ENG-24', label: 'ENG-24', title: 'Reconnect after a network change', url: 'https://linear.app/acme/issue/ENG-24', at: '2026-10-10T09:00:00.000Z', state: 'open', stage: 'pr', status: 'In Progress',
	startedAt: '2026-10-10T09:00:00.000Z', completedAt: null, sessions: [session()],
	prs: [{ repo: 'acme/app', number: 118, title: 'Restart ICE on network change', url: 'https://github.com/acme/app/pull/118', branch: 'dev/eng-24-reconnect', state: 'open', createdAt: '2026-10-10T09:40:00.000Z' }],
	...over
});

describe('picking work up again', () => {
	it('S-59 gives the command that resumes a session in its own folder', () => {
		expect(resumeCommand(session())).toBe(`cd /home/dev/app && claude --resume ${ID}`);
	});

	it('S-59 quotes a folder the shell would otherwise split or expand', () => {
		expect(resumeCommand(session({ cwd: '/home/dev/my app' }))).toBe(`cd '/home/dev/my app' && claude --resume ${ID}`);
		expect(resumeCommand(session({ cwd: "/home/dev/it's $HOME; rm" }))).toBe(`cd '/home/dev/it'\\''s $HOME; rm' && claude --resume ${ID}`);
	});

	it('S-59 writes the command for PowerShell when the folder is a Windows one', () => {
		expect(resumeCommand(session({ cwd: 'C:\\Users\\me\\my app' }))).toBe(`cd 'C:\\Users\\me\\my app'; claude --resume ${ID}`);
		expect(resumeCommand(session({ cwd: "D:/work/it's" }))).toBe(`cd 'D:/work/it''s'; claude --resume ${ID}`);
		expect(resumeCommand(session({ cwd: '\\\\server\\share\\app' }))).toBe(`cd '\\\\server\\share\\app'; claude --resume ${ID}`);
	});

	it('S-59 offers nothing for a session that has no real id', () => {
		expect(resumeCommand(session({ id: '/home/dev/app@1791660811649' }))).toBeNull();
		expect(resumeCommand(session({ id: `${ID}; rm -rf ~` }))).toBeNull();
	});

	it('S-57 packs the ticket, its branch, pull requests and how the last session ended', () => {
		expect(contextPack(ticket(), { [ID]: note })).toBe(
			[
				'Continue work on ENG-24: Reconnect after a network change',
				'',
				'- Ticket: ENG-24, status "In Progress", https://linear.app/acme/issue/ENG-24',
				'- Started: 2026-10-10, not completed',
				'- Branch: dev/eng-24-reconnect',
				'- Folder: /home/dev/app',
				'- Pull request: #118 Restart ICE on network change (open), https://github.com/acme/app/pull/118',
				'- Pull request: #119, https://github.com/acme/app/pull/119',
				'',
				'## Earlier session "claude-07", started 2026-10-10',
				'',
				'It was started with:',
				'> Voice drops on a network switch. Find out why.',
				'',
				'The last thing I asked:',
				'> ok do the ice restart',
				'',
				'Where it ended (2026-10-10):',
				'> Done.',
				'>',
				'> Still open: Firefox.',
				'',
				'Read the ticket and the pull requests first. Then tell me where this stands and what is left, before changing anything.'
			].join('\n')
		);
	});

	it('S-57 says so when a session left no transcript, and still packs the rest', () => {
		const pack = contextPack(ticket(), { [ID]: null });
		expect(pack).toContain('Its transcript is not on this machine any more.');
		expect(pack).toContain('- Pull request: #118');
	});

	it('S-57 does not call a transcript gone when it only could not be read', () => {
		const pack = contextPack(ticket(), {});
		expect(pack).toContain('Its transcript could not be read just now.');
		expect(pack).not.toContain('not on this machine');
	});

	it('S-57 packs the files the earlier session changed most', () => {
		const files = Array.from({ length: 15 }, (_, i) => ({ path: `src/f${i}.ts`, edits: 20 - i, created: i === 1 }));
		const story = { startedAt: null, endedAt: null, activeMinutes: 0, prompts: [], promptCount: 0, files, commands: 0, toolCalls: 1, added: 0, removed: 0, tokens: { input: 0, output: 0, cached: 0 }, costUSD: null, branches: [], recent: [], spans: [] };
		const pack = contextPack(ticket(), { [ID]: { ...note, story } });
		expect(pack).toContain('Files it changed (the 12 it changed most, of 15):\n- src/f0.ts\n- src/f1.ts (new)\n- src/f2.ts');
		expect(pack).toContain('- src/f11.ts');
		expect(pack).not.toContain('src/f12.ts');
		expect(contextPack(ticket(), { [ID]: { ...note, story: { ...story, files: files.slice(0, 2) } } })).toContain('Files it changed:\n- src/f0.ts\n- src/f1.ts (new)');
	});

	it('S-86 names related work and the files it shares, so a new session knows where to look', () => {
		const other = ticket({ id: 'ENG-20', label: 'ENG-20', title: 'Join and leave a voice room', state: 'done', sessions: [] });
		const loose = ticket({ id: 'session:x', label: 'spike', title: 'spike', status: null, sessions: [] });
		const pack = contextPack(ticket(), {}, [
			{ node: other, relation: { a: 'ENG-20', b: 'ENG-24', continued: true, weight: 2, shared: 6, files: ['src/rtc/connection.ts', 'src/voice/room.ts'] } },
			{ node: loose, relation: { a: 'ENG-24', b: 'session:x', continued: true, weight: 0, shared: 0, files: [] } }
		]);
		expect(pack).toContain(
			'## Related work\n- ENG-20 Join and leave a voice room (done): a session came to this ticket from it; changed the same files: src/rtc/connection.ts, src/voice/room.ts and 4 more\n- spike (not finished): a session went on from this ticket to it'
		);
		expect(contextPack(ticket(), {})).not.toContain('Related work');
	});

	it('S-57 works for a session with no ticket', () => {
		const loose = ticket({ id: `session:${ID}`, label: 'try-bun-runti…', title: 'try-bun-runtime', url: null, status: null, prs: [] });
		const pack = contextPack(loose, { [ID]: { ...note, prs: [] } });
		expect(pack.split('\n')[0]).toBe('Continue this work: try-bun-runtime');
		expect(pack).not.toContain('- Ticket:');
	});
});
