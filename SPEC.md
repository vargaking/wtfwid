# wtfwid — spec, version 1

"What the f was I doing." One screen that shows every ticket you have worked on,
laid out on a timeline, with the state of the Claude Code session and pull request
behind it.

Every statement has an ID and a mark:

- **stated** — the owner said it.
- **assumed** — a default picked while building. Review these first.
- **open** — undecided. Nothing is built for it yet.

Tests name the statements they cover (`S-…` in the test title). `pnpm spec` runs the tests
and lists every built statement that no test names, and every test that names a statement
this file does not have. A statement that is checked some other way says so at its end:
`{no test: why}`.

## Purpose

- **S-01** stated — It is a personal tool, not a product. Maybe open source. {no test: an intention, not a behaviour}
- **S-02** stated — The view is visual. Lists and text are what it replaces. {no test: an intention, not a behaviour}
- **S-03** stated — Version 1 only reads. It changes nothing in Linear, GitHub or Claude Code.

## The timeline

- **S-10** stated — Time runs left to right, linearly, with no fixed window. Pan to go back.
- **S-11** stated — A feature is a horizontal line. A new feature can branch off an existing line.
- **S-12** stated — Finished features stay in place on the timeline. There is no separate "closed" section.
- **S-13** assumed — Finished lines are drawn faded and folded (S-16), and one button hides them altogether.
- **S-14** assumed — The view opens scrolled to now. Zoom changes pixels per day (buttons, or ctrl/cmd + wheel). {no test: scrolling and zooming, checked in a browser}
- **S-15** assumed — The counts in the header are buttons. Each one scrolls to the next ticket in that state and opens it, going round. A "now" button scrolls back to now. Reason: with stacked rows the timeline is taller than the window, and a ticket that needs you can be off screen. The counts include **open**: started, not finished, nothing running on it. For those the side panel also says how long ago they were started.
- **S-16** assumed — A finished line is folded: a thin strip with one row of small marks and no names, so history keeps its place without taking the room. Clicking the line's name unfolds it; clicking again folds it. Reason: with stacked rows (S-35) a line is as tall as its busiest moment, and most lines are finished.
- **S-17** assumed — A search box in the header finds tickets by ID, number or words in the title; `/` puts the cursor in it. Choosing a result scrolls to the ticket and opens it, unfolding or unhiding its line first if it is finished.
- **S-18** assumed — wtfwid sends a desktop notification when a ticket starts needing you, when a session fails, and when a session that was working stops. Clicking it shows the ticket. A button in the header turns this on and off; it starts on where notifications are already allowed (the desktop app) and off in a browser until you allow them. The number of tickets that need you is also in the window title. To notice quickly, the screen asks every 15 seconds whether any local session changed state, and reads everything again at once if one did. Answers from Linear and GitHub are reused for 45 seconds, so those quick refreshes only read the sessions again. A refresh where Linear or Claude Code could not be read is not compared with anything: tickets missing for a moment are not news.
- **S-19** assumed — With nothing selected, the side panel lists what is unfinished: most urgent first, then longest open first, each with its state and how long it has been going. Clicking one shows it on the timeline. Escape, or the back button on a ticket, returns to the list. Reason: it is the short answer to the question the tool is named after, in a place that was otherwise empty.
- **S-80** assumed — Under the timeline is an overview strip: all of time, from the first ticket to now, squeezed into the width of the timeline. Reason: the timeline opens at now and history scrolls off to the left, with nothing to show how much there is, where the busy weeks were, or where in it you are. A bar says how many tickets started in that stretch of time: a few hours while history is short, days or weeks as it grows. Its height follows the square root of the count, so one ticket can still be seen next to twenty. Finished work is dim. If anything in a bar is unfinished, the foot of the bar, at least half of it, has the colour of its most urgent state, so loose ends show wherever they sit in history. A window marks the part of time the timeline is showing; it follows scrolling and zooming and is never drawn narrower than 14 pixels. Clicking the strip brings that time to the middle of the timeline, dragging pans. There is a mark for now, and a few dates: days, Mondays, months or years, whichever fit. The strip counts the lines the timeline shows, so with "Hide finished" on the hidden ones are left out. The bars do not move when the timeline is zoomed, so a busy week stays where you remember it. For the keyboard and screen readers the strip is the timeline's scrollbar: arrow keys pan by a step, Page Up and Page Down by nearly a screenful, Home goes to the start, End to now. When the whole timeline fits in the window the strip stays, with the window over all of it: it is still the one place that shows how much happened when, and a strip that came and went would make the screen jump while zooming.

## What a line is

