import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LiveEvent, Session } from '../model';
import { createHub, readNew } from './live';
import { actionsFrom } from './story';

const ID = '11111111-2222-4333-8444-555555555555';
const CWD = '/home/dev/app';
const base = { isSidechain: false, cwd: CWD, sessionId: ID, gitBranch: 'main' };
const reply = (blocks: object[], at = '2026-10-10T09:00:00.000Z', more = {}) => JSON.stringify({ ...base, message: { id: 'm', role: 'assistant', content: blocks }, type: 'assistant', timestamp: at, ...more });
const use = (name: string, input: object) => ({ type: 'tool_use', id: 't', name, input });
const prompt = (text: string, more = {}) => JSON.stringify({ ...base, message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text }] }, type: 'user', timestamp: '2026-10-10T09:00:00.000Z', ...more });
const result = () => JSON.stringify({ ...base, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] }, type: 'user', timestamp: '2026-10-10T09:00:01.000Z' });
const session = (over: Partial<Session> = {}): Session => ({ id: ID, name: 'claude-07', cwd: CWD, kind: 'interactive', startedAt: '2026-10-10T09:00:00.000Z', state: 'working', waitingFor: null, gone: false, ...over });

async function claudeDir(lines: string[]) {
	const root = await mkdtemp(join(tmpdir(), 'wtfwid-claude-'));
	await mkdir(join(root, 'projects', '-home-dev-app'), { recursive: true });
	const file = join(root, 'projects', '-home-dev-app', `${ID}.jsonl`);
	await writeFile(file, lines.map((l) => l + '\n').join(''));
	return { root, file };
}

describe('one line of a transcript, as it happens', () => {
	it('S-85 says what Claude did, what it said and what you typed', () => {
		expect(actionsFrom(reply([{ type: 'text', text: 'Found it.\nThe client only listens for the socket.' }, use('Edit', { file_path: `${CWD}/src/voice.ts` }), use('TodoWrite', {})]), CWD)).toEqual([
			{ at: '2026-10-10T09:00:00.000Z', tool: 'says', text: 'Found it.' },
			{ at: '2026-10-10T09:00:00.000Z', tool: 'Edit', text: 'Editing src/voice.ts' }
		]);
		expect(actionsFrom(prompt('ok, restart ICE'), CWD)).toEqual([{ at: '2026-10-10T09:00:00.000Z', tool: 'you', text: 'ok, restart ICE' }]);
	});

	it('S-85 says nothing for results, housekeeping, a sub-agent or half a line', () => {
		expect(actionsFrom(result(), CWD)).toEqual([]);
		expect(actionsFrom(prompt('queued', { origin: { kind: 'task-notification' } }), CWD)).toEqual([]);
		expect(actionsFrom(reply([use('Bash', { command: 'ls' })], undefined, { isSidechain: true }), CWD)).toEqual([]);
		expect(actionsFrom('{"type":"mode","mode":"normal"}', CWD)).toEqual([]);
		expect(actionsFrom(reply([use('Bash', { command: 'ls' })]).slice(0, 80), CWD)).toEqual([]);
	});
});

describe('reading what was added to a file', () => {
	it('S-85 reads only the new part, in whole lines, and keeps the unfinished end for next time', async () => {
		const { file } = await claudeDir(['one', 'two']);
		const first = await readNew(file, 0, Buffer.alloc(0));
		expect(first).toMatchObject({ lines: ['one', 'two'], offset: 8 });
		await appendFile(file, 'three\nfo');
		const second = await readNew(file, first.offset, first.partial);
		expect(second.lines).toEqual(['three']);
		await appendFile(file, 'ur\n');
		expect((await readNew(file, second.offset, second.partial)).lines).toEqual(['four']);
		expect((await readNew(file, 20, Buffer.alloc(0))).lines).toEqual([]);
	});

	it('S-85 never splits a character that was written in two halves', async () => {
		const { file } = await claudeDir([]);
		const bytes = Buffer.from('Dániel ✓\n');
		await writeFile(file, bytes.subarray(0, 2)); // "D" and half of "á"
		const first = await readNew(file, 0, Buffer.alloc(0));
		expect(first.lines).toEqual([]);
		await appendFile(file, bytes.subarray(2));
		expect((await readNew(file, first.offset, first.partial)).lines).toEqual(['Dániel ✓']);
	});

	it('S-85 starts over from the end when the file was rewritten shorter', async () => {
		const { file } = await claudeDir(['a long first line', 'another']);
		await writeFile(file, 'short\n');
		expect(await readNew(file, 26, Buffer.from('left'))).toEqual({ lines: [], offset: 6, partial: Buffer.alloc(0) });
	});
});

