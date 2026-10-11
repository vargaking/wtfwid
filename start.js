// Runs the built app in your browser. Local only by default: it shows your tickets and
// sessions, and takes your API keys, so nothing outside this machine should reach it.
import http from 'node:http';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4173);

// The built server takes "http or https" from a request header, and assumes https when
// there is none. It is served over plain http here, so say so on every request, under a
// name of our own that replaces whatever the browser sent.
process.env.PROTOCOL_HEADER = 'x-wtfwid-protocol';
const { handler } = await import('./build/handler.js');

http
	.createServer((req, res) => {
		req.headers['x-wtfwid-protocol'] = 'http';
		handler(req, res, () => {
			res.statusCode = 404;
			res.end();
		});
	})
	.listen(port, host, () => console.log(`wtfwid is on http://${host}:${port}`));