Based on how the Linear workspace this was built for is organised: a few hundred issues in
three weeks, grouped into projects and project milestones, no sub-issues.

- **S-20** assumed — Each Linear project is a trunk line. It carries the project's issues that have no milestone.
- **S-21** assumed — Each project milestone is a line that branches off its project's trunk at the time of its first activity.
- **S-22** assumed — Issues with no project go on a "No project" trunk.
- **S-23** assumed — Within a project, milestone lines are ordered newest first under the trunk, so branch connectors never cross another line.
- **S-24** open — A branch that starts from one specific session or ticket (stated: "from a voice chat line we branch off LiveKit setup, screen share"). Linear has no field for this today. Candidates: sub-issues, or an issue relation. Checked on real data: none of the 250 most recent issues has a parent, so sub-issues give nothing to draw. Another candidate: a session that moves from one ticket's branch to another's; "Check connections" (S-79) counts how many sessions do.

## What a node is

- **S-30** assumed — A node is one ticket (Linear issue). Its session and pull request are shown on the node, not as separate nodes. Reason: in the real data, ticket, session and pull request are close to one-to-one, and three nodes per ticket would triple the density.
- **S-31** assumed — The shape shows how far the ticket got: circle = ticket only, square = has a Claude Code session, diamond = has a pull request.
- **S-32** assumed — A ticket appears once it has been started or completed, or has a session or pull request. Untouched backlog is not shown.
- **S-33** assumed — Cancelled and duplicate issues are not shown.
- **S-34** assumed — A node sits at the time work began: issue `startedAt`, else first session, else first pull request, else completion.
- **S-35** assumed — Tickets started close together stack in rows under their line, in the order they started, and the lane grows to fit. Reason: in the real data tickets start in bursts, so on one row most of them merged into counted clusters at every zoom. A mark never moves off its own time and never overlaps another. When rows get crowded, names give way first: a ticket goes where its mark has room and the name before it is cut short. Only when every one of the five rows has a mark in the way does a ticket merge into the nearest one in time, which becomes a counted cluster, coloured by its most urgent member. A cluster's pill starts at its first ticket and reaches right.
- **S-36** assumed — A ticket still in play is drawn full size with its ID and title next to it, as much of them as fits before the next ticket in its row. A finished one is a small mark, with its ID or title in a dimmer colour under the same rule. A session that ended without a ticket is history too, whatever state it ended in. Every node has its full name as a tooltip.

## State

One state per ticket, the first of these that applies:

- **S-40** assumed — **needs you**: a live session on it is blocked or waiting for input.
- **S-41** assumed — **failed**: its most recent session failed and the issue is not completed.
- **S-42** assumed — **working**: a live session on it is busy.
- **S-43** assumed — **done**: the issue is completed.
- **S-44** assumed — **ready for review**: the issue's status name contains "review", or it has an open, non-draft pull request.
- **S-45** assumed — **open**: anything else.

## Linking

