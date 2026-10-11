#!/bin/sh
# Tells the wtfwid relay what this Claude Code session is doing (S-91).
#
# Copy this file into a repository as .claude/hooks/wtfwid.sh, make it executable, and add
# the hooks from settings.example.json to the repository's .claude/settings.json.
#
# It does nothing at all unless WTFWID_RELAY_URL and WTFWID_RELAY_TOKEN are set, so it is
# safe to commit, also to a public repository: everyone else's sessions just skip it. Set
# the two in the environment of the sessions that should report. For sessions in the cloud
# that is the environment's settings on claude.ai/code, and the relay's domain has to be
# on that environment's list of allowed domains.
#
# It never fails and never holds the session up: whatever goes wrong, it exits 0.

[ -n "$WTFWID_RELAY_URL" ] && [ -n "$WTFWID_RELAY_TOKEN" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0

# Claude Code hands the event to a hook as JSON on standard input.
input=$(cat)

dir="${CLAUDE_PROJECT_DIR:-.}"
branch=$(git -C "$dir" branch --show-current 2>/dev/null)
# owner/name, from an address like git@github.com:owner/name.git or https://github.com/owner/name
repo=$(git -C "$dir" remote get-url origin 2>/dev/null | sed -E 's#^.*[:/]([^/:]+/[^/]+)$#\1#; s#\.git$##')

printf '%s' "$input" | curl --silent --show-error --max-time 4 \
	--request POST "${WTFWID_RELAY_URL%/}/hook" \
	--header "authorization: Bearer $WTFWID_RELAY_TOKEN" \
	--header 'content-type: application/json' \
	--header "x-wtfwid-session: ${CLAUDE_CODE_REMOTE_SESSION_ID:-}" \
	--header "x-wtfwid-branch: $branch" \
	--header "x-wtfwid-repo: $repo" \
	--data-binary @- >/dev/null 2>&1

exit 0
