<script lang="ts">
	import type { Day } from './days';
	import { DAY, dayLabel } from './layout';
	import Mark from './Mark.svelte';
	import { onMount } from 'svelte';
	import type { Action, GraphNode, NodeState, Relation, SessionNote } from './model';
	import { contextPack, resumeCommand } from './pack';
	import { reason } from './relations';

	interface Props {
		/** the nodes of the cluster that was clicked */
		nodes: GraphNode[];
		/** the one node shown in detail, if any */
		focus: GraphNode | null;
		onfocus: (id: string | null) => void;
		/** what is not finished, shown when nothing is selected (S-19) */
		unfinished: GraphNode[];
		onshow: (node: GraphNode) => void;
		/** back to nothing selected */
		onclear: () => void;
		/** the last things each running session did, by session id (S-85) */
		live?: Record<string, Action[]>;
		/** what the open ticket is related to, strongest first (S-86) */
		related?: { node: GraphNode; relation: Relation }[];
		/** the day, or week, that was picked on the axis (S-89) */
		day?: Day | null;
		/** today, for the line above the unfinished list */
		today?: Day | null;
		/** show a day (its start), or let go of the one shown (null) */
		onday?: (from: number | null) => void;
	}
	let { nodes, focus, onfocus, unfinished, onshow, onclear, live = {}, related = [], day = null, today = null, onday }: Props = $props();

	/** The end of a path: the file and the folder it is in, which is usually enough to know it. */
	const shortPath = (path: string) => path.split(/[\\/]/).slice(-2).join('/');
	/** How many tickets of a day are listed before "show all". */
	const DAY_LISTED = 12;
	let allOfDay = $state(false);
	/** A day by its date; anything longer by the date it starts on. */
	const dayTitle = (d: Day) => (d.to - d.from < DAY * 1.5 ? dayLabel(d.from) : `Week of ${dayLabel(d.from)}`);

	// S-85: a clock, so "12 s ago" keeps counting between events
	let clock = $state(Date.now());
	onMount(() => {
		const timer = setInterval(() => (clock = Date.now()), 5000);
		return () => clearInterval(timer);
	});

	/** How a line of the live feed reads: what you typed and what Claude said are told apart from what it did. */
	const feed = (a: Action) => (a.tool === 'you' ? `You: ${a.text}` : a.tool === 'says' ? `“${a.text}”` : a.text);
	function since(iso: string | null): string {
		if (!iso) return '';
		const seconds = Math.max(0, Math.round((clock - Date.parse(iso)) / 1000));
		if (seconds < 10) return 'now';
		if (seconds < 90) return `${seconds} s`;
		if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
		return `${Math.round(seconds / 3600)} h`;
	}
	/** The latest thing a ticket's running sessions did, for the list of unfinished work. */
	function doing(node: GraphNode): Action | undefined {
		return node.sessions
			.filter((s) => !s.gone)
			.flatMap((s) => live[s.id]?.at(-1) ?? [])
			.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
			.at(-1);
	}
	/** How many of a session's latest actions the panel shows. */
	const FEED_SHOWN = 6;

	/** At most this many unfinished tickets are listed; the rest are counted. */
	const LISTED = 10;

	const STATE_LABEL: Record<NodeState, string> = {
		needs: 'Needs you',
		failed: 'Failed',
		working: 'Working',
		review: 'Ready for review',
		open: 'Open',
		done: 'Done'
	};
	const SESSION_LABEL = { needs: 'waiting for you', working: 'working', failed: 'failed', open: 'idle', done: 'finished' };

	// S-55: what each session of the open ticket was doing, read from its transcript on demand.
	// For each session: its note, null when its transcript is gone, nothing yet while it is being read.
	let notes = $state<Record<string, SessionNote | null>>({});
	let expanded = $state<Record<string, boolean>>({});
	const settled = new Set<string>();
	/** Sessions whose note has been asked for and answered, one way or the other. */
	let answered = $state<Record<string, true>>({});
	$effect(() => {
		for (const s of focus?.sessions ?? []) {
			if (settled.has(s.id)) continue;
			fetch(`/api/session/${encodeURIComponent(s.id)}`)
				.then((r) => {
					if (r.ok) return r.json() as Promise<SessionNote>;
					if (r.status === 404) return null;
					throw new Error(`HTTP ${r.status}`);
				})
				.then((note) => {
					notes[s.id] = note;
					// an ended session's transcript no longer changes; a failed read is tried again next time
					if (s.gone) settled.add(s.id);
				})
				.catch(() => {})
				.finally(() => (answered[s.id] = true));
		}
	});
	/** The context for a new session is only complete once every session's note is in (S-57). */
	const reading = $derived(focus?.sessions.some((s) => !answered[s.id]) ?? false);

	// S-57, S-59: which copy button was pressed last, so it can say so for a moment
	let copied = $state<string | null>(null);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;
	async function copy(key: string, text: string) {
		clearTimeout(copiedTimer); // an earlier press must not wipe what this one is about to show
		try {
			await navigator.clipboard.writeText(text);
			copied = key;
		} catch {
			copied = `${key}:failed`; // no clipboard here: the text is shown instead, to copy by hand
		}
		copiedTimer = setTimeout(() => (copied = null), copied?.endsWith(':failed') ? 20_000 : 1600);
	}

	/** How long ago, in the roughest unit that says enough. */
	function ago(iso: string): string {
		const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
		if (hours < 1) return 'less than an hour ago';
		if (hours < 24) return `${Math.floor(hours)} h ago`;
		const days = Math.floor(hours / 24);
		return days === 1 ? 'yesterday' : `${days} days ago`;
	}

	/** How long something has been going, as short as it can be said. */
	function age(iso: string): string {
		const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
		return hours < 1 ? 'under 1 h' : hours < 24 ? `${Math.floor(hours)} h` : `${Math.floor(hours / 24)} d`;
	}

	/** A big number the short way: 1,996 stays, 570,329 is 570k, 1,324,765 is 1.3M. */
	function compact(n: number): string {
		if (n < 10_000) return n.toLocaleString('en');
		if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
		return `${(n / 1_000_000).toFixed(1)}M`;
	}
	function duration(minutes: number): string {
		return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
	}
	const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
	/** How many of a session's files are listed before "show all". */
	const FILES_LISTED = 5;
	let allFiles = $state<Record<string, boolean>>({});
	let allPrompts = $state<Record<string, boolean>>({});

	function when(iso: string | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
		return `${dayLabel(d.getTime())}, ${hhmm}`;
	}
