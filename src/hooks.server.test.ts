import { afterEach, describe, expect, it } from 'vitest';
import { handle } from './hooks.server';

/** Sends one request through the guard. Resolves to the status it answers with. */
async function ask(host: string | null, cookie?: string): Promise<number> {
	const headers = new Headers(host === null ? {} : { host });
	const event = { request: { headers }, cookies: { get: (name: string) => (name === 'wtfwid' ? cookie : undefined) } };
	const response = await handle({ event, resolve: async () => new Response('the page') } as unknown as Parameters<typeof handle>[0]);
	return response.status;
}

describe('who may reach it', () => {
	afterEach(() => {
		delete process.env.WTFWID_TOKEN;
		delete process.env.WTFWID_ALLOW_REMOTE;
	});

	it('S-75 answers when addressed as this machine, on any port', async () => {
		for (const host of ['localhost', 'localhost:4173', '127.0.0.1:5173', '[::1]:4173']) expect(await ask(host)).toBe(200);
	});

	it('S-75 refuses any other name, so a web page that points its domain here gets nothing', async () => {
		for (const host of ['evil.example', 'evil.example:4173', 'localhost.evil.example', '127.0.0.1.evil.example', '192.168.1.20:4173', '']) expect(await ask(host)).toBe(403);
		expect(await ask(null)).toBe(403);
	});

	it('S-75 answers other names only when told to', async () => {
		process.env.WTFWID_ALLOW_REMOTE = '1';
		expect(await ask('wtfwid.home.example')).toBe(200);
	});

	it('S-75 in the desktop app, answers only the window that holds its token', async () => {
		process.env.WTFWID_TOKEN = 'the-token';
		expect(await ask('127.0.0.1:40123', 'the-token')).toBe(200);
		expect(await ask('127.0.0.1:40123')).toBe(403);
		expect(await ask('127.0.0.1:40123', 'a-guess')).toBe(403);
		// the token does not get a foreign name in
		expect(await ask('evil.example', 'the-token')).toBe(403);
	});
});
