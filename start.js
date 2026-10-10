// Runs the built app in your browser. Local only by default: it shows your tickets and
// sessions, and takes your API keys, so nothing outside this machine should reach it.
process.env.HOST ??= '127.0.0.1';
process.env.PORT ??= '4173';
process.env.ORIGIN ??= `http://${process.env.HOST}:${process.env.PORT}`;
await import('./build/index.js');
