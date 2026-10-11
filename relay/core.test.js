import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromHook, handle, KEEP_MS, memoryStore, sessionUrl } from './core.js';
import { fileStore, serve } from './server.js';

const run = promisify(execFile);
const tokens = { write: 'write-secret', read: 'read-secret' };
const CSE = 'cse_018yAbCdEf';
const URL_ = 'https://claude.ai/code/session_018yAbCdEf';

const hook = (input, headers = {}, token = tokens.write) =>
	new Request('https://relay.example/hook', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-wtfwid-session': CSE, ...headers }, body: JSON.stringify(input) });
const state = (token = tokens.read, since = '') => new Request(`https://relay.example/state${since && `?since=${since}`}`, { headers: { authorization: `Bearer ${token}` } });
const mcp = (message, { path = '/mcp', token = tokens.write, headers = {} } = {}) =>
	new Request(`https://relay.example${path}`, { method: 'POST', headers: { ...(token && { authorization: `Bearer ${token}` }), 'content-type': 'application/json', ...headers }, body: JSON.stringify(message) });
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('what a hook event says about its session', () => {
	it('S-91: a prompt means working, a finished turn means your move, a permission question means it needs you', () => {
		expect(fromHook({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the reconnect', cwd: '/repo', session_title: 'ENG-12 reconnect' }, 5)).toEqual({
			event: 'UserPromptSubmit', at: 5, title: 'ENG-12 reconnect', cwd: '/repo', state: 'working', waitingFor: null, ended: false, lastAsked: 'fix the reconnect'
		});
		expect(fromHook({ hook_event_name: 'Stop', last_assistant_message: 'Done. Two tests still fail.' }, 6)).toMatchObject({ state: 'open', lastSaid: 'Done. Two tests still fail.' });
		expect(fromHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, 7)).toMatchObject({ state: 'needs', waitingFor: 'Claude needs your permission to use Bash' });
		expect(fromHook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input' }, 7)).toMatchObject({ state: 'needs', waitingFor: 'agent needs input' });
		expect(fromHook({ hook_event_name: 'SessionEnd', reason: 'other' }, 8)).toMatchObject({ state: 'done', ended: true });
		expect(fromHook({ hook_event_name: 'SessionStart', source: 'resume' }, 9)).toEqual({ event: 'SessionStart', at: 9, ended: false });
	});

	it('S-91: sitting at its prompt is not needing you, and events that say nothing are left out', () => {
		expect(fromHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, 1)).toBeNull();
		expect(fromHook({ hook_event_name: 'Notification', notification_type: 'auth_success', message: 'x' }, 1)).toBeNull();
		// an older Claude Code that names no type: a message is taken as a question
		expect(fromHook({ hook_event_name: 'Notification', message: 'Claude needs your permission' }, 1)).toMatchObject({ state: 'needs' });
		expect(fromHook({ hook_event_name: 'SubagentStop' }, 1)).toBeNull();
		expect(fromHook(null, 1)).toBeNull();
		// long texts are cut, not refused
		expect(fromHook({ hook_event_name: 'UserPromptSubmit', prompt: 'p'.repeat(5000) }, 1).lastAsked).toHaveLength(400);
	});

	it('S-91: the link of a cloud session is made from the id Claude Code gives it', () => {
		expect(sessionUrl(CSE)).toBe(URL_);
		expect(sessionUrl('session_018yAbCdEf')).toBe(URL_);
		expect(sessionUrl('cse_../../x')).toBeNull();
		expect(sessionUrl('')).toBeNull();
	});
});

describe('the relay', () => {
	it('S-91: keeps the latest state of each session and hands all of it to wtfwid', async () => {
		const store = memoryStore();
		const git = { 'x-wtfwid-branch': 'fix/eng-12-reconnect', 'x-wtfwid-repo': 'acme/app' };
		expect((await handle(hook({ hook_event_name: 'SessionStart', cwd: '/repo' }, git), store, tokens, 1000)).status).toBe(204);
		await handle(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'fix it' }, git), store, tokens, 2000);
		await handle(hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, git), store, tokens, 3000);
		const answer = await (await handle(state(), store, tokens, 4000)).json();
		expect(answer).toEqual({
			now: 4000,
			notes: [],
			sessions: [{
				id: 'session_018yAbCdEf', url: URL_, startedAt: 1000, updatedAt: 3000, at: 3000, event: 'Notification', cwd: '/repo', ended: false,
				state: 'needs', waitingFor: 'Claude needs your permission to use Bash', lastAsked: 'fix it', branch: 'fix/eng-12-reconnect', repo: 'acme/app'
			}]
		});
		// only what changed since
		expect((await (await handle(state(tokens.read, '3000'), store, tokens, 4000)).json()).sessions).toEqual([]);
		// a session on someone's own machine has no cloud id: it goes by its local one
		await handle(hook({ hook_event_name: 'UserPromptSubmit', session_id: 'aaaaaaaa-1111-4111-8111-111111111111', prompt: 'x' }, { 'x-wtfwid-session': '' }), store, tokens, 5000);
		expect((await (await handle(state(tokens.read, '3000'), store, tokens, 6000)).json()).sessions).toMatchObject([{ id: 'local_aaaaaaaa-1111-4111-8111-111111111111', state: 'working' }]);
	});

	it('S-91: nothing gets in or out without the right token, and each token only does its own job', async () => {
		const store = memoryStore();
		const prompt = { hook_event_name: 'UserPromptSubmit', prompt: 'x' };
		for (const bad of ['', 'nope', tokens.read]) expect((await handle(hook(prompt, {}, bad), store, tokens)).status).toBe(401);
		for (const bad of ['', 'nope', tokens.write]) expect((await handle(state(bad), store, tokens)).status).toBe(401);
		expect((await handle(mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: tokens.read }), store, tokens)).status).toBe(401);
		expect((await handle(mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { path: '/mcp/nope', token: '' }), store, tokens)).status).toBe(401);
		expect(store.dump()).toEqual({ sessions: {}, notes: [] });
		// a relay that was set up without tokens serves nobody, rather than everybody
		expect((await handle(state(''), store, { write: '', read: '' })).status).toBe(503);
		expect((await handle(hook(prompt), store, {})).status).toBe(503);
		// the front page says what this is and nothing else
		expect(await (await handle(new Request('https://relay.example/'), store, tokens)).text()).toBe('wtfwid relay\n');
		expect((await handle(new Request('https://relay.example/anything'), store, tokens)).status).toBe(404);
		expect((await handle(new Request('https://relay.example/hook'), store, tokens)).status).toBe(405);
	});

	it('S-91: a request that is too big or not JSON is refused, and nothing is kept of it', async () => {
		const store = memoryStore();
		const big = new Request('https://relay.example/hook', { method: 'POST', headers: { authorization: `Bearer ${tokens.write}`, 'x-wtfwid-session': CSE }, body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'p'.repeat(600_000) }) });
		expect((await handle(big, store, tokens)).status).toBe(413);
		const broken = new Request('https://relay.example/hook', { method: 'POST', headers: { authorization: `Bearer ${tokens.write}` }, body: '{ not json' });
		expect((await handle(broken, store, tokens)).status).toBe(400);
		expect(store.dump().sessions).toEqual({});
	});

	it('S-91: forgets what is older than six weeks', async () => {
		const store = memoryStore();
		await handle(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'old' }), store, tokens, 1000);
		await handle(mcp(call(1, 'wtfwid_note', { title: 'Old', summary: 'Old.' })), store, tokens, 1000);
		const later = 1000 + KEEP_MS + 1;
		await handle(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'new' }, { 'x-wtfwid-session': 'cse_new1' }), store, tokens, later);
		const answer = await (await handle(state(), store, tokens, later + 1)).json();
		expect(answer.sessions.map((s) => s.id)).toEqual(['session_new1']);
		expect(answer.notes).toEqual([]);
	});
});

