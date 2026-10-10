// Runs the built app. Local only by default: it shows your tickets and sessions to whoever can reach it.
process.env.HOST ??= '127.0.0.1';
process.env.PORT ??= '4173';
await import('./build/index.js');
