// The wtfwid relay (S-91): a very small server on the public internet that Claude Code
// sessions running in the cloud report to, and that wtfwid on your own machine reads from.
// wtfwid is a desktop app on localhost; a session in the cloud cannot reach it, and nothing
// outside claude.ai can ask a cloud session how it is doing. So the session says so itself:
//
//   POST /hook          a Claude Code hook reports an event of its session       (write token)
//   POST /mcp           a connector with tools an agent or a chat can call        (write token)
//   GET  /state         everything known, for wtfwid                              (read token)
//
// This file uses only what Cloudflare Workers and Node 22 both have (Request, Response,
// crypto.subtle), and keeps nothing itself: it is handed a store. worker.js runs it on
// Cloudflare with a D1 database, server.js on any machine with Node.

/** Sessions and notes older than this are forgotten. */
export const KEEP_MS = 45 * 24 * 60 * 60_000;
/** The most a request may carry. A hook sends the whole prompt; that can be long, and is cut here. */
const BODY_MAX = 512 * 1024;
const TEXT_MAX = 1200;
const PROMPT_MAX = 400;
const NOTE_MAX = 4000;
const ITEMS_MAX = 20;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const empty = (status) => new Response(null, { status });
const str = (v) => (typeof v === 'string' ? v : '');
const clip = (v, max) => {
	const text = str(v).trim();
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
const lines = (v) => (Array.isArray(v) ? v.map((x) => clip(x, 400)).filter(Boolean).slice(0, ITEMS_MAX) : []);

/** Whether two secrets are the same, in the same time whatever they are. */
async function same(a, b) {
	if (!a || !b) return false;
	const hash = async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
	const [x, y] = await Promise.all([hash(a), hash(b)]);
	let diff = 0;
	for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
	return diff === 0;
}

const bearer = (request) => /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]?.trim() ?? '';

/** A session's own link on claude.ai, from the id Claude Code gives a cloud session. */
export function sessionUrl(remoteId) {
	const id = str(remoteId).trim();
	if (/^cse_[A-Za-z0-9]+$/.test(id)) return `https://claude.ai/code/session_${id.slice(4)}`;
	if (/^session_[A-Za-z0-9]+$/.test(id)) return `https://claude.ai/code/${id}`;
	return null;
}

/** What a ticket is called, wherever it is mentioned: `ENG-123`, any case. */
const TICKET = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/;

/** Notifications that mean the session cannot go on without you. */
const NEEDS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);

/**
 * What one hook event says about its session: the part of the record that changes.
 * Null for an event that says nothing new. `input` is the JSON Claude Code hands a hook.
 */
export function fromHook(input, at) {
	const event = str(input?.hook_event_name);
	const title = clip(input?.session_title, 120);
	const base = { event, at, ...(title && { title }), ...(str(input?.cwd) && { cwd: clip(input.cwd, 300) }) };
	switch (event) {
		case 'SessionStart':
			// started, resumed or compacted: it is there, and it is not known to be busy
			return { ...base, ended: false };
		case 'UserPromptSubmit':
			return { ...base, state: 'working', waitingFor: null, ended: false, lastAsked: clip(input?.prompt, PROMPT_MAX) || null };
		case 'PreToolUse':
		case 'PostToolUse':
			return { ...base, state: 'working', waitingFor: null, ended: false };
		case 'Notification': {
			const kind = str(input?.notification_type);
			// "you have not typed for a while" is not the session needing you: it finished its turn (see Stop)
			if (kind ? !NEEDS.has(kind) : !str(input?.message)) return null;
			return { ...base, state: 'needs', waitingFor: clip(input?.message, 200) || kind.replaceAll('_', ' '), ended: false };
		}
		case 'Stop':
			// its turn is over: your move. What it said last is usually the summary of what it did.
			return { ...base, state: 'open', waitingFor: null, ended: false, lastSaid: clip(input?.last_assistant_message, TEXT_MAX) || null };
		case 'SessionEnd':
			return { ...base, state: 'done', waitingFor: null, ended: true };
		default:
			return null;
	}
}

