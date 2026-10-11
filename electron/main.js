// The desktop app: runs the built wtfwid server inside this process, on a local port
// only this machine can reach, and shows it in one window.
import { app, BrowserWindow, Menu, nativeImage, safeStorage, session, shell, Tray } from 'electron';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { closeAction, home, needsFromTitle, needsLabel, readDesktop, trayMenu, writeDesktop } from './desktop.js';
import { createUpdater, ownAppImage } from './update.js';

// Only one wtfwid runs at a time. Starting it again shows the window of the one that is
// running (see 'second-instance') and stops here.
const first = app.requestSingleInstanceLock();
if (!first) app.quit();

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
let tray;
/** How many tickets need you, as the page last said in the window title. */
let needs = 0;
/** S-81: closing the window hides it. Off unless you turn it on in the tray menu. */
let keepRunning = false;
/** True once the app is really on its way out, so closing the window is not turned into hiding. */
let quitting = false;

/** Brings the window back, wherever it went: hidden, minimised or behind something. */
function showWindow() {
	if (!win || win.isDestroyed()) return;
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
}

const resource = (name) => fileURLToPath(new URL(`./resources/${name}`, import.meta.url));

/** The tray icon, with an amber dot when something needs you. */
function trayIcon() {
	const name = needs ? 'tray-needs' : 'tray';
	// 32px, and Electron finds the 64px `@2x` file next to it for dense screens
	if (process.platform !== 'darwin') return nativeImage.createFromPath(resource(`${name}.png`));
	// The macOS menu bar wants 16 points: there the same two files are its 2x and 4x.
	const image = nativeImage.createEmpty();
	image.addRepresentation({ scaleFactor: 2, buffer: readFileSync(resource(`${name}.png`)) });
	image.addRepresentation({ scaleFactor: 4, buffer: readFileSync(resource(`${name}@2x.png`)) });
	return image;
}

/** Puts the current count and choice into the tray: icon, menu, tooltip. */
function refreshTray() {
	if (!tray) return;
	const actions = {
		show: showWindow,
		needs: showWindow,
		keep: (item) => setKeepRunning(item.checked),
		quit: () => app.quit()
	};
	try {
		tray.setImage(trayIcon());
		tray.setToolTip(needs ? `wtfwid: ${needsLabel(needs)}` : 'wtfwid');
		if (process.platform === 'darwin') tray.setTitle(needs ? String(needs) : '');
		// set again on every change: on Linux a menu that is already showing does not update
		tray.setContextMenu(Menu.buildFromTemplate(trayMenu({ needs, keepRunning }).map((item) => ({ ...item, click: actions[item.id] }))));
	} catch {
		// a tray that cannot be drawn must not take the app down with it
	}
}

/**
 * A plain GNOME desktop has no tray: the icon is never shown, and Electron cannot tell.
 * So nothing depends on it. If it cannot be made at all, the app runs without one.
 */
function createTray() {
	try {
		tray = new Tray(trayIcon());
		tray.on('click', showWindow);
	} catch {
		tray = undefined;
	}
	refreshTray();
}

function setNeeds(count) {
	if (count === needs) return;
	needs = count;
	try {
		// the macOS dock and some Linux launchers show it; elsewhere this does nothing
		app.setBadgeCount?.(needs);
	} catch {
		// no badge here
	}
	refreshTray();
}

function setKeepRunning(on) {
	keepRunning = on;
	refreshTray();
	// if the file cannot be written, the choice lasts until the app quits
	writeDesktop(home(), { keepRunning }).catch(() => {});
}

app.on('second-instance', showWindow);
// macOS: a click on the dock icon
app.on('activate', showWindow);
// Quit in the tray menu, Ctrl+Q or Cmd+Q, and a restart for a new version all come through here.
app.on('before-quit', () => (quitting = true));
app.on('window-all-closed', () => app.quit());

// Not `await app.whenReady()` at the top level: Electron holds "ready" back until this
// module has finished loading, so that would wait forever.
if (first) app.whenReady().then(start);

async function start() {
	const path = await shellPath();
	if (path) process.env.PATH = path;
	globalThis.__wtfwidVault = keychain();

	// S-82: the server can install a new version through this, where the app runs from an
	// AppImage. Everywhere else `appImage` is null and the screen only links to the release.
	const appImage = ownAppImage({ packaged: app.isPackaged });
	globalThis.__wtfwidUpdate = createUpdater({
		appImage,
		// The only place the app restarts itself. It is reached from "Restart to finish" and
		// from nowhere else: sessions may be running, and you may be reading.
		relaunch() {
			// The AppImage file, not the program inside it: that one is the old version. Given
			// another program to start, Electron leaves out the command line, so it is handed
			// over: a start with `--password-store=…` must come back with it.
			app.relaunch({ execPath: appImage, args: process.argv.slice(1) });
			app.quit();
		}
	});

	keepRunning = (await readDesktop(home())).keepRunning;

	// Only this window may talk to the server (S-75).
	const token = randomBytes(24).toString('hex');
	process.env.WTFWID_TOKEN = token;

	let handler;
	const server = http.createServer((req, res) => {
		// the port is open a moment before the app behind it has loaded
		if (!handler) {
			res.statusCode = 503;
			res.end();
			return;
		}
		handler(req, res, () => {
			res.statusCode = 404;
			res.end();
		});
	});
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

	// S-81: the page says how many tickets need you in its title; the tray repeats it.
	win.on('page-title-updated', (_event, title) => setNeeds(needsFromTitle(title)));
	// With "keep running" on, closing the window hides it: the page stays alive and its
	// notifications keep coming. Starting wtfwid again, or the tray, brings it back.
	win.on('close', (event) => {
		if (closeAction({ keepRunning, quitting }) !== 'hide') return;
		event.preventDefault();
		win.hide();
	});
	createTray();

	await win.loadURL(origin);
}
