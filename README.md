# wtfwid

What the f was I doing.

One screen for everything you have in flight: every ticket you have worked on, on a
timeline, with the state of the Claude Code session and the pull request behind it.

![The timeline with demo data](docs/demo.png)

- A line is a Linear project. Its milestones branch off it.
- A node is a ticket. A circle is a ticket alone, a square has a Claude Code session, a diamond has a pull request.
- Colour is state: amber needs you, blue is working, green is ready for review, red failed, faded is done.
- Time runs left to right with no window. Drag to pan, ctrl/cmd + wheel to zoom.
- A strip under the timeline shows all of time at once: bars for how much started when, coloured where something is unfinished, and a window around the part you are looking at. Click or drag it to go there.
- Tickets too close to draw apart merge into a counted cluster, coloured by the most urgent one in it.
- Open a ticket and lines go from it to the tickets it belongs with: the ones whose sessions changed the same files, and the ones a session came from or went on to. The side panel says why, and how much work went into it.
- Click a date on the axis to see that day: how long sessions were at work, on which tickets, and what was started and completed.

It only reads. It changes nothing in Linear, GitHub or Claude Code.

## Run it

Needs Node 22 and pnpm.

```sh
pnpm install
pnpm desktop     # builds and opens the desktop app
```

Or in a browser: `pnpm dev`.

On first open it asks for your Linear key. (To look around with invented data first, follow
the demo link on that screen.) Everything can be changed later under **Settings**:

| Setting | What it is |
| --- | --- |
| Linear API key | A personal API key. Linear: Settings → Account → Security & Access. |
| Linear team key | The prefix of your issue IDs, e.g. `ENG`. Empty reads every team. |
| GitHub repositories | `owner/repo`, comma separated. |
| GitHub token | Optional. Without one, wtfwid uses `gh auth token`. |

Sessions come from `claude agents --json --all`, so Claude Code has to be installed on the
machine wtfwid runs on.

### Where your keys go

Into `~/.wtfwid/settings.json`, readable only by you. A saved key is never sent back to the
screen; the dialog can only replace or remove it.

- The desktop app encrypts keys with your system keychain. The dialog tells you whether it did.
- On Linux that needs a running keyring (GNOME Keyring or KWallet). On a bare window
  manager Electron does not look for one; start the app with
  `--password-store=gnome-libsecret` to use GNOME Keyring anyway.
- The browser version has no keychain and stores keys without encryption.

A `.env` file still works (see `.env.example`). Saved settings win over it.

### Download it