// --- the connector -------------------------------------------------------------------------

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
	{
		name: 'wtfwid_note',
		title: 'Note where this got to',
		description:
			"Records where this conversation got to, so it shows on the person's wtfwid timeline next to the ticket: what was decided and what is still open. " +
			'Call it when a piece of work or a planning discussion reaches a conclusion, when the person says to log or note it, and before a long session ends. ' +
			'Write for someone who was not in the conversation. Do not include secrets.',
		inputSchema: {
			type: 'object',
			properties: {
				ticket: { type: 'string', description: 'The ticket this is about, e.g. "ENG-123". Leave out if there is none.' },
				title: { type: 'string', description: 'A few words naming the conversation.' },
				summary: { type: 'string', description: 'What was done or concluded, in two to five sentences.' },
				decided: { type: 'array', items: { type: 'string' }, description: 'Decisions that were made, one per item.' },
				open: { type: 'array', items: { type: 'string' }, description: 'Questions or work still open, one per item.' },
				url: { type: 'string', description: 'A link to this conversation, if you know it.' }
			},
			required: ['title', 'summary'],
			additionalProperties: false
		}
	},
	{
		name: 'wtfwid_link',
		title: 'Say which ticket this session is for',
		description:
			'Tells wtfwid which ticket a Claude Code session is working on, when its git branch does not already carry the ticket ID. ' +
			'In a cloud session, pass the value of the CLAUDE_CODE_REMOTE_SESSION_ID environment variable as "session".',
		inputSchema: {
			type: 'object',
			properties: {
				ticket: { type: 'string', description: 'The ticket, e.g. "ENG-123".' },
				session: { type: 'string', description: 'The session id: the value of CLAUDE_CODE_REMOTE_SESSION_ID.' }
			},
			required: ['ticket', 'session'],
			additionalProperties: false
		}
	},
	{
		name: 'wtfwid_recall',
		title: 'What is noted on a ticket',
		description: 'Returns the notes earlier conversations left on a ticket, newest first, and the state of the sessions known to be working on it. Use it to pick work up where it was left.',
		inputSchema: { type: 'object', properties: { ticket: { type: 'string', description: 'The ticket, e.g. "ENG-123".' } }, required: ['ticket'], additionalProperties: false },
		annotations: { readOnlyHint: true }
	}
];

const text = (body, isError = false) => ({ content: [{ type: 'text', text: body }], isError });

async function callTool(name, args, store, now) {
	const a = args && typeof args === 'object' ? args : {};
	const ticket = str(a.ticket).trim().toUpperCase();
	if (ticket && !TICKET.test(ticket)) return text('That does not look like a ticket ID. Write it like ENG-123.', true);

	if (name === 'wtfwid_note') {
		const summary = clip(a.summary, NOTE_MAX);
		const title = clip(a.title, 160);
		if (!summary || !title) return text('A note needs a title and a summary.', true);
		const url = /^https:\/\/\S{1,500}$/.test(str(a.url).trim()) ? str(a.url).trim() : null;
		await store.addNote({ id: crypto.randomUUID(), at: now, ticket: ticket || null, title, summary, decided: lines(a.decided), open: lines(a.open), url });
		return text(ticket ? `Noted on ${ticket}.` : 'Noted. It names no ticket, so it will show as unsorted.');
	}
	if (name === 'wtfwid_link') {
		const url = sessionUrl(a.session);
		if (!ticket || !url) return text('Needs a ticket ID and the session id from CLAUDE_CODE_REMOTE_SESSION_ID.', true);
		await store.mergeSession(url.split('/').pop(), { url, ticket, at: now }, now);
		return text(`This session is now on ${ticket}.`);
	}
	if (name === 'wtfwid_recall') {
		if (!ticket) return text('Needs a ticket ID.', true);
		const notes = (await store.notes(0)).filter((n) => n.ticket === ticket).sort((x, y) => y.at - x.at).slice(0, 8);
		const sessions = (await store.sessions(0)).filter((s) => s.ticket === ticket || str(s.branch).toUpperCase().includes(ticket));
		if (!notes.length && !sessions.length) return text(`Nothing is noted on ${ticket} yet.`);
		const out = [];
		for (const n of notes) {
			out.push(`## ${new Date(n.at).toISOString().slice(0, 10)}: ${n.title}`, n.summary);
			if (n.decided.length) out.push('Decided:', ...n.decided.map((d) => `- ${d}`));
			if (n.open.length) out.push('Still open:', ...n.open.map((d) => `- ${d}`));
			out.push('');
		}
		for (const s of sessions) out.push(`Session ${s.url ?? s.id}: ${s.state ?? 'unknown'}${s.waitingFor ? `, waiting for: ${s.waitingFor}` : ''}${s.lastSaid ? `\nIt last said: ${s.lastSaid}` : ''}`);
		return text(out.join('\n').trim());
	}
	return null;
}

/** One JSON-RPC message of the Model Context Protocol. Returns the answer, or null for a notification. */
async function rpc(message, store, now) {
	const { id, method, params } = message ?? {};
	const reply = (result) => ({ jsonrpc: '2.0', id, result });
	const fail = (code, msg) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: msg } });
	if (message?.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'Not a JSON-RPC request.');
	if (id === undefined) return null; // a notification: nothing to answer

	if (method === 'initialize') {
		const asked = str(params?.protocolVersion);
		return reply({
			protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
			capabilities: { tools: {} },
			serverInfo: { name: 'wtfwid', title: 'wtfwid', version: '1' },
			instructions: 'wtfwid shows a person their tickets and Claude sessions on one timeline. These tools let a conversation leave a note on a ticket and read the notes earlier ones left.'
		});
	}
	if (method === 'ping') return reply({});
	if (method === 'tools/list') return reply({ tools: TOOLS });
	if (method === 'tools/call') {
		const result = await callTool(str(params?.name), params?.arguments, store, now);
		return result ? reply(result) : fail(-32602, `Unknown tool: ${str(params?.name)}`);
	}
	return fail(-32601, `Method not found: ${method}`);
}

