#!/usr/bin/env node
// The relay on any machine with Node 22: `node relay/server.js`. For a small server of
// your own, or to try the relay on your own computer. It keeps its data in one JSON file.
//
//   RELAY_WRITE_TOKEN, RELAY_READ_TOKEN   the two secrets (required)
//   RELAY_FILE                            where the data is kept (default ./wtfwid-relay.json)
//   HOST, PORT                            where to listen (default 127.0.0.1:8787)
//
// It speaks plain http. On the public internet put it behind something that adds https.
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handle, memoryStore } from './core.js';

export async function fileStore(file) {
	const initial = await readFile(file, 'utf8').then(JSON.parse, () => ({}));
	let writing = Promise.resolve();
	return memoryStore(initial, (data) => {
		// one write after the other, each to a file of its own that is then moved into place
		writing = writing
			.then(async () => {
				const draft = `${file}.${randomUUID()}.tmp`;
				await writeFile(draft, JSON.stringify(data), { mode: 0o600 });
				await rename(draft, file);
			})
			.catch(() => {});
		return writing;
	});
}

/** Starts the relay. Returns the server, so a test can stop it. */
export async function serve({ host = '127.0.0.1', port = 8787, tokens, store }) {
	const server = http.createServer(async (req, res) => {
		try {
			const chunks = [];
			let size = 0;
			for await (const chunk of req) {
				size += chunk.length;
				if (size > 600 * 1024) {
					res.writeHead(413).end();
					return;
				}
				chunks.push(chunk);
			}
			const request = new Request(`http://${req.headers.host ?? 'relay'}${req.url}`, {
				method: req.method,
				headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : v]])),
				body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks)
			});
			const answer = await handle(request, store, tokens);
			res.writeHead(answer.status, Object.fromEntries(answer.headers));
			res.end(Buffer.from(await answer.arrayBuffer()));
		} catch {
			res.writeHead(500).end();
		}
	});
	await new Promise((resolve) => server.listen(port, host, resolve));
	return server;
}

const main = (() => {
	try {
		return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
})();
if (main) {
	const tokens = { write: process.env.RELAY_WRITE_TOKEN, read: process.env.RELAY_READ_TOKEN };
	if (!tokens.write || !tokens.read) {
		console.error('Set RELAY_WRITE_TOKEN and RELAY_READ_TOKEN first. Two long random strings, e.g. from: openssl rand -hex 32');
		process.exit(1);
	}
	const host = process.env.HOST ?? '127.0.0.1';
	const port = Number(process.env.PORT ?? 8787);
	await serve({ host, port, tokens, store: await fileStore(process.env.RELAY_FILE ?? './wtfwid-relay.json') });
	console.log(`wtfwid relay on http://${host}:${port}`);
}