- **S-50** assumed — A session belongs to a ticket when its name, the git branch it is on, or its working directory contains the issue's branch name or its identifier (`ENG-123`, any case). The branch is read from the end of the session's transcript on every refresh, so a session does not have to be named after its ticket.
- **S-51** assumed — A pull request belongs to a ticket when its branch or title does.
- **S-52** assumed — Sessions that match no ticket go on an "Unsorted" line, so nothing running is hidden. Open pull requests that match no ticket go there too.
- **S-53** assumed — Claude Code only lists sessions that still exist. wtfwid remembers every session it has seen in `~/.wtfwid/sessions.json`. A remembered session that is no longer listed keeps its place; if it was working or waiting it becomes "open".
- **S-54** open — Planning chats on claude.ai. Nothing outside claude.ai can list them, so the link has to be written from inside the chat. Not built.
- **S-55** assumed — Opening a ticket shows, for each of its sessions: what it was started with, the last thing you asked, the last thing Claude said, and the pull requests it opened. This is read from Claude Code's own transcript of the session (`~/.claude/projects/…/<session id>.jsonl`) at the moment the ticket is opened. Nothing is written and no model is called. Reason: Claude's last message usually already says what was done and what is left. The transcript is not a documented format (checked against Claude Code 2.1.296), so a line that is not understood is skipped, and a transcript that is gone shows nothing.
- **S-56** open — "Same files" links between tickets, from pull request file lists. Not built.
- **S-57** assumed — Context pack: an unfinished ticket has a button that copies a prompt for a new session. It holds what wtfwid knows: the ticket's ID, status and link, the branch and folder, its pull requests, and for each earlier session what it was started with, the last thing asked and how it ended. It does not copy the ticket's own text; the new session reads that from Linear. Open: choosing what else to pull in (related tickets, files).
- **S-58** open — A written "decided / still open" summary per session. Needs a session-end hook that runs a model over the transcript: tokens on every session, and a change to your Claude Code settings. Not built; S-55 gets most of it for free.
- **S-59** assumed — A session whose transcript is still on the machine has a button that copies the command to resume it: `cd <its folder> && claude --resume <its id>`. wtfwid copies; it does not run anything. For a Windows folder the command is written for PowerShell (`cd '…'; claude --resume …`); that form has not been run on Windows.
- **S-83** assumed — wtfwid also finds past sessions on disk. Claude Code keeps a transcript of every session for a few weeks; each one is a session, with its folder, start, name, branch and last sign of life read from the first and last lines of the file. So the timeline has history the first time the app is opened, not only from then on. A found session is drawn on the ticket it belongs to. One that belongs to no ticket is left out: it is another project's. Found sessions are remembered like the others (S-53), so they outlive their transcripts.
- **S-84** assumed — For each session the side panel says what it did: how long it was at it (pauses over five minutes left out), how many prompts and commands, which files it edited and which of those it made, roughly how many lines it wrote and replaced, the tokens it used and what Claude Code says it cost. All of it read from the transcript. It only sees edits made with Claude Code's edit tools; a file changed by a shell command is not counted. The files a session changed most go into the context for a new session (S-57).
- **S-85** assumed — While a window is open, wtfwid follows the sessions that are running and shows what each is doing as it happens: the command it runs, the file it edits, the first line of what it says, what you typed. The side panel has a live feed per running session, the list of unfinished work shows each one's latest action, and a ticket with something running on it breathes on the timeline. It works by reading only what was added to each running session's transcript, once a second, and sending it to the window over one open connection. The same connection says at once when a session starts, stops or changes state, so the screen and the notifications (S-18) no longer wait for the next check. To learn that, wtfwid asks `claude agents` only when Claude Code's own session files change, and four times a minute regardless.

## Sources

- **S-60** assumed — Linear: GraphQL API with a personal API key, all issues of one team.
- **S-61** assumed — GitHub: the latest 300 pull requests of each configured repository.
- **S-62** assumed — Claude Code: `claude agents --json --all`, the supported way to read session state.
- **S-63** stated — On first open, with no Linear key, the screen shows a short setup form, not made-up data. Assumed: invented demo data is still there for anyone who asks for it (`/?demo`), and says that it is demo data.
- **S-66** assumed — When Linear is connected but nothing has been started yet, the screen says so instead of showing an empty timeline. {no test: one screen, checked in a browser}
- **S-64** assumed — If one source fails, the others still load and the screen shows a warning.
- **S-65** assumed — The screen reloads its data every 60 seconds. {no test: a timer, checked in a browser}

## Desktop app and settings

- **S-70** stated — It runs as a desktop app (Electron). The same screen still runs in a browser with `pnpm dev`. {no test: checked by running the desktop app}
- **S-71** stated — Keys and other settings are entered in a settings dialog. They are kept in `~/.wtfwid/settings.json`, readable only by the user.
- **S-72** assumed — The desktop app encrypts keys with the operating system's keychain. Where there is no keychain, and in the browser version, keys are stored without encryption and the dialog says so. A key the desktop app encrypted shows as unreadable in the browser version.
- **S-73** assumed — Saved settings win. Anything not saved falls back to `.env` and the environment.
- **S-74** assumed — A saved key is never sent back to the screen. The dialog can replace it or remove it, not show it.
- **S-75** assumed — Only you can reach it. It answers only requests addressed to this machine, and the desktop app also requires a one-off token that only its own window has.
- **S-76** assumed — Links to Linear and GitHub open in your browser, not inside the app. {no test: checked by running the desktop app}
- **S-77** assumed — The desktop app takes `PATH` from a login shell, so it finds `claude` and `gh` when started from a launcher. {no test: checked by running the desktop app}
- **S-78** assumed — The zoom, the "Hide finished" choice and which finished lines are unfolded are remembered on this machine, so the view comes back the way it was left. Stored in the window's own storage, not in the settings file. For that storage to survive a restart, the desktop app serves itself on the same local port every time (47113), and takes any free one if that is in use.
- **S-79** assumed — Settings has a "Check connections" button. It tries each source for real with the saved settings and says what came back: how many Linear issues, how many pull requests per repository, how many Claude Code sessions, whether their transcripts can be read, and how many sessions end up on a ticket. It shows counts only, never a title or what a session said, so the result can be pasted anywhere.
