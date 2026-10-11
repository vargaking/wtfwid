// What the screen and the server say to each other about new versions (S-82).

/** The answer of `GET /api/version`. */
export interface VersionInfo {
	current: string;
	/** Null when the running version is the newest, or nothing is known. */
	latest: { version: string; url: string } | null;
	/** True only where the app can replace itself: a Linux AppImage with a file for this machine. */
	canInstall: boolean;
}

/** The answer of `GET /api/update`: how far an install has got. */
export type UpdateStatus =
	| { state: 'idle' }
	| { state: 'downloading'; bytes: number; total: number }
	/** The new file is in place. It starts running at the next restart. */
	| { state: 'ready' }
	| { state: 'failed'; message: string };

/**
 * How the screen asks for an install or a restart. Sent as JSON, like the settings are: the
 * built server refuses a POST that could be a form on someone else's web page, and to it a
 * POST with no content type is one.
 */
export const ASK = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } as const;

/** How often the screen asks whether there is a new version. The server keeps the answer as long. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** How far a download is, 0 to 100. Never 100 before every byte is there. */
export function percent(bytes: number, total: number): number {
	if (!(total > 0) || !(bytes > 0)) return 0;
	return bytes >= total ? 100 : Math.min(99, Math.floor((bytes / total) * 100));
}

/** What the update button says, or null when there is nothing to press. */
export function buttonText(version: string, status: UpdateStatus): string | null {
	if (status.state === 'idle') return `Update to v${version}`;
	if (status.state === 'downloading') return `Downloading ${percent(status.bytes, status.total)}%`;
	if (status.state === 'ready') return 'Restart to finish';
	return null;
}
