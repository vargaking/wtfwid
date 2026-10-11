import { json } from '@sveltejs/kit';
import { currentInstaller, latestRelease, offer } from '#lib/server/version.ts';
import type { RequestHandler } from './$types';

/** The running version, the newer one if there is one, and whether the app can install it itself (S-82). */
export const GET: RequestHandler = async () => json(offer(await latestRelease(), currentInstaller()).info);
