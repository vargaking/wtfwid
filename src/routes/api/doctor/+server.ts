import { json } from '@sveltejs/kit';
import { asText, checkAll } from '#lib/server/doctor.ts';
import type { RequestHandler } from './$types';

/** Tries every source with the saved settings and says what came back (S-79). */
export const GET: RequestHandler = async () => {
	const checks = await checkAll();
	return json({ checks, text: asText(checks) });
};
