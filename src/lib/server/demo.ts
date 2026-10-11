import type { Digest, Issue, PullRequest, Session, Snapshot } from '../model';

const HOUR = 3_600_000;

type Extra = 'needs' | 'working' | 'failed' | 'review';
/** number, title, project, milestone, hours ago it started, hours it took (null = not finished), what is going on */
type Row = [number, string, string, string | null, number, number | null, Extra?];

const ROWS: Row[] = [
	[1, 'Login form validation', 'Web app', null, 640, 5],
	[2, 'Rate-limit the websocket', 'Web app', null, 610, 8],
	[3, 'Fix avatar upload on Safari', 'Web app', null, 300, 3],
	[4, 'Dark theme tokens', 'Web app', null, 200, 6],
	[5, 'Flaky end-to-end test on cold start', 'Web app', null, 30, null, 'failed'],
	[10, 'Message pagination', 'Web app', 'Messaging', 600, 10],
	[11, 'Edit and delete', 'Web app', 'Messaging', 560, 7],
	[12, 'Reactions', 'Web app', 'Messaging', 520, 6],
	[13, 'Typing indicator', 'Web app', 'Messaging', 500, 3],
	[14, 'Unread markers', 'Web app', 'Messaging', 470, 9],
	[20, 'Join and leave a voice room', 'Web app', 'Voice', 430, 12],
	[21, 'Mute and deafen', 'Web app', 'Voice', 400, 4],
	[22, 'Voice presence in the sidebar', 'Web app', 'Voice', 380, 6],
	[23, 'Device picker', 'Web app', 'Voice', 250, 5],
	[24, 'Reconnect after a network change', 'Web app', 'Voice', 52, null, 'needs'],
	[25, 'Echo cancellation test page', 'Web app', 'Voice', 5, null, 'working'],
	[30, 'Capture and publish the screen', 'Web app', 'Screen share', 180, 9],
	[31, 'Viewer layout', 'Web app', 'Screen share', 150, 7],
	[32, 'Per-stream bitrate', 'Web app', 'Screen share', 75, null, 'review'],
	[33, 'System audio capture', 'Web app', 'Screen share', 60, null],
	[34, 'Pop-out stream window', 'Web app', 'Screen share', 3, null, 'working'],
	[40, 'Electron shell', 'Desktop app', null, 120, 14],
	[41, 'Tray icon', 'Desktop app', null, 96, 4],
	[45, 'Update feed', 'Desktop app', 'Auto-update', 70, 10],
	[46, 'Code signing', 'Desktop app', 'Auto-update', 28, null, 'review'],
	[47, 'Tell open clients a new version is out', 'Desktop app', 'Auto-update', 9, null, 'needs']
];

