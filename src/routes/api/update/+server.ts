import { json } from '@sveltejs/kit';
import { currentInstaller, latestRelease, startInstall } from '#lib/server/version.ts';
import type { UpdateStatus } from '#lib/update.ts';
import type { RequestHandler } from './$types';

const idle: UpdateStatus = { state: 'idle' };

/** How far an install has got (S-82). */
export const GET: RequestHandler = async () => json(currentInstaller()?.status() ?? idle);

/** Starts downloading the new version and answers at once. 409 with the reason where that is not possible. */
export const POST: RequestHandler = async () => {
	const installer = currentInstaller();
	const refused = startInstall(await latestRelease(), installer);
	if (refused !== null) return json({ message: refused }, { status: 409 });
	return json(installer!.status(), { status: 202 });
};
