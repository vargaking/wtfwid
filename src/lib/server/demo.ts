import type { Issue, PullRequest, Session, Snapshot } from '../model';

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
