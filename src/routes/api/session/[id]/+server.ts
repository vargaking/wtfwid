import { error, json } from '@sveltejs/kit';
import { home } from '#lib/server/config.ts';
import { knownSession } from '#lib/server/sessions.ts';
import { findTranscript, readNote } from '#lib/server/transcript.ts';
import type { RequestHandler } from './$types';

/**
 * What a session was doing, from its transcript (S-55). Only for sessions wtfwid has
 * seen, so the caller never names a file: the id is looked up, and the path follows from it.
 */
export const GET: RequestHandler = async ({ params }) => {
	const session = await knownSession(home(), params.id);
	if (!session) error(404, 'No such session.');
	const file = await findTranscript(session.id, session.cwd);
	if (!file) error(404, 'Its transcript is no longer on this machine.');
	return json(await readNote(file));
};