describe('the connector', () => {
	it('S-91: answers the way the Model Context Protocol asks: versions, tools, notifications, unknown methods', async () => {
		const store = memoryStore();
		const init = await handle(mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }), store, tokens);
		expect(init.headers.get('content-type')).toBe('application/json');
		expect(await init.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wtfwid' } } });
		// a version it does not know: it offers the newest it does
		const future = await (await handle(mcp({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2031-01-01' } }), store, tokens)).json();
		expect(future.result.protocolVersion).toBe('2025-11-25');
		// a notification is accepted with no body
		const note = await handle(mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }), store, tokens);
		expect([note.status, await note.text()]).toEqual([202, '']);
		const list = await (await handle(mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' }), store, tokens)).json();
		expect(list.result.tools.map((t) => t.name)).toEqual(['wtfwid_note', 'wtfwid_link', 'wtfwid_recall']);
		for (const tool of list.result.tools) expect(tool.inputSchema).toMatchObject({ type: 'object' });
		expect(await (await handle(mcp({ jsonrpc: '2.0', id: 4, method: 'ping' }), store, tokens)).json()).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
		expect((await (await handle(mcp({ jsonrpc: '2.0', id: 5, method: 'resources/list' }), store, tokens)).json()).error.code).toBe(-32601);
		expect((await (await handle(mcp(call(6, 'nope', {})), store, tokens)).json()).error.code).toBe(-32602);
		// there is no stream to open
		expect((await handle(new Request('https://relay.example/mcp', { headers: { authorization: `Bearer ${tokens.write}` } }), store, tokens)).status).toBe(405);
	});

	it('S-91: a conversation leaves a note on a ticket, and a later one reads it back', async () => {
		const store = memoryStore();
		const noted = await (await handle(mcp(call(1, 'wtfwid_note', { ticket: 'eng-12', title: 'Reconnect plan', summary: 'Restart ICE on a network change.', decided: ['Restart ICE, do not rebuild the peer'], open: ['Firefox'], url: 'https://claude.ai/chat/abc' })), store, tokens, 1000)).json();
		expect(noted.result).toEqual({ content: [{ type: 'text', text: 'Noted on ENG-12.' }], isError: false });
		const { notes } = await (await handle(state(), store, tokens, 2000)).json();
		expect(notes).toMatchObject([{ at: 1000, ticket: 'ENG-12', title: 'Reconnect plan', summary: 'Restart ICE on a network change.', decided: ['Restart ICE, do not rebuild the peer'], open: ['Firefox'], url: 'https://claude.ai/chat/abc' }]);

		// the session working on it, known from its hook
		await handle(hook({ hook_event_name: 'Stop', last_assistant_message: 'ICE restart is in. Firefox still drops.' }, { 'x-wtfwid-branch': 'fix/eng-12-reconnect' }), store, tokens, 3000);
		const recalled = await (await handle(mcp(call(2, 'wtfwid_recall', { ticket: 'ENG-12' })), store, tokens, 4000)).json();
		expect(recalled.result.content[0].text).toBe(
			['## 1970-01-01: Reconnect plan', 'Restart ICE on a network change.', 'Decided:', '- Restart ICE, do not rebuild the peer', 'Still open:', '- Firefox', '', `Session ${URL_}: open`, 'It last said: ICE restart is in. Firefox still drops.'].join('\n')
		);
		expect((await (await handle(mcp(call(3, 'wtfwid_recall', { ticket: 'ENG-99' })), store, tokens)).json()).result.content[0].text).toBe('Nothing is noted on ENG-99 yet.');
	});

	it('S-91: a session can say which ticket it is for; what is not right is told to the caller, not kept', async () => {
		const store = memoryStore();
		const linked = await (await handle(mcp(call(1, 'wtfwid_link', { ticket: 'ENG-7', session: CSE })), store, tokens, 1000)).json();
		expect(linked.result.content[0].text).toBe('This session is now on ENG-7.');
		expect(store.dump().sessions['session_018yAbCdEf']).toMatchObject({ url: URL_, ticket: 'ENG-7' });
		for (const args of [{ ticket: 'not a ticket', session: CSE }, { ticket: 'ENG-7', session: '../x' }]) {
			expect((await (await handle(mcp(call(2, 'wtfwid_link', args)), store, tokens)).json()).result.isError).toBe(true);
		}
		expect((await (await handle(mcp(call(3, 'wtfwid_note', { title: '', summary: '' })), store, tokens)).json()).result.isError).toBe(true);
		// a link that is not https is dropped, the note is kept
		await handle(mcp(call(4, 'wtfwid_note', { title: 'T', summary: 'S', url: 'javascript:alert(1)' })), store, tokens);
		expect(store.dump().notes.at(-1)).toMatchObject({ title: 'T', url: null, ticket: null });
	});

	it('S-91: on claude.ai, where a connector cannot send a header, the token is the end of the address; a web page is refused', async () => {
		const store = memoryStore();
		const viaPath = await handle(mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { path: `/mcp/${tokens.write}`, token: '' }), store, tokens);
		expect(viaPath.status).toBe(200);
		const fromPage = await handle(mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { headers: { origin: 'https://evil.example' } }), store, tokens);
		expect(fromPage.status).toBe(403);
		expect((await handle(mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { headers: { origin: 'https://claude.ai' } }), store, tokens)).status).toBe(200);
	});
});