Installers for Linux (AppImage), Windows and macOS are on the
[releases page](https://github.com/vargaking/wtfwid/releases). Nothing is code-signed, so
Windows and macOS will warn before running it. The Windows and macOS builds come straight
out of CI and have not been run by a person.

A release is published automatically: raise `"version"` in `package.json`, merge to `main`,
and the workflow in `.github/workflows/release.yml` builds all three and publishes them as
`v<version>`.

### New versions

When a newer release is out, the header says so, next to "updated HH:MM".

- **Linux AppImage:** it is a button, "Update to v0.1.2". It downloads the new AppImage
  next to the one you are running, checks its size and SHA-256 against what GitHub
  published for the release, and puts it in place of the old file. Then the button says
  "Restart to finish". wtfwid never restarts by itself. If the download does not check out,
  it is deleted, nothing changes, and the header says what failed.
  The file keeps its name: `wtfwid-0.1.1-linux-x86_64.AppImage` is still called that when
  it holds 0.1.2, so the launcher or desktop entry that points at it keeps working. The
  folder the AppImage is in has to be writable by you.
- **Windows, macOS, the browser version, a run from source:** it is a link to the release
  page. Those builds are not code-signed, so they cannot replace themselves safely;
  download the new installer there. From source, `git pull && pnpm install`.

To find out, wtfwid makes one request to GitHub's public API
(`api.github.com/repos/vargaking/wtfwid/releases/latest`) when it starts and every 6 hours
after that. The request carries no key and no token, not your GitHub token either, and
says nothing about you or your tickets; GitHub sees an address asking for a public page.
Offline, it just finds nothing. Set `WTFWID_NO_UPDATE_CHECK=1` and it never asks.

### The tray, and keeping it running

The desktop app has a tray icon, with an amber dot when a ticket needs you. Its menu:

- **Show wtfwid** brings the window back.
- **2 need you** (or "Nothing needs you") does the same.
- **Keep running when the window is closed**, off until you tick it. With it on, closing
  the window hides it and wtfwid goes on running, so its notifications keep coming.
- **Quit** really quits, also with "keep running" on. So do Ctrl+Q and Cmd+Q.

The choice is kept in `~/.wtfwid/desktop.json`.

A desktop without a tray (plain GNOME, unless you added an extension for it) never shows
the icon, and wtfwid cannot tell. Nothing depends on it: starting wtfwid again always
shows the window of the one that is already running.

### Package it yourself

```sh
pnpm dist        # writes an installer for your OS into dist/
```

### Without Electron

`pnpm build && pnpm start` serves the same screen on `127.0.0.1:4173`.

## When something does not show up

Open Settings and press **Check**. It tries Linear, GitHub and Claude Code with the
settings as saved and says what each gave back, and how many sessions ended up on a
ticket. It shows counts only, so you can paste the result into an issue.

## How a session ends up on the right ticket

By branch or by name. A session or pull request belongs to a ticket when its branch, name
or working directory contains the issue identifier (`ENG-123`) or Linear's branch name for
the issue. wtfwid reads the branch a session is on from Claude Code's transcript of it, so
working on the ticket's branch is enough. Naming the session works too:

```sh
claude -n "ENG-123 reconnect loop"
```

Anything that matches no ticket goes on an **Unsorted** line, so nothing running is hidden.

Claude Code only lists sessions that still exist. wtfwid keeps every session it has seen
in `~/.wtfwid/sessions.json`, so they stay on the timeline after they are gone.

## What a session was doing

Open a ticket and each of its sessions shows what it was started with, the last thing you
asked, the last thing Claude said and the pull requests it opened, and what it did: how
long it was at it, the files it edited, the commands it ran, roughly how many lines it
wrote, and the tokens it used. That comes straight from Claude Code's transcript of the
session, read when you open the ticket. Nothing is written and no model is called.

From there you can copy the command that resumes a session (`claude --resume …` in its
folder), or copy a prompt that hands a new session everything wtfwid knows about the ticket.

While a session is running you can watch it: the panel shows what it is doing as it happens
(the command it runs, the file it edits, what it says), and its ticket breathes on the timeline.

Past sessions are found the same way. Every transcript under `~/.claude/projects` is a
session, so the timeline has your history the first time you open the app. A past session
is drawn on the ticket whose branch it was on; one that matches no ticket is left out.

## Sessions that run in the cloud

wtfwid reads sessions from the machine it runs on. A session you start on claude.ai/code
runs on Anthropic's machines: it is not in `claude agents`, it leaves no transcript here,
and nothing outside claude.ai can list it or say whether it is waiting for you.

What it does leave is its link, in the description of the pull request it opens and as a
`Claude-Session:` trailer on its commits. wtfwid reads those:

- A ticket whose pull request names a session shows **Cloud session** with a button that
  opens it on claude.ai.
- One cloud session that worked on several tickets is drawn as one line of work through
  them when you open any of them, and the panel lets you step along it.
- The panel counts what the pull requests hold (commits, lines), the time axis shows when
  the commits were made, and a day lists the tickets that had commits.
- Tickets are related by the files their pull requests change.

This needs a GitHub token (or a logged-in `gh`), because it reads the files and commits of
each pull request: two requests per pull request, once, kept in `~/.wtfwid/pulls.json`.

Not shown for a cloud session, because nothing says it: whether it is running or waiting,
how long it worked, what it cost.

## Which tickets belong together

Nobody tells wtfwid that; it works it out from what the sessions and pull requests did.
Two tickets are related when the same files were changed for both, the more so the fewer
other tickets touched those files, and when one session worked on both. Open a
ticket and the timeline draws the lines: solid with an arrow the way a session went, dotted
for shared files. The same tickets are listed in the side panel with the reason, and they
go into the prompt you copy for a new session.

For this each transcript is read once and a short digest of it (files, branches, when it
was at work, tokens and cost) is kept in `~/.wtfwid/index.json`, readable only by you, so
it is still there after Claude Code has deleted the transcript. Only edits made with Claude
Code's own edit tools are seen; a file changed by a shell command is not.

## In your status bar

One line that says whether a session is waiting for you, without opening the app:

```sh
node scripts/status.js            # 2 need you · 3 working    (or: idle)
node scripts/status.js --json     # the counts, and each running session
node scripts/status.js --watch    # keeps running, prints a line only when it changed
node scripts/status.js --help
```

It asks Claude Code and nothing else, so it needs no Linear key and no running app. It does
need Node and this checkout: it is not inside the AppImage or the installers.

For [Waybar](https://github.com/Alexays/Waybar), add `custom/wtfwid` to a modules list and:

```jsonc
"custom/wtfwid": {
	"exec": "node /path/to/wtfwid/scripts/status.js --waybar --watch",
	"return-type": "json",
	"restart-interval": 30
}
```

The module shows how many sessions need you, or how many are working when none do, and
nothing when idle. Its tooltip lists them. Its class is `needs`, `working`, `idle` or `error`:

```css
#custom-wtfwid.needs { color: #ffb000; }
#custom-wtfwid.working { color: #4fb3ff; }
```

If it stays empty while a session is running, run the `exec` command in a terminal. Most
often Waybar was started with a `PATH` that does not have `claude` in it.

In tmux: `set -g status-right '#(node /path/to/wtfwid/scripts/status.js)'`. A shell prompt
can call it the same way, but every call starts `claude` and takes about half a second.

## What it does not do yet

See [SPEC.md](SPEC.md). Every behaviour there has an ID and is marked *stated*, *assumed*
or *open*; the tests name the statements they cover. `pnpm spec` lists the statements no
test names yet. The open ones:

- planning chats on claude.ai as nodes
- a written "decided / still open" summary per session
- branches that start from one specific session
- "same files" links between tickets

## Development

```sh
pnpm test     # unit tests
pnpm check    # types
```