async function body(request) {
	const length = Number(request.headers.get('content-length') ?? 0);
	if (length > BODY_MAX) return null;
	const raw = await request.text();
	if (raw.length > BODY_MAX) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/**
 * Answers one request. `store` keeps the sessions and notes; `tokens` are the two secrets:
 * `write` for sessions and the connector, `read` for wtfwid.
 */
export async function handle(request, store, tokens, now = Date.now()) {
	const url = new URL(request.url);
	const path = url.pathname.replace(/\/+$/, '') || '/';

	if (path === '/' || path === '/health') return request.method === 'GET' ? new Response('wtfwid relay\n', { headers: { 'content-type': 'text/plain' } }) : empty(405);
	// no secret, no service: a relay set up without them must not be open to everyone
	if (!tokens?.write || !tokens?.read) return json({ message: 'The relay has no tokens set.' }, 503);

	if (path === '/state') {
		if (request.method !== 'GET') return empty(405);
		if (!(await same(bearer(request), tokens.read))) return empty(401);
		const since = Number(url.searchParams.get('since')) || 0;
		await store.prune(now - KEEP_MS);
		return json({ now, sessions: await store.sessions(since), notes: await store.notes(since) });
	}

	if (path === '/hook') {
		if (request.method !== 'POST') return empty(405);
		if (!(await same(bearer(request), tokens.write))) return empty(401);
		const input = await body(request);
		if (input === null) return empty(413);
		if (!input || typeof input !== 'object') return empty(400);
		const patch = fromHook(input, now);
		// the cloud id when there is one; else the session is one on somebody's own machine
		const link = sessionUrl(request.headers.get('x-wtfwid-session'));
		const id = link ? link.split('/').pop() : /^[\w-]{6,80}$/.test(str(input.session_id)) ? `local_${input.session_id}` : null;
		if (!patch || !id) return empty(204);
		const branch = clip(request.headers.get('x-wtfwid-branch'), 200);
		const repo = clip(request.headers.get('x-wtfwid-repo'), 200);
		await store.mergeSession(id, { ...patch, ...(link && { url: link }), ...(branch && branch !== 'HEAD' && { branch }), ...(repo && { repo }) }, now);
		return empty(204);
	}

	// The connector. Claude Code sends the token as a header. A connector added on claude.ai
	// cannot (a fixed header is not offered there), so there the token is the last part of
	// the address: treat that address as the secret it is.
	if (path === '/mcp' || path.startsWith('/mcp/')) {
		let given = bearer(request);
		if (path !== '/mcp') {
			try {
				given = decodeURIComponent(path.slice(5));
			} catch {
				return empty(401);
			}
		}
		if (!(await same(given, tokens.write))) return empty(401);
		// a web page in a browser has no business here; Claude does not send an Origin
		const origin = request.headers.get('origin');
		if (origin && !/^https:\/\/([\w-]+\.)?(claude\.ai|claude\.com|anthropic\.com)$/.test(origin)) return empty(403);
		if (request.method === 'GET' || request.method === 'DELETE') return empty(405); // no stream to open, no session to end
		if (request.method !== 'POST') return empty(405);
		const message = await body(request);
		if (message === null) return empty(413);
		if (message === undefined) return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
		if (Array.isArray(message)) {
			const answers = (await Promise.all(message.slice(0, 20).map((m) => rpc(m, store, now)))).filter(Boolean);
			return answers.length ? json(answers) : empty(202);
		}
		const answer = await rpc(message, store, now);
		return answer ? json(answer) : empty(202);
	}

	return empty(404);
}

/** A store that keeps everything in memory. `saved` is called after every change, to write it somewhere. */
export function memoryStore(initial = {}, saved = () => {}) {
	const byId = new Map(Object.entries(initial.sessions ?? {}));
	const noted = [...(initial.notes ?? [])];
	const dump = () => ({ sessions: Object.fromEntries(byId), notes: noted });
	return {
		async mergeSession(id, patch, at) {
			const had = byId.get(id) ?? { id, startedAt: at };
			byId.set(id, { ...had, ...patch, id, updatedAt: at });
			await saved(dump());
		},
		async sessions(since) {
			return [...byId.values()].filter((s) => s.updatedAt > since).sort((a, b) => a.updatedAt - b.updatedAt);
		},
		async addNote(note) {
			noted.push(note);
			await saved(dump());
		},
		async notes(since) {
			return noted.filter((n) => n.at > since).sort((a, b) => a.at - b.at);
		},
		async prune(before) {
			let changed = false;
			for (const [id, s] of byId) if (s.updatedAt < before) changed = byId.delete(id) || changed;
			const kept = noted.filter((n) => n.at >= before);
			if (kept.length !== noted.length) {
				noted.splice(0, noted.length, ...kept);
				changed = true;
			}
			if (changed) await saved(dump());
		},
		dump
	};
}
