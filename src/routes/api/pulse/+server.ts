import { error, text } from '@sveltejs/kit';
import { pulse } from '#lib/server/collect.ts';
import type { RequestHandler } from './$types';

/** Changes when a local session changes state. The screen asks often and refreshes when it does (S-18). */
export const GET: RequestHandler = async () => {
	const beat = await pulse().catch(() => null);
	// could not tell this time: the screen keeps the value it has and asks again
	if (beat === null) error(503, 'Could not list the sessions.');
	return text(beat);
};
