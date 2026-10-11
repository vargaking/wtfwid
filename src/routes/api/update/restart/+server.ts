import { json } from '@sveltejs/kit';
import { currentInstaller } from '#lib/server/version.ts';
import type { RequestHandler } from './$types';

/**
 * Restarts the app into the version that was just installed (S-82). Only the "Restart to
 * finish" button asks for this, and it does nothing unless an install has finished.
 */
export const POST: RequestHandler = async () => {
	if (!currentInstaller()?.restart()) return json({ message: 'There is no new version waiting for a restart.' }, { status: 409 });
	return json({ restarting: true }, { status: 202 });
};
