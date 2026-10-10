# wtfwid

What the f was I doing.

One screen for everything you have in flight: every ticket you have worked on, on a
timeline, with the state of the Claude Code session and the pull request behind it.

![The timeline with demo data](docs/demo.png)

- A line is a Linear project. Its milestones branch off it.
- A node is a ticket. A circle is a ticket alone, a square has a Claude Code session, a diamond has a pull request.
- Colour is state: amber needs you, blue is working, green is ready for review, red failed, faded is done.
- Time runs left to right with no window. Drag to pan, ctrl/cmd + wheel to zoom.
- Tickets too close to draw apart merge into a counted cluster, coloured by the most urgent one in it.

It only reads. It changes nothing in Linear, GitHub or Claude Code.

## Run it

Needs Node 22 and pnpm.

```sh
pnpm install
pnpm dev
```

With nothing configured it shows demo data. To see your own:

```sh
cp .env.example .env    # then fill it in
```

| Variable | What it is |
| --- | --- |
| `LINEAR_API_KEY` | A Linear personal API key. |
| `WTFWID_LINEAR_TEAM` | Team key, e.g. `ENG`. Empty reads every team. |
| `WTFWID_GITHUB_REPOS` | `owner/repo`, comma separated. |
| `GITHUB_TOKEN` | Optional. Falls back to `gh auth token`. |

Sessions come from `claude agents --json --all`, so Claude Code has to be installed on the
machine wtfwid runs on.

To run a build instead of the dev server: `pnpm build && pnpm start`. It listens on
`127.0.0.1:4173`.

## How a session ends up on the right ticket

By name. A session or pull request belongs to a ticket when its name, branch or working
directory contains the issue identifier (`ENG-123`) or Linear's branch name for the issue.

```sh
claude -n "ENG-123 reconnect loop"
```

Anything that matches no ticket goes on an **Unsorted** line, so nothing running is hidden.

Claude Code only lists sessions that still exist. wtfwid keeps every session it has seen
in `~/.wtfwid/sessions.json`, so they stay on the timeline after they are gone.

## What it does not do yet

See [SPEC.md](SPEC.md). Every behaviour there has an ID and is marked *stated*, *assumed*
or *open*; the tests name the statements they cover. The open ones:

- planning chats on claude.ai as nodes
- what a session decided and what it left open
- branches that start from one specific session
- "same files" links between tickets
- starting a new session with everything linked to a ticket

## Development

```sh
pnpm test     # unit tests
pnpm check    # types
```
