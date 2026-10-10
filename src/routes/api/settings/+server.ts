import { json } from '@sveltejs/kit';
import { home, publicSettings } from '#lib/server/config.ts';
import { parsePatch, writeSettings } from '#lib/server/settings.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => json(await publicSettings());

export const PUT: RequestHandler = async ({ request }) => {
	const patch = parsePatch(await request.json().catch(() => null));
	if (typeof patch === 'string') return json({ message: patch }, { status: 400 });
	await writeSettings(home(), patch);
	return json(await publicSettings());
};
