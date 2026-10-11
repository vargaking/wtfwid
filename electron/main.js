// The desktop app: runs the built wtfwid server inside this process, on a local port
// only this machine can reach, and shows it in one window.
import { app, BrowserWindow, safeStorage, session, shell } from 'electron';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

if (!app.requestSingleInstanceLock()) app.quit();

/**
 * An app started from a launcher does not get your shell's PATH, so `claude` and `gh`
 * would not be found. Ask a login shell what PATH is. `env` prints it the same way in
 * bash, zsh and fish.
 */
function shellPath() {
	if (process.platform === 'win32') return Promise.resolve(null);
	return new Promise((resolve) => {
		execFile(process.env.SHELL || '/bin/sh', ['-ilc', 'env'], { timeout: 5000 }, (error, stdout) => {
			const line = error ? null : stdout.split('\n').find((l) => l.startsWith('PATH='));
			resolve(line ? line.slice(5) : null);
		});
	});
}

/** Keys are encrypted with the OS keychain when there is one (S-72). */
function keychain() {
	if (!safeStorage.isEncryptionAvailable()) return undefined;
	// On Linux without a keyring, Electron falls back to a fixed password. That is not encryption.
	if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return undefined;
	return {
		encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
		decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64'))
	};
}

/** The local port the app serves itself on. Nothing special about the number. */
const PORT = 47113;

const isWeb = (url) => /^https?:\/\//.test(url);
let win;

app.on('second-instance', () => {
	if (win?.isMinimized()) win.restore();
	win?.focus();
});
app.on('window-all-closed', () => app.quit());

// Not `await app.whenReady()` at the top level: Electron holds "ready" back until this
// module has finished loading, so that would wait forever.
app.whenReady().then(start);

async function start() {
	const path = await shellPath();
	if (path) process.env.PATH = path;
	globalThis.__wtfwidVault = keychain();

	// Only this window may talk to the server (S-75).
	const token = randomBytes(24).toString('hex');
	process.env.WTFWID_TOKEN = token;

	let handler;
	const server = http.createServer((req, res) =>
		handler(req, res, () => {
			res.statusCode = 404;
			res.end();
		})
	);
	// The same port every time, so the window's own storage (S-78: zoom, folded lines) is
	// still there after a restart: a browser keeps storage per address. If something else
	// has the port, any free one will do and the view just opens fresh.
	await new Promise((resolve) => {
		server.once('error', () => server.listen(0, '127.0.0.1', resolve));
		server.listen(PORT, '127.0.0.1', resolve);
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	process.env.ORIGIN = origin; // the server reads this when it loads
	({ handler } = await import('../build/handler.js'));

	await session.defaultSession.cookies.set({ url: origin, name: 'wtfwid', value: token, httpOnly: true, sameSite: 'strict' });

	win = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 640,
		minHeight: 480,
		title: 'wtfwid',
		backgroundColor: '#0f1417',
		autoHideMenuBar: true,
		webPreferences: { sandbox: true }
	});

	// Links to Linear and GitHub open in your browser, never inside the app.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (isWeb(url)) shell.openExternal(url);
		return { action: 'deny' };
	});
	win.webContents.on('will-navigate', (event, url) => {
		if (url.startsWith(origin + '/')) return;
		event.preventDefault();
		if (isWeb(url)) shell.openExternal(url);
	});

	await win.loadURL(origin);
}
