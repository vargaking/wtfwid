// The relay on Cloudflare Workers, keeping its data in a D1 database (see README.md).
// Everything it does is in core.js; this file only says where the data lives.
import { handle } from './core.js';

/**
 * Sessions and notes in two tables, each row one JSON document. A session's row is merged
 * in one statement, so two hooks reporting at the same moment cannot undo each other.
 */
function d1Store(db) {
	const parse = (rows) => rows.map((r) => JSON.parse(r.data));
	return {
		async mergeSession(id, patch, at) {
			const fresh = JSON.stringify({ id, startedAt: at, ...patch, updatedAt: at });
			// json_patch lays the new fields over the old row; what the patch does not name stays
			const merged = JSON.stringify({ ...patch, id, updatedAt: at });
			await db
				.prepare('INSERT INTO sessions (id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = json_patch(sessions.data, ?4), updated_at = ?3')
				.bind(id, fresh, at, merged)
				.run();
		},
		async sessions(since) {
			return parse((await db.prepare('SELECT data FROM sessions WHERE updated_at > ?1 ORDER BY updated_at LIMIT 2000').bind(since).all()).results);
		},
		async addNote(note) {
			await db.prepare('INSERT INTO notes (id, data, at) VALUES (?1, ?2, ?3)').bind(note.id, JSON.stringify(note), note.at).run();
		},
		async notes(since) {
			return parse((await db.prepare('SELECT data FROM notes WHERE at > ?1 ORDER BY at LIMIT 2000').bind(since).all()).results);
		},
		async prune(before) {
			await db.batch([db.prepare('DELETE FROM sessions WHERE updated_at < ?1').bind(before), db.prepare('DELETE FROM notes WHERE at < ?1').bind(before)]);
		}
	};
}

export default {
	async fetch(request, env) {
		try {
			return await handle(request, d1Store(env.DB), { write: env.WRITE_TOKEN, read: env.READ_TOKEN });
		} catch {
			// never a stack trace to whoever asked
			return new Response(null, { status: 500 });
		}
	}
};
