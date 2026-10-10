# wtfwid — spec, version 1

"What the f was I doing." One screen that shows every ticket you have worked on,
laid out on a timeline, with the state of the Claude Code session and pull request
behind it.

Every statement has an ID and a mark:

- **stated** — the owner said it.
- **assumed** — a default picked while building. Review these first.
- **open** — undecided. Nothing is built for it yet.

Tests name the statements they cover (`S-…` in the test title).

## Purpose

- **S-01** stated — It is a personal tool, not a product. Maybe open source.
- **S-02** stated — The view is visual. Lists and text are what it replaces.
- **S-03** stated — Version 1 only reads. It changes nothing in Linear, GitHub or Claude Code.

## The timeline

- **S-10** stated — Time runs left to right, linearly, with no fixed window. Pan to go back.
- **S-11** stated — A feature is a horizontal line. A new feature can branch off an existing line.
- **S-12** stated — Finished features stay in place on the timeline. There is no separate "closed" section.
- **S-13** assumed — Finished lines are drawn faded, and one button hides them.
- **S-14** assumed — The view opens scrolled to now. Zoom changes pixels per day (buttons, or ctrl/cmd + wheel).

## What a line is

Based on how the Linear workspace this was built for is organised: a few hundred issues in
three weeks, grouped into projects and project milestones, no sub-issues.

- **S-20** assumed — Each Linear project is a trunk line. It carries the project's issues that have no milestone.
- **S-21** assumed — Each project milestone is a line that branches off its project's trunk at the time of its first activity.
- **S-22** assumed — Issues with no project go on a "No project" trunk.
- **S-23** assumed — Within a project, milestone lines are ordered newest first under the trunk, so branch connectors never cross another line.
- **S-24** open — A branch that starts from one specific session or ticket (stated: "from a voice chat line we branch off LiveKit setup, screen share"). Linear has no field for this today. Candidates: sub-issues, or an issue relation.

## What a node is

- **S-30** assumed — A node is one ticket (Linear issue). Its session and pull request are shown on the node, not as separate nodes. Reason: in the real data, ticket, session and pull request are close to one-to-one, and three nodes per ticket would triple the density.
- **S-31** assumed — The shape shows how far the ticket got: circle = ticket only, square = has a Claude Code session, diamond = has a pull request.
- **S-32** assumed — A ticket appears once it has been started or completed, or has a session or pull request. Untouched backlog is not shown.
- **S-33** assumed — Cancelled and duplicate issues are not shown.
- **S-34** assumed — A node sits at the time work began: issue `startedAt`, else first session, else first pull request, else completion.
- **S-35** assumed — Nodes that would overlap at the current zoom merge into one counted cluster, coloured by its most urgent member. Zooming in separates them.

## State

One state per ticket, the first of these that applies:

- **S-40** assumed — **needs you**: a live session on it is blocked or waiting for input.
- **S-41** assumed — **failed**: its most recent session failed and the issue is not completed.
- **S-42** assumed — **working**: a live session on it is busy.
- **S-43** assumed — **done**: the issue is completed.
- **S-44** assumed — **ready for review**: the issue's status name contains "review", or it has an open, non-draft pull request.
- **S-45** assumed — **open**: anything else.

## Linking

- **S-50** assumed — A session belongs to a ticket when its name or working directory contains the issue's branch name or its identifier (`ENG-123`, any case).
- **S-51** assumed — A pull request belongs to a ticket when its branch or title does.
- **S-52** assumed — Sessions that match no ticket go on an "Unsorted" line, so nothing running is hidden. Open pull requests that match no ticket go there too.
- **S-53** assumed — Claude Code only lists sessions that still exist. wtfwid remembers every session it has seen in `~/.wtfwid/sessions.json`. A remembered session that is no longer listed keeps its place; if it was working or waiting it becomes "open".
- **S-54** open — Planning chats on claude.ai. Nothing outside claude.ai can list them, so the link has to be written from inside the chat. Not built.
- **S-55** open — What a session decided and what it left open (the side panel in the mockup). Needs a session-end hook that writes a summary. Not built.
- **S-56** open — "Same files" links between tickets, from pull request file lists. Not built.
- **S-57** open — Context pack: select a ticket and start a session with everything linked to it. Not built.

## Sources

- **S-60** assumed — Linear: GraphQL API with a personal API key, all issues of one team.
- **S-61** assumed — GitHub: the latest 300 pull requests of each configured repository.
- **S-62** assumed — Claude Code: `claude agents --json --all`, the supported way to read session state.
- **S-63** assumed — With no Linear key configured, the screen shows invented demo data and says so.
- **S-64** assumed — If one source fails, the others still load and the screen shows a warning.
- **S-65** assumed — The screen reloads its data every 60 seconds.
