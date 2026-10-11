import type { GraphNode, Session, SessionNote } from './model';

/** A path as one shell word. */
const quote = (path: string) => (/^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`);

/** Claude Code session ids are UUIDs. Anything else is a stand-in wtfwid made up, and cannot be resumed. */
const resumable = (id: string) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);

/** A drive letter or a network share: the session ran on Windows. */
const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');

/**
 * The command that picks a session up where it stopped, or null when there is none (S-59).
 * Written for the shell the folder's own form points to: sh, bash, zsh or fish for a
 * Unix path, PowerShell for a Windows one, where "&&" and backslash-quoting do not exist.
 */
export function resumeCommand(session: Session): string | null {
	if (!resumable(session.id)) return null;
	if (isWindowsPath(session.cwd)) return `cd '${session.cwd.replaceAll("'", "''")}'; claude --resume ${session.id}`;
	return `cd ${quote(session.cwd)} && claude --resume ${session.id}`;
}

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);
const quoted = (text: string) => text.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');

/**
 * Everything wtfwid knows about a ticket, as a prompt to start a new session with (S-57).
 * It says where things are and how the last session ended. It does not copy the ticket's
 * own text: the new session can read that from Linear, and it would only go stale here.
 */
export function contextPack(node: GraphNode, notes: Record<string, SessionNote | null | undefined>): string {
	const out: string[] = [];
	const isTicket = node.status !== null;
	out.push(isTicket ? `Continue work on ${node.label}: ${node.title}` : `Continue this work: ${node.title}`, '');

	if (isTicket) out.push(`- Ticket: ${node.label}, status "${node.status}"${node.url ? `, ${node.url}` : ''}`);
	if (node.startedAt) out.push(`- Started: ${day(node.startedAt)}${node.completedAt ? `, completed ${day(node.completedAt)}` : ', not completed'}`);
	const branches = [...new Set(node.sessions.map((s) => s.branch).filter((b): b is string => !!b))];
	if (branches.length) out.push(`- Branch: ${branches.join(', ')}`);
	const folders = [...new Set(node.sessions.map((s) => s.cwd))];
	if (folders.length) out.push(`- Folder: ${folders.join(', ')}`);

	// pull requests wtfwid matched to the ticket, plus the ones its sessions say they opened
	const prs = new Map(node.prs.map((p) => [p.url, `#${p.number} ${p.title} (${p.state})`]));
	for (const s of node.sessions) for (const p of notes[s.id]?.prs ?? []) if (!prs.has(p.url)) prs.set(p.url, `#${p.number}`);
	for (const [url, text] of prs) out.push(`- Pull request: ${text}, ${url}`);

	const sessions = [...node.sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	for (const s of sessions) {
		const note = notes[s.id];
		out.push('', `## Earlier session${s.name ? ` "${s.name}"` : ''}, started ${day(s.startedAt)}`);
		if (!note) {
			// null: looked for and gone. Nothing at all: it could not be read, which is not the same claim.
			out.push('', note === null ? 'Its transcript is not on this machine any more.' : 'Its transcript could not be read just now.');
			continue;
		}
		if (note.firstPrompt && note.firstPrompt !== note.lastPrompt) out.push('', 'It was started with:', quoted(note.firstPrompt));
		if (note.lastPrompt) out.push('', 'The last thing I asked:', quoted(note.lastPrompt));
		if (note.lastReply) out.push('', `Where it ended${note.at ? ` (${day(note.at)})` : ''}:`, quoted(note.lastReply));
	}

	out.push('', 'Read the ticket and the pull requests first. Then tell me where this stands and what is left, before changing anything.');
	return out.join('\n');
}
