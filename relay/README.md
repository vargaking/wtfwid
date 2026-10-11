# The wtfwid relay

wtfwid runs on your own machine. A Claude Code session that runs in the cloud cannot reach
it, and nothing outside claude.ai can ask such a session how it is doing. So the session
says so itself, to a very small server of your own on the internet, and wtfwid reads that
server. This folder is that server, and the two things that talk to it.

```
a cloud session ── hook.sh ──▶                 ◀── wtfwid on your machine
a chat or session ─ connector ─▶    relay
```

What you get: a cloud session shows on its ticket as **working**, **needs you** or **its
turn is over**, with what you last asked and what it last said, and wtfwid notifies you
the same way it does for local sessions. And any conversation, a Claude Project chat
included, can leave a note on a ticket: what was decided, what is still open.

What the relay keeps: the latest state of each session and the notes, for six weeks. Up to
400 characters of your last prompt and 1,200 of Claude's last reply per session. No
transcripts, no tickets, no keys.

There are two tokens. The **write token** is for sessions and the connector. The **read
token** is for wtfwid. Neither can do the other's job.

## 1. Run the relay

### On Cloudflare (free tier is enough)

```sh
cd relay
npx wrangler login
npx wrangler d1 create wtfwid-relay           # prints a database_id: put it in wrangler.toml
npx wrangler d1 execute wtfwid-relay --remote --file schema.sql
npx wrangler deploy                           # prints the address, https://wtfwid-relay.<you>.workers.dev

W=$(openssl rand -hex 32); R=$(openssl rand -hex 32)
echo "write token: $W"; echo "read token:  $R"   # keep these two
printf %s "$W" | npx wrangler secret put WRITE_TOKEN
printf %s "$R" | npx wrangler secret put READ_TOKEN
```

Until both tokens are set the relay answers nobody. To change a token later, `secret put`
it again.

wtfwid asks the relay every five seconds while a window is open, about 17,000 requests a
day. Cloudflare's free tier allows 100,000.

### On a machine of your own

```sh
RELAY_WRITE_TOKEN=… RELAY_READ_TOKEN=… node relay/server.js     # 127.0.0.1:8787, data in ./wtfwid-relay.json
```

It speaks plain http, so put it behind something that adds https before it faces the
internet. On your own computer it is a way to try all of this without deploying anything:
wtfwid accepts `http://127.0.0.1:8787` as a relay address.

## 2. Tell wtfwid

Settings → **Relay address** and **Relay read token**. "Check connections" then has a
Relay line that says how many sessions have reported.

## 3. Make sessions report

In each repository:

```sh
mkdir -p .claude/hooks
cp /path/to/wtfwid/relay/hook.sh .claude/hooks/wtfwid.sh
chmod +x .claude/hooks/wtfwid.sh
```

and put the `hooks` block of [`settings.example.json`](settings.example.json) into the
repository's `.claude/settings.json` (merge it with what is there). Commit both.

The hook does nothing unless two variables are set, so it is safe to commit, also to a
public repository: other people's sessions skip it, and nothing in the repository says
where your relay is. Set the two in the **cloud environment** your sessions use
(claude.ai/code → the environment's settings):

```
WTFWID_RELAY_URL=https://wtfwid-relay.<you>.workers.dev
WTFWID_RELAY_TOKEN=<the write token>
```

and add the relay's domain to that environment's **allowed domains** (network access:
Custom). Without that the hook cannot reach it, and stays silent.

Things to know:

- Anyone who uses that cloud environment can read its variables. Use an environment of your own.
- A cloud session with **several repositories** does not run repository hooks at all. That is
  Claude Code's rule; such a session reports nothing.
- The same hook works for sessions on your own machines: set the two variables in your shell.
- It runs in the background and always exits 0. It cannot hold a session up or fail it.
- A session sitting at its prompt after a finished turn shows as "its turn is over", not
  "needs you". "Needs you" is for a permission question or a question it asked you.

## 4. The connector (optional)

Three tools: `wtfwid_note` (leave a note on a ticket), `wtfwid_link` (say which ticket a
session is for, when its branch does not say), `wtfwid_recall` (read back what is noted).

**On claude.ai** (chats, Projects, and cloud sessions, which get your connectors): Settings →
Connectors → add a custom connector with the address

```
https://wtfwid-relay.<you>.workers.dev/mcp/<the write token>
```

claude.ai cannot send a fixed header to a custom connector, so the token is part of the
address. Treat that address as the secret it is.

**In Claude Code on your machine:**

```sh
claude mcp add --transport http wtfwid "$WTFWID_RELAY_URL/mcp" --header "Authorization: Bearer $WTFWID_RELAY_TOKEN"
```

A chat does not note things by itself. Tell it to, once, in the Project's instructions or
your `CLAUDE.md`:

> When we reach a conclusion about a ticket, call `wtfwid_note` with the ticket ID, what
> was decided and what is still open.

## If a token leaks

Someone with the write token can post made-up session states and notes, and read the notes
through `wtfwid_recall`. Someone with the read token can read what sessions reported.
Neither gets at your code, your tickets or your keys. Put a new token in place
(`wrangler secret put …`) and update the three places that use it.
