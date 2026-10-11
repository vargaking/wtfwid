import { hub } from '#lib/server/live.ts';
import type { RequestHandler } from './$types';

/**
 * A stream that stays open and says what running sessions are doing, as it happens (S-85).
 * Server-sent events: one "data:" line of JSON per event.
 */
export const GET: RequestHandler = async () => {
	const encoder = new TextEncoder();
	let stop: (() => void) | undefined;
	let beat: ReturnType<typeof setInterval> | undefined;

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const write = (text: string) => {
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					// the window closed between two events
				}
			};
			stop = await hub().subscribe((event) => write(`data: ${JSON.stringify(event)}\n\n`));
			// a comment line now and then, so nothing in between decides the connection is dead
			beat = setInterval(() => write(': still here\n\n'), 20_000);
		},
		cancel() {
			clearInterval(beat);
			stop?.();
		}
	});
	return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
};
