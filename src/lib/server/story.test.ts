import { describe, expect, it } from 'vitest';
import { actionsFrom, describeAction, minutesOf, relative, storyFrom, storyReader, withAgents } from './story';

const CWD = '/home/dev/app';
const base = { isSidechain: false, cwd: CWD, sessionId: 's', version: '2.1.296' };
let n = 0;
const at = (minute: number) => `2026-10-10T09:${String(minute).padStart(2, '0')}:00.000Z`;
const prompt = (text: string, minute: number, more = {}) => JSON.stringify({ parentUuid: null, ...base, message: { role: 'user', content: text }, type: 'user', timestamp: at(minute), gitBranch: 'main', ...more });
const reply = (id: string, blocks: object[], minute: number, more = {}) =>
	JSON.stringify({ parentUuid: 'u', ...base, message: { id, role: 'assistant', content: blocks, usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 1000, output_tokens: 50 } }, type: 'assistant', timestamp: at(minute), gitBranch: 'main', ...more });
const use = (name: string, input: object) => ({ type: 'tool_use', id: `t${++n}`, name, input });
const result = (minute: number) => JSON.stringify({ parentUuid: 'a', ...base, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(4000) }] }, type: 'user', timestamp: at(minute), gitBranch: 'main' });

const LINES = [
	prompt('Voice drops on a network switch. Find out why.', 0),
	reply('m1', [use('Grep', { pattern: 'reconnect' })], 1),
	result(1),
	reply('m2', [{ type: 'text', text: 'Found it.' }], 2),
	// one reply written as two lines, each carrying the same token count
	reply('m2', [use('Read', { file_path: `${CWD}/src/voice.ts` })], 2),
	result(2),
	prompt('ok, restart ICE and add a test', 20, { gitBranch: 'dev/eng-24' }),
	reply('m3', [use('Edit', { file_path: `${CWD}/src/voice.ts`, old_string: 'a\nb', new_string: 'a\nb\nc\nd' })], 21, { gitBranch: 'dev/eng-24' }),
	result(21),
	reply('m4', [use('Write', { file_path: `${CWD}/src/voice.test.ts`, content: 'one\ntwo\nthree' }), use('Bash', { command: 'pnpm test\n# again', description: 'Run the tests' })], 22, { gitBranch: 'dev/eng-24' }),
	result(26),
	reply('m5', [use('MultiEdit', { file_path: `${CWD}/src/voice.ts`, edits: [{ old_string: 'x', new_string: 'y\nz' }, { old_string: 'p\nq', new_string: 'r' }] }), use('TodoWrite', { todos: [] })], 27, { gitBranch: 'dev/eng-24' }),
	reply('side', [use('Bash', { command: 'rm -rf /' })], 28, { isSidechain: true }),
	prompt('<system-reminder>injected</system-reminder>', 29, { gitBranch: 'dev/eng-24' }),
	JSON.stringify({ type: 'cost-state', sessionId: 's', totalCostUSD: 1.25 }),
	'{"type":"assistant","timestamp":"2026-10-10T09:30:00.000Z","message":{"content":[{"type":"tool_use","name":"Bash","inp'
];