describe('following running sessions', () => {
	it('S-85 greets a new window with the last things each running session did, then passes on what happens', async () => {
		const { root, file } = await claudeDir([reply([use('Read', { file_path: `${CWD}/src/voice.ts` })]), result()]);
		const hub = createHub({ list: async () => [session(), session({ id: 'ended', gone: true })], claude: root });
		const events: LiveEvent[] = [];
		const stop = await hub.subscribe((e) => events.push(e));
		expect(events).toEqual([{ type: 'hello', sessions: { [ID]: [{ at: '2026-10-10T09:00:00.000Z', tool: 'Read', text: 'Reading src/voice.ts' }] } }]);
		expect(hub.following).toEqual([ID]);

		await hub.tail();
		expect(events).toHaveLength(1); // nothing new, nothing said
		await appendFile(file, reply([use('Bash', { command: 'pnpm test', description: 'Run the tests' })], '2026-10-10T09:01:00.000Z') + '\n' + result() + '\n');
		await hub.tail();
		expect(events[1]).toEqual({ type: 'actions', id: ID, actions: [{ at: '2026-10-10T09:01:00.000Z', tool: 'Bash', text: 'Run the tests' }] });

		// a second window gets both, without the file being read from the start again
		const later: LiveEvent[] = [];
		const stopLater = await hub.subscribe((e) => later.push(e));
		expect(later[0]).toMatchObject({ type: 'hello', sessions: { [ID]: [{ text: 'Reading src/voice.ts' }, { text: 'Run the tests' }] } });
		stopLater();
		stop();
		expect(hub.following).toEqual([]);
	});

	it('S-85 says when a session starts, stops or changes state, and drops the ones that ended', async () => {
		const { root } = await claudeDir([]);
		let running = [session()];
		const hub = createHub({ list: async () => running, claude: root });
		const events: LiveEvent[] = [];
		const stop = await hub.subscribe((e) => events.push(e));
		await hub.relist();
		expect(events.filter((e) => e.type === 'sessions')).toHaveLength(0);
		running = [session({ state: 'needs', waitingFor: 'permission prompt' })];
		await hub.relist();
		running = [];
		await hub.relist();
		expect(events.filter((e) => e.type === 'sessions')).toHaveLength(2);
		expect(hub.following).toEqual([]);
		stop();
	});

	it('S-85 keeps following through a moment when the session list cannot be read', async () => {
		const { root, file } = await claudeDir([]);
		let fail = false;
		const hub = createHub({ list: async () => (fail ? Promise.reject(new Error('timed out')) : [session()]), claude: root });
		const events: LiveEvent[] = [];
		const stop = await hub.subscribe((e) => events.push(e));
		fail = true;
		await hub.relist();
		expect(hub.following).toEqual([ID]);
		expect(events.some((e) => e.type === 'sessions')).toBe(false);
		await appendFile(file, reply([use('Bash', { command: 'ls' })]) + '\n');
		await hub.tail();
		expect(events.at(-1)).toMatchObject({ type: 'actions', actions: [{ text: '$ ls' }] });
		stop();
	});

	it('S-85 asks for the session list again when the hint changes, and not otherwise', async () => {
		const { root } = await claudeDir([]);
		let asked = 0;
		let hint = 'a';
		const hub = createHub({ list: async () => (asked++, [session()]), hint: async () => hint, claude: root });
		const stop = await hub.subscribe(() => {});
		expect(asked).toBe(1);
		await hub.tick();
		await hub.tick();
		expect(asked).toBe(1);
		hint = 'b';
		await hub.tick();
		expect(asked).toBe(2);
		stop();
	});

	it('S-85 picks up the transcript of a session that had not written one yet', async () => {
		const { root, file } = await claudeDir([]);
		const other = '99999999-2222-4333-8444-555555555555';
		const hub = createHub({ list: async () => [session({ id: other })], claude: root });
		const events: LiveEvent[] = [];
		const stop = await hub.subscribe((e) => events.push(e));
		await hub.tail();
		await writeFile(file.replace(ID, other), reply([use('Bash', { command: 'echo hi' })]) + '\n');
		await hub.tail();
		expect(events.at(-1)).toMatchObject({ type: 'actions', id: other, actions: [{ text: '$ echo hi' }] });
		stop();
	});
});
