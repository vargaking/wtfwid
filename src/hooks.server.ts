import type { Handle } from '@sveltejs/kit/hooks';

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * wtfwid shows your tickets and takes your API keys, so only you should reach it (S-75).
 * - It answers only when addressed as this machine. A web page that points its own
 *   domain at 127.0.0.1 gets nothing.
 * - The desktop app also hands its window a one-off token. Other programs on the
 *   machine do not have it.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const host = (event.request.headers.get('host') ?? '').replace(/:\d+$/, '');
	if (!LOCAL.has(host) && !process.env.WTFWID_ALLOW_REMOTE) return new Response('Forbidden', { status: 403 });

	const token = process.env.WTFWID_TOKEN;
	if (token && event.cookies.get('wtfwid') !== token) return new Response('Forbidden', { status: 403 });

	return resolve(event);
};