describe('what a session did', () => {
	const story = storyFrom(LINES, CWD);

	it('S-88 says when it was at it: a pause of more than five minutes ends a stretch', () => {
		const ms = (minute: number) => Date.parse(at(minute));
		// 09:00 to 09:02, then nothing until the prompt at 09:20
		expect(story.spans).toEqual([[ms(0), ms(2)], [ms(20), ms(29)]]);
	});

	it('S-84 lists the files it edited, most edited first, and says which it made', () => {
		expect(story.files).toEqual([
			{ path: 'src/voice.ts', edits: 2, created: false },
			{ path: 'src/voice.test.ts', edits: 1, created: true }
		]);
	});

	it('S-84 counts commands, tool calls and roughly the lines written and replaced', () => {
		expect(story).toMatchObject({ commands: 1, toolCalls: 7, added: 4 + 3 + 2 + 1, removed: 2 + 1 + 2 });
	});

	it('S-84 keeps what you typed in order, without what Claude Code put there', () => {
		expect(story.promptCount).toBe(2);
		expect(story.prompts).toEqual([
			{ at: at(0), text: 'Voice drops on a network switch. Find out why.' },
			{ at: at(20), text: 'ok, restart ICE and add a test' }
		]);
	});

	it('S-84 measures the time it was at it, leaving out the pause while you were away', () => {
		// 09:00 to 09:02, then nothing until 09:20, then to 09:29 with a four-minute command in it
		expect(story).toMatchObject({ startedAt: at(0), endedAt: at(29), activeMinutes: 2 + 9 });
	});

	it('S-84 counts the tokens of a reply once, however many lines it was written as', () => {
		expect(story.tokens).toEqual({ input: 5 * 100, output: 5 * 50, cached: 5 * 1000 });
		expect(story.costUSD).toBe(1.25);
	});

	it('S-84 follows the branches it was on, and leaves a sub-agent out of everything', () => {
		expect(story.branches).toEqual(['main', 'dev/eng-24']);
		expect(JSON.stringify(story)).not.toContain('rm -rf');
	});

	it('S-84 remembers the last things it did, in a few words each', () => {
		expect(story.recent.map((a) => a.text)).toEqual(['Searching for reconnect', 'Reading src/voice.ts', 'Editing src/voice.ts', 'Writing src/voice.test.ts', 'Run the tests', 'Editing src/voice.ts']);
		expect(storyFrom(Array.from({ length: 30 }, (_, i) => reply(`r${i}`, [use('Bash', { command: `echo ${i}` })], i)), CWD).recent.map((a) => a.text).slice(-2)).toEqual(['$ echo 28', '$ echo 29']);
	});

	it('S-84 keeps the first prompt and the latest ones when there were very many', () => {
		const long = storyFrom(Array.from({ length: 60 }, (_, i) => prompt(`prompt ${i}`, i % 60)), CWD);
		expect(long.promptCount).toBe(60);
		expect(long.prompts).toHaveLength(40);
		expect([long.prompts[0].text, long.prompts[1].text, long.prompts.at(-1)!.text]).toEqual(['prompt 0', 'prompt 21', 'prompt 59']);
	});

	it('S-84 says a tool call in words, and shortens paths to the session folder', () => {
		expect(describeAction('Bash', { command: 'pnpm test --run\nsecond line' }, CWD)).toBe('$ pnpm test --run');
		expect(describeAction('WebFetch', { url: 'https://linear.app/docs/api' }, CWD)).toBe('Fetching linear.app');
		expect(describeAction('WebFetch', { url: 'not a url' }, CWD)).toBe('Fetching a page');
		expect(describeAction('Agent', { description: 'Review the server side' }, CWD)).toBe('Handing off: Review the server side');
		expect(describeAction('mcp__Linear__list_issues', {}, CWD)).toBe('Linear: list issues');
		expect(describeAction('TaskUpdate', {}, CWD)).toBeNull();
		expect(describeAction('SomethingNew', {}, CWD)).toBe('SomethingNew');
		expect(relative('/home/dev/app/src/a.ts', '/home/dev/app/')).toBe('src/a.ts');
		expect(relative('/home/dev/application/a.ts', '/home/dev/app')).toBe('/home/dev/application/a.ts');
		expect(relative('C:\\work\\app\\src\\a.ts', 'C:\\work\\app')).toBe('src\\a.ts');
	});

	it('S-84 makes nothing up from an empty or foreign file', () => {
		expect(storyFrom(['', 'not json', '{"type":"mode"}'], CWD)).toMatchObject({ startedAt: null, activeMinutes: 0, prompts: [], files: [], toolCalls: 0, tokens: { input: 0, output: 0, cached: 0 }, costUSD: null });
	});
});

