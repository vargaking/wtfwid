import { text } from '@sveltejs/kit';
import { pulse } from '#lib/server/collect.ts';
import type { RequestHandler } from './$types';

/** Changes when a local session changes state. The screen asks often and refreshes when it does (S-18). */
export const GET: RequestHandler = async () => text(await pulse());
