import { buildGraph } from '#lib/graph.ts';
import { collect } from '#lib/server/collect.ts';
import type { PageServerLoad } from './$types';

// The timeline is laid out in the browser, in the browser's time zone.
export const ssr = false;

// `/?demo` shows invented data instead of yours.
export const load: PageServerLoad = async ({ url }) => ({
	graph: buildGraph(await collect(Date.now(), url.searchParams.has('demo')))
});