describe('what the reader does not miss', () => {
	it('S-84 counts the wait for a long command or a sub-agent as work, up to an hour', () => {
		const lines = [
			prompt('run the whole suite', 0),
			reply('a1', [use('Bash', { command: 'pnpm test:all' })], 1),
			// the command came back 25 minutes later: the session was at work, not idle
			result(26),
			reply('a2', [{ type: 'text', text: 'All green.' }], 27),
			// and then you were away for half an hour before typing again
			prompt('ship it', 57)
		];
		const story = storyFrom(lines, CWD);
		expect(story.activeMinutes).toBe(27);
		expect(story.spans).toHaveLength(2);
		// a tool that waited for your permission overnight is not a night of work
		const night = [prompt('go', 0), reply('b1', [use('Bash', { command: 'rm x' })], 1), JSON.stringify({ ...JSON.parse(result(2)), timestamp: '2026-10-11T07:00:00.000Z' })];
		expect(storyFrom(night, CWD).activeMinutes).toBe(1);
	});

	it('S-84 adds up what each run of a resumed session cost', () => {
		const cost = (startTime: number, totalCostUSD: number) => JSON.stringify({ type: 'cost-state', sessionId: 's', startTime, totalCostUSD });
		// three runs; within a run the total only grows, and a new run starts from nothing
		const story = storyFrom([prompt('a', 0), cost(1, 5), cost(1, 11.56), cost(2, 30), cost(2, 64.15), cost(3, 0.42)], CWD);
		expect(story.costUSD).toBeCloseTo(76.13, 2);
		expect(storyFrom([prompt('a', 0)], CWD).costUSD).toBeNull();
	});

	it('S-84 counts what a session\'s sub-agents edited and when they were at it', () => {
		const side = { isSidechain: true };
		const main = storyFrom([prompt('build it', 0), reply('m1', [use('Agent', { description: 'Build the strip' })], 1), reply('m2', [use('Edit', { file_path: `${CWD}/src/a.ts`, old_string: 'a', new_string: 'b' })], 2)], CWD);
		const agent = storyReader(CWD, true);
		for (const line of [
			// what the session told its sub-agent is not something you typed
			prompt('You are building one feature…', 3, side),
			reply('s1', [use('Write', { file_path: `${CWD}/.claude/worktrees/agent-1/src/strip.ts`, content: 'one\ntwo' })], 4, side),
			result(5),
			reply('s2', [use('Edit', { file_path: `${CWD}/src/a.ts`, old_string: 'x', new_string: 'y\nz' }), use('Bash', { command: 'pnpm test' })], 8, side),
			// a line of the session itself that ended up here is not the sub-agent's
			reply('m9', [use('Bash', { command: 'echo no' })], 9)
		]) agent.add(line);
		const all = withAgents(main, [agent.done()]);
		expect(all.files).toEqual([
			{ path: 'src/a.ts', edits: 2, created: false },
			{ path: '.claude/worktrees/agent-1/src/strip.ts', edits: 1, created: true }
		]);
		expect(all).toMatchObject({ promptCount: 1, commands: 1, toolCalls: 5, added: 1 + 2 + 2, removed: 1 + 1 });
		// 09:00 to 09:02 by the session, on to 09:08 by its sub-agent: one stretch, counted once
		expect(all.spans).toHaveLength(1);
		expect(all.activeMinutes).toBe(8);
		expect(minutesOf(all.spans)).toBe(8);
		expect(withAgents(main, [])).toBe(main);
	});

	it('S-55 a line that is not what it should be is skipped, never an error', () => {
		const odd = [
			JSON.stringify({ type: 'assistant', timestamp: at(1), message: { content: [{ type: 'text', text: 123 }, { type: 'tool_use', name: 7, input: 'x' }] } }),
			JSON.stringify({ type: 'assistant', timestamp: at(1), message: { content: [null, 5, 'text'] } }),
			JSON.stringify({ type: 'user', timestamp: at(1), message: { content: [{ type: 'text', text: null }] } }),
			'null',
			'[]',
			'{"type":"assistant","message":null,"timestamp":"x"}'
		];
		for (const line of odd) expect(() => actionsFrom(line, CWD)).not.toThrow();
		expect(() => storyFrom(odd, CWD)).not.toThrow();
	});
});