describe('the relay as a program, and the hook that reports to it', () => {
	let server;
	let base;
	let file;
	beforeAll(async () => {
		file = join(await mkdtemp(join(tmpdir(), 'wtfwid-relay-')), 'relay.json');
		server = await serve({ port: 0, tokens, store: await fileStore(file) });
		base = `http://127.0.0.1:${server.address().port}`;
	});
	afterAll(() => server.close());

	const hookScript = fileURLToPath(new URL('./hook.sh', import.meta.url));
	const fire = (input, env) =>
		new Promise((resolve, reject) => {
			const child = execFile('sh', [hookScript], { env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })));
			// a script that is done before it was handed everything is not this test's failure
			child.stdin.on('error', () => {});
			child.stdin.end(JSON.stringify(input));
		});

	it.skipIf(process.platform === 'win32')('S-91: the hook script reports an event with the session, its branch and its repository', async () => {
		// a repository to be in, on a ticket's branch
		const repo = await mkdtemp(join(tmpdir(), 'wtfwid-hookrepo-'));
		const git = (...args) => run('git', ['-C', repo, ...args]);
		await git('init', '-q', '-b', 'fix/eng-12-reconnect');
		await git('remote', 'add', 'origin', 'git@github.com:acme/app.git');
		const env = { WTFWID_RELAY_URL: `${base}/`, WTFWID_RELAY_TOKEN: tokens.write, CLAUDE_CODE_REMOTE_SESSION_ID: CSE, CLAUDE_PROJECT_DIR: repo };

		expect(await fire({ hook_event_name: 'UserPromptSubmit', prompt: 'fix "it" & $HOME; `x`\nnow', cwd: repo }, env)).toEqual({ stdout: '', stderr: '' });
		const seen = await (await fetch(`${base}/state`, { headers: { authorization: `Bearer ${tokens.read}` } })).json();
		expect(seen.sessions).toMatchObject([{ id: 'session_018yAbCdEf', url: URL_, state: 'working', branch: 'fix/eng-12-reconnect', repo: 'acme/app', lastAsked: 'fix "it" & $HOME; `x`\nnow' }]);
		// and it is on disk, for when the relay restarts
		expect(JSON.parse(await readFile(file, 'utf8')).sessions['session_018yAbCdEf'].state).toBe('working');
	});

	it.skipIf(process.platform === 'win32')('S-91: the hook does nothing where it is not set up, and never fails or waits when the relay is away', async () => {
		const before = await (await fetch(`${base}/state`, { headers: { authorization: `Bearer ${tokens.read}` } })).json();
		// someone else's session in the same repository: no address, no token
		expect(await fire({ hook_event_name: 'Stop' }, {})).toEqual({ stdout: '', stderr: '' });
		expect(await fire({ hook_event_name: 'Stop' }, { WTFWID_RELAY_URL: base })).toEqual({ stdout: '', stderr: '' });
		// a relay that is not there, and a token it does not accept: silent, and done in a moment
		const started = Date.now();
		expect(await fire({ hook_event_name: 'Stop' }, { WTFWID_RELAY_URL: 'http://127.0.0.1:9', WTFWID_RELAY_TOKEN: 'x' })).toEqual({ stdout: '', stderr: '' });
		expect(await fire({ hook_event_name: 'Stop' }, { WTFWID_RELAY_URL: base, WTFWID_RELAY_TOKEN: 'wrong' })).toEqual({ stdout: '', stderr: '' });
		expect(Date.now() - started).toBeLessThan(6000);
		const after = await (await fetch(`${base}/state`, { headers: { authorization: `Bearer ${tokens.read}` } })).json();
		expect(after.sessions.map((s) => [s.id, s.state])).toEqual(before.sessions.map((s) => [s.id, s.state]));
	});
});
