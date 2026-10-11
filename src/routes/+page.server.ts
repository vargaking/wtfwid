import { buildGraph } from '#lib/graph.ts';
import { collect } from '#lib/server/collect.ts';
import { enrich } from '#lib/server/related.ts';
import type { PageServerLoad } from './$types';

// The timeline is laid out in the browser, in the browser's time zone.
export const ssr = false;

// `/?demo` shows invented data instead of yours.
export const load: PageServerLoad = async ({ url }) => {
	const snapshot = await collect(Date.now(), url.searchParams.has('demo'));
	return { graph: await enrich(buildGraph(snapshot), snapshot) };
};
