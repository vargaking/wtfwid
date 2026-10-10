import { buildGraph } from '#lib/graph.ts';
import { collect } from '#lib/server/collect.ts';

// The timeline is laid out in the browser, in the browser's time zone.
export const ssr = false;

export const load = async () => ({ graph: buildGraph(await collect()) });