</script>

{#snippet heading(text: string)}
	<h3 class="mt-5 font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">{text}</h3>
{/snippet}

{#snippet said(label: string, text: string, full: boolean)}
	<div class="mt-2.5 font-mono text-[11px] tracking-[0.06em] text-muted uppercase">{label}</div>
	<p class="mt-0.5 border-l-2 border-rail pl-2.5 text-[13px] leading-snug break-words whitespace-pre-line {full ? '' : 'line-clamp-5'}">{text}</p>
{/snippet}

<!-- focus is put here when a ticket or a day is opened; it is a place to read on from, not a control, so it draws no ring -->
<aside id="ticket-panel" tabindex="-1" aria-label="Selected ticket" style="outline: none" class="box-border w-full flex-none overflow-y-auto border-t border-edge px-6 pt-5 pb-7 md:w-80 md:border-t-0 md:border-l">
	{#if focus}
		{#if nodes.length > 1}
			<button type="button" class="mb-3 -ml-2 min-h-11 rounded px-2 text-muted hover:text-ink" onclick={() => onfocus(null)}>
				← all {nodes.length}
			</button>
		{:else if day}
			<button type="button" class="mb-3 -ml-2 min-h-11 rounded px-2 text-muted hover:text-ink" onclick={onclear}>
				← {dayTitle(day)}
			</button>
		{:else if unfinished.length}
			<button type="button" class="mb-3 -ml-2 min-h-11 rounded px-2 text-muted hover:text-ink" onclick={onclear}>
				← unfinished
			</button>
		{/if}
		<div class="font-mono text-xs tracking-[0.08em] text-muted uppercase">
			{focus.status === null ? (focus.stage === 'pr' ? 'Pull request' : 'Session') : focus.label}
			{#if focus.status}· {focus.status}{/if}
		</div>
		<h2 class="mt-2 text-xl leading-snug font-semibold">{focus.title}</h2>
		<div class="s-{focus.state} mt-3 flex items-center gap-2.5 font-medium" style="color: var(--tone)">
			<Mark state={focus.state} stage={focus.stage} small />
			<span>{STATE_LABEL[focus.state]}</span>
		</div>

		<dl class="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
			{#if focus.startedAt}
				<dt class="text-muted">Started</dt>
				<dd>
					{when(focus.startedAt)}
					{#if focus.state !== 'done'}<span class="text-muted">· {ago(focus.startedAt)}</span>{/if}
				</dd>
			{/if}
			{#if focus.completedAt}
				<dt class="text-muted">Completed</dt>
				<dd>{when(focus.completedAt)}</dd>
			{/if}
			{#if focus.work && (focus.work.minutes || focus.work.costUSD !== null)}
				<!-- S-88: the work that went into it, over all its sessions; when is drawn on the time axis -->
				<dt class="text-muted">Worked</dt>
				<dd>
					{duration(focus.work.minutes)}
					<span class="text-muted">
						{[focus.work.sessions > 1 ? `· ${focus.work.sessions} sessions` : '', focus.work.costUSD !== null ? `· $${focus.work.costUSD.toFixed(2)}` : ''].filter(Boolean).join(' ')}
					</span>
				</dd>
			{/if}
		</dl>

		{#if related.length}
			<!-- S-86: the tickets the lines on the timeline go to, and why -->
			{@render heading('Related')}
			<ul class="mt-1.5 -ml-2">
				{#each related as r (r.node.id)}
					<li>
						<button type="button" class="flex min-h-11 w-full items-start gap-3 rounded px-2 py-1.5 text-left hover:bg-edge" onclick={() => onshow(r.node)}>
							<span class="mt-1"><Mark state={r.node.state} stage={r.node.stage} small /></span>
							<span class="min-w-0 flex-1">
								<span class="block truncate leading-snug" title={r.node.title}>
									{#if r.node.status !== null}<span class="font-mono text-xs text-muted">{r.node.label}</span>{/if}
									{r.node.title}
								</span>
								<span class="block text-xs text-muted">{reason(r.relation, focus.id)}</span>
								{#if r.relation.files.length}
									<span class="block truncate font-mono text-[11px] text-muted" title={r.relation.files.join('\n')}>
										{r.relation.files.map(shortPath).join(', ')}{r.relation.shared > r.relation.files.length ? ', …' : ''}
									</span>
								{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}

		{#if focus.sessions.length}
			{@render heading(focus.sessions.length === 1 ? 'Session' : 'Sessions')}
			<ul class="mt-2 space-y-3">
				{#each focus.sessions as s (s.id)}
					{@const note = notes[s.id]}
					<li>
						<div class="font-medium">{s.name ?? 'unnamed session'}</div>
						<div class="s-{s.state}" style="color: var(--tone)">
							{SESSION_LABEL[s.state]}{#if s.waitingFor}: {s.waitingFor}{/if}{#if s.gone}, no longer listed{/if}
						</div>
						{#if !s.gone && live[s.id]?.length}
							<!-- S-85: what it is doing, newest first; filled by the stream as it happens -->
							<div class="mt-2 font-mono text-[11px] tracking-[0.06em] text-muted uppercase">Right now</div>
							<ol class="mt-0.5 flex flex-col gap-0.5 font-mono text-xs" aria-live="off">
								{#each live[s.id].slice(-FEED_SHOWN).reverse() as a, i (`${a.at}:${a.text}:${i}`)}
									<li class="flex items-baseline gap-2 {i === 0 ? 's-working' : 'text-muted'}" style={i === 0 ? 'color: var(--tone)' : ''}>
										<span class="min-w-0 flex-1 truncate" title={feed(a)}>{feed(a)}</span>
										<span class="flex-none text-muted">{since(a.at)}</span>
									</li>
								{/each}
							</ol>
						{/if}
						<div class="mt-1.5 font-mono text-xs break-all text-muted">{s.cwd}</div>
						{#if s.branch}
							<div class="font-mono text-xs break-all text-muted">on {s.branch}</div>
						{/if}
						{#if note?.story && note.story.toolCalls}
							<!-- S-84: what the session did, from its transcript -->
							{@const story = note.story}
							<div class="mt-2.5 font-mono text-[11px] tracking-[0.06em] text-muted uppercase">What it did</div>
							<p class="mt-0.5 text-[13px] leading-snug">
								{[
									story.activeMinutes ? `${duration(story.activeMinutes)} at it` : '',
									// the prompts can be gone from a transcript that was compacted: say nothing rather than "0"
									story.promptCount ? count(story.promptCount, 'prompt') : '',
									count(story.commands, 'command'),
									story.files.length ? count(story.files.length, 'file') : ''
								]
									.filter(Boolean)
									.join(' · ')}
							</p>
							<p class="text-[13px] leading-snug text-muted">
								{[
									story.added || story.removed ? `about +${compact(story.added)} −${compact(story.removed)} lines` : '',
									story.tokens.input + story.tokens.output ? `${compact(story.tokens.input + story.tokens.output)} tokens` : '',
									story.costUSD !== null ? `$${story.costUSD.toFixed(2)}` : ''
								]
									.filter(Boolean)
									.join(' · ')}
							</p>
							{#if story.files.length}
								<ul class="mt-1.5 font-mono text-xs">
									{#each allFiles[s.id] ? story.files : story.files.slice(0, FILES_LISTED) as f (f.path)}
										<li class="flex items-baseline gap-2">
											<span class="min-w-0 flex-1 truncate" style="direction: rtl; text-align: left" title={f.path}><bdi>{f.path}</bdi></span>
											{#if f.created}<span class="flex-none text-review">new</span>{/if}
											<span class="flex-none text-muted">×{f.edits}</span>
										</li>
									{/each}
								</ul>
								{#if story.files.length > FILES_LISTED}
									<button type="button" class="-ml-2 min-h-9 rounded px-2 text-xs text-muted hover:text-ink" onclick={() => (allFiles[s.id] = !allFiles[s.id])}>
										{allFiles[s.id] ? 'show fewer' : `show all ${story.files.length} files`}
									</button>
								{/if}
							{/if}
						{/if}
						{#if note}
							{#if note.firstPrompt && note.firstPrompt !== note.lastPrompt}
								{@render said('Started with', note.firstPrompt, false)}
							{/if}
							{#if note.lastPrompt}
								{@render said('You last asked', note.lastPrompt, false)}
							{/if}
							{#if note.story && note.story.promptCount > 2}
								<button type="button" aria-expanded={!!allPrompts[s.id]} class="-ml-2 min-h-9 rounded px-2 text-xs text-muted hover:text-ink" onclick={() => (allPrompts[s.id] = !allPrompts[s.id])}>
									{allPrompts[s.id] ? 'hide the prompts in between' : `show all ${note.story.promptCount} prompts`}
								</button>
								{#if allPrompts[s.id]}
									<ol class="mt-1 flex flex-col gap-2 border-l-2 border-rail pl-2.5">
										{#each note.story.prompts as p, i (i)}
											<li class="text-[13px] leading-snug">
												<span class="block font-mono text-[11px] text-muted">{when(p.at)}</span>
												<span class="break-words whitespace-pre-line">{p.text}</span>
											</li>
										{/each}
									</ol>
									{#if note.story.promptCount > note.story.prompts.length}
										<p class="mt-1 text-xs text-muted">The first and the latest {note.story.prompts.length - 1} of {note.story.promptCount}.</p>
									{/if}
								{/if}
							{/if}
							{#if note.lastReply}
								{@render said(note.at ? `Claude last said · ${when(note.at)}` : 'Claude last said', note.lastReply, expanded[s.id])}
								{#if note.lastReply.length > 280}
									<button type="button" class="-ml-2 min-h-9 rounded px-2 text-xs text-muted hover:text-ink" onclick={() => (expanded[s.id] = !expanded[s.id])}>
										{expanded[s.id] ? 'show less' : 'show more'}
									</button>
								{/if}
							{/if}
							{#if note.prs.length}
								<div class="mt-2 text-xs text-muted">
									Opened
									{#each note.prs as p (p.url)}
										<a class="mr-1.5 text-ink underline-offset-2 hover:underline" href={p.url} target="_blank" rel="noreferrer">#{p.number}</a>
									{/each}
								</div>
							{/if}
							{@const resume = resumeCommand(s)}
							{#if resume}
								<button
									type="button"
									title={resume}
									class="mt-2.5 inline-flex min-h-9 items-center rounded-md border border-rail px-3 text-[13px] hover:bg-edge"
									onclick={() => copy(`resume:${s.id}`, resume)}
								>
									{copied === `resume:${s.id}` ? 'Copied' : 'Copy the command to resume it'}
								</button>
								{#if copied === `resume:${s.id}:failed`}
									<code class="mt-1.5 block font-mono text-xs break-all text-muted select-all">{resume}</code>
								{/if}
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if focus.prs.length}
			{@render heading(focus.prs.length === 1 ? 'Pull request' : 'Pull requests')}
			<ul class="mt-2 space-y-2">
				{#each focus.prs as p (p.url)}
					<li>
						<a class="font-medium underline-offset-2 hover:underline" href={p.url} target="_blank" rel="noreferrer">#{p.number} {p.title}</a>
						<div class="text-muted">{p.state} · {p.repo}</div>
					</li>
				{/each}
			</ul>
		{/if}

		{#if focus.url && focus.status !== null}
			{@render heading('Linked')}
			<a
				class="mt-2.5 inline-flex min-h-11 items-center rounded-md border border-rail px-3.5 hover:bg-edge"
				href={focus.url}
				target="_blank"
				rel="noreferrer">Open in Linear</a
			>
		{/if}

		{#if focus.state !== 'done'}
			<!-- S-57: what wtfwid knows about this ticket, as a prompt for a new session -->
			{@render heading('Pick it up again')}
			<button
				type="button"
				class="mt-2.5 inline-flex min-h-11 items-center rounded-md border border-rail px-3.5 hover:bg-edge disabled:text-muted disabled:hover:bg-transparent"
				disabled={reading}
				onclick={() => copy(`pack:${focus.id}`, contextPack(focus, notes, related))}
			>
				{reading ? 'Reading its sessions…' : copied === `pack:${focus.id}` ? 'Copied' : 'Copy context for a new session'}
			</button>
			{#if copied === `pack:${focus.id}:failed`}
				<textarea id="context-pack" readonly rows="8" class="mt-2 block w-full rounded-md border border-rail bg-ground p-2 font-mono text-xs text-muted">{contextPack(focus, notes, related)}</textarea>
			{/if}
		{/if}
	{:else if nodes.length}
		<h2 class="text-xl font-semibold">{nodes.length} at this spot</h2>
		<p class="mt-1 text-muted">Too close together to draw apart at this zoom.</p>
		<ul class="mt-3 -ml-2">
			{#each nodes as n (n.id)}
				<li>
					<button type="button" class="flex min-h-11 w-full items-center gap-3 rounded px-2 py-1.5 text-left hover:bg-edge" onclick={() => onfocus(n.id)}>
						<Mark state={n.state} stage={n.stage} small />
						<span class="min-w-0">
							<span class="block font-mono text-xs text-muted">{n.label}</span>
							<span class="block">{n.title}</span>
						</span>
					</button>
				</li>
			{/each}
		</ul>
	{:else if day}
		<!-- S-89: what happened in the day or week that was clicked on the axis -->
		{@const most = Math.max(1, ...day.items.map((i) => i.minutes))}
		{@const began = day.items.filter((i) => i.started && i.node.status !== null).length}
		{@const ended = day.items.filter((i) => i.completed).length}
		<button type="button" class="mb-3 -ml-2 min-h-11 rounded px-2 text-muted hover:text-ink" onclick={() => onday?.(null)}>
			← {unfinished.length ? 'unfinished' : 'back'}
		</button>
		<div class="font-mono text-xs tracking-[0.08em] text-muted uppercase">{dayTitle(day)}</div>
		{#if day.minutes}
			<h2 class="mt-2 text-xl leading-snug font-semibold">{duration(day.minutes)} <span class="font-normal text-muted">of session time</span></h2>
			<p class="mt-1 text-[13px] text-muted">
				{[
					day.busy < day.minutes ? `something was running for ${duration(day.busy)}` : '',
					day.costUSD !== null ? `about $${day.costUSD.toFixed(2)}` : ''
				]
					.filter(Boolean)
					.join(' · ')}
			</p>
		{:else if began || ended}
			<!-- no session was read for that day: what Linear says happened is the answer then -->
			<h2 class="mt-2 text-xl leading-snug font-semibold">{[began ? `${began} started` : '', ended ? `${ended} completed` : ''].filter(Boolean).join(' · ')}</h2>
			<p class="mt-1 text-[13px] text-muted">No session that wtfwid has read was at work then.</p>
		{:else}
			<h2 class="mt-2 text-xl leading-snug font-semibold">{day.items.length ? 'No session time' : 'Nothing happened'}</h2>
		{/if}
		{#if day.minutes && (began || ended)}
			<p class="mt-1 text-[13px] text-muted">{[began ? `${began} started` : '', ended ? `${ended} completed` : ''].filter(Boolean).join(' · ')}</p>
		{/if}
		<ul class="mt-3 -ml-2">
			{#each allOfDay ? day.items : day.items.slice(0, DAY_LISTED) as item (item.node.id)}
				{@const n = item.node}
				<li>
					<button type="button" class="s-{n.state} flex min-h-11 w-full items-start gap-3 rounded px-2 py-2 text-left hover:bg-edge" onclick={() => onshow(n)}>
						<span class="mt-1"><Mark state={n.state} stage={n.stage} small /></span>
						<span class="min-w-0 flex-1">
							<span class="flex items-baseline justify-between gap-3 font-mono text-xs">
								<span class="flex flex-wrap gap-x-2 text-muted">
									<span>{n.status === null ? (n.stage === 'pr' ? 'Pull request' : 'Session') : n.label}</span>
									{#if item.started}<span>started</span>{/if}
									{#if item.completed}<span>completed</span>{/if}
								</span>
								<span class="flex-none">{item.minutes ? duration(item.minutes) : ''}</span>
							</span>
							<span class="line-clamp-2 leading-snug">{n.title}</span>
							{#if item.minutes}
								<!-- how much of the day's work this was, next to the others -->
								<span class="mt-1.5 block h-1 rounded-sm" style="width: {Math.max(2, (100 * item.minutes) / most)}%; background: var(--tone)"></span>
							{/if}
						</span>
					</button>
				</li>
			{/each}
		</ul>
		{#if day.items.length > DAY_LISTED}
			<button type="button" class="-ml-2 min-h-9 rounded px-2 text-xs text-muted hover:text-ink" onclick={() => (allOfDay = !allOfDay)}>
				{allOfDay ? 'show fewer' : `show all ${day.items.length}`}
			</button>
		{/if}
	{:else if unfinished.length}
		<!-- S-19: nothing selected, so answer the question the app is named after -->
		<h2 class="text-xl font-semibold">Unfinished <span class="font-normal text-muted">{unfinished.length}</span></h2>
		{#if today?.minutes}
			<!-- S-89: today in one line; it opens the day -->
			<button type="button" class="mt-1 -ml-2 min-h-9 rounded px-2 text-left text-[13px] text-muted hover:bg-edge hover:text-ink" onclick={() => onday?.(today.from)}>
				Today: {duration(today.minutes)} on {count(today.items.filter((i) => i.minutes).length, 'ticket')} →
			</button>
		{/if}
		<ul class="mt-3 -ml-2">
			{#each unfinished.slice(0, LISTED) as n (n.id)}
				<li>
					<button type="button" class="s-{n.state} flex min-h-11 w-full items-start gap-3 rounded px-2 py-2 text-left hover:bg-edge" onclick={() => onshow(n)}>
						<span class="mt-1"><Mark state={n.state} stage={n.stage} small /></span>
						<span class="min-w-0 flex-1">
							<span class="flex items-baseline justify-between gap-3 font-mono text-xs">
								<span style="color: var(--tone)">{n.status === null ? STATE_LABEL[n.state] : `${n.label} · ${STATE_LABEL[n.state]}`}</span>
								<span class="flex-none text-muted">{age(n.at)}</span>
							</span>
							<span class="line-clamp-2 leading-snug">{n.title}</span>
							{#if doing(n)}
								{@const a = doing(n)!}
								<span class="mt-0.5 flex items-baseline gap-2 font-mono text-[11px] text-working">
									<span class="min-w-0 flex-1 truncate">{feed(a)}</span>
									<span class="flex-none text-muted">{since(a.at)}</span>
								</span>
							{/if}
						</span>
					</button>
				</li>
			{/each}
		</ul>
		{#if unfinished.length > LISTED}
			<p class="mt-1 text-xs text-muted">and {unfinished.length - LISTED} more, further down the same order.</p>
		{/if}
	{:else}
		<p class="text-muted">Nothing is left unfinished. Click a node to see the ticket, its session and its pull request.</p>
	{/if}
</aside>
