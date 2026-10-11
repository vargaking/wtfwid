-- The relay's two tables. Each row is one JSON document; see worker.js.
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions (updated_at);
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS notes_at ON notes (at);