/** Files each invented ticket's session changed, so the demo has relations to show (S-86). */
const FILES: Record<number, string[]> = {
	1: ['src/auth/login.svelte', 'src/auth/validate.ts'],
	2: ['src/ws/limit.ts', 'src/ws/events.ts'],
	3: ['src/profile/avatar.ts'],
	4: ['src/theme/tokens.css', 'src/theme/dark.css'],
	5: ['e2e/cold-start.spec.ts', 'src/ws/events.ts'],
	10: ['src/messages/list.svelte', 'src/messages/store.ts'],
	11: ['src/messages/item.svelte', 'src/messages/store.ts'],
	12: ['src/messages/reactions.svelte', 'src/messages/item.svelte'],
	13: ['src/messages/typing.ts', 'src/ws/events.ts'],
	14: ['src/messages/unread.ts', 'src/messages/store.ts', 'src/sidebar/presence.svelte'],
	20: ['src/voice/room.ts', 'src/voice/join.svelte', 'src/rtc/connection.ts', 'src/rtc/tracks.ts'],
	21: ['src/voice/controls.svelte', 'src/voice/room.ts'],
	22: ['src/sidebar/presence.svelte', 'src/voice/room.ts'],
	23: ['src/voice/devices.ts', 'src/settings/audio.svelte'],
	24: ['src/rtc/connection.ts', 'src/rtc/reconnect.ts', 'src/voice/room.ts'],
	25: ['src/voice/echo-test.svelte', 'src/voice/devices.ts'],
	30: ['src/screen/capture.ts', 'src/rtc/connection.ts', 'src/rtc/tracks.ts'],
	31: ['src/screen/viewer.svelte', 'src/screen/layout.ts'],
	32: ['src/screen/bitrate.ts', 'src/rtc/tracks.ts'],
	34: ['src/screen/popout.ts', 'src/screen/viewer.svelte'],
	40: ['desktop/main.ts', 'desktop/preload.ts'],
	41: ['desktop/tray.ts', 'desktop/main.ts'],
	45: ['desktop/update/feed.ts', 'desktop/main.ts'],
	46: ['desktop/update/sign.ts', 'build/notarize.js'],
	47: ['desktop/update/notify.ts', 'desktop/update/feed.ts', 'src/app/banner.svelte']
};
/** Tickets whose session began on another ticket's branch: screen share grew out of voice. */
const CAME_FROM: Record<number, number> = { 30: 20, 47: 45 };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Invented data, shaped like the real sources, so the screen works with nothing configured (S-63). */
export function demoSnapshot(now: number): Snapshot {
	const iso = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();
	const issues: Issue[] = [];
	const prs: PullRequest[] = [];
	const sessions: Session[] = [];

	for (const [n, title, project, milestone, ago, took, extra] of ROWS) {
		const id = `DEMO-${n}`;
		const branch = `demo-${n}-${slug(title)}`;
		const done = took !== null;
		issues.push({
			id,
			title,
			url: `https://linear.app/demo/issue/${id}`,
			createdAt: iso(ago + 20),
			startedAt: iso(ago),
			completedAt: done ? iso(ago - took) : null,
			canceledAt: null,
			stateName: done ? 'Done' : extra === 'review' ? 'In Review' : 'In Progress',
			stateType: done ? 'completed' : 'started',
			branchName: branch,
			project: { id: slug(project), name: project },
			milestone: milestone ? { id: slug(`${project} ${milestone}`), name: milestone } : null
		});
		if (done || extra === 'review') {
			prs.push({
				repo: 'demo/app',
				number: 100 + n,
				title: `${id} ${title}`,
				url: `https://github.com/demo/app/pull/${100 + n}`,
				branch,
				state: done ? 'merged' : 'open',
				createdAt: iso(ago - 1)
			});
		}
		if (done && FILES[n]) {
			// what finding past sessions on disk gives a real timeline (S-83)
			sessions.push({
				id: `demo-session-${n}`,
				name: `${id} ${slug(title).slice(0, 18)}`,
				cwd: `/home/you/app/.claude/worktrees/${branch}`,
				kind: 'background',
				startedAt: iso(ago),
				state: 'done',
				waitingFor: null,
				gone: true,
				branch
			});
		}
		if (extra && extra !== 'review') {
			sessions.push({
				id: `demo-session-${n}`,
				name: `${id} ${slug(title).slice(0, 18)}`,
				cwd: `/home/you/app/.claude/worktrees/${branch}`,
				kind: 'background',
				startedAt: iso(ago),
				state: extra,
				waitingFor: extra === 'needs' ? (n === 47 ? 'permission prompt' : 'input needed') : null,
				gone: false
			});
		}
	}

	sessions.push({
		id: 'demo-session-loose',
		name: 'try-bun-runtime',
		cwd: '/home/you/scratch',
		kind: 'interactive',
		startedAt: iso(20),
		state: 'open',
		waitingFor: null,
		gone: false
	});

	return { fetchedAt: new Date(now).toISOString(), demo: true, warnings: [], issues, prs, sessions };
}

/** What reading the invented sessions' transcripts would have given (S-86, S-88). */
export function demoDigests(now: number): Record<string, Digest> {
	const branchOf = new Map(ROWS.map(([n, title]) => [n, `demo-${n}-${slug(title)}`]));
	const minute = (hoursAgo: number) => Math.round((now - hoursAgo * HOUR) / 60_000);
	const out: Record<string, Digest> = {};
	for (const [n, , , , ago, took] of ROWS) {
		if (!FILES[n]) continue;
		// worked in stretches of fifty minutes with a break after each, until it was done or until now
		const hours = Math.min(took ?? ago, ago, 9);
		const spans: [number, number][] = [];
		for (let h = 0; h + 0.2 < hours; h += 1.25) spans.push([minute(ago - h), minute(ago - Math.min(hours, h + 50 / 60))]);
		const minutes = spans.reduce((sum, [from, to]) => sum + to - from, 0);
		const from = CAME_FROM[n];
		out[`demo-session-${n}`] = {
			stamp: 'demo',
			readAt: now,
			root: '/home/you/app',
			files: FILES[n].map((path, i) => ({ path, edits: 6 - Math.min(i, 4) })),
			branches: [...(from ? [branchOf.get(from)!] : []), branchOf.get(n)!],
			spans,
			minutes,
			added: minutes * 4,
			removed: minutes,
			tokens: minutes * 9000,
			costUSD: Math.round(minutes * 11) / 100
		};
	}
	return out;
}
