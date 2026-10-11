<script lang="ts">
	import { dayLabel } from './layout';
	import Mark from './Mark.svelte';
	import type { GraphNode, NodeState, SessionNote } from './model';
	import { contextPack, resumeCommand } from './pack';

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
	}
	let { nodes, focus, onfocus, unfinished, onshow, onclear }: Props = $props();

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
	let notes = $state<Record<string, SessionNote>>({});
	let expanded = $state<Record<string, boolean>>({});
	const settled = new Set<string>();
	$effect(() => {
		for (const s of focus?.sessions ?? []) {
			if (settled.has(s.id)) continue;
			if (s.gone) settled.add(s.id); // an ended session's transcript no longer changes
			fetch(`/api/session/${encodeURIComponent(s.id)}`)
				.then((r) => (r.ok ? r.json() : null))
				.then((note: SessionNote | null) => {
					if (note) notes[s.id] = note;
				})
				.catch(() => {});
		}
	});

	// S-57, S-59: which copy button was pressed last, so it can say so for a moment
	let copied = $state<string | null>(null);
	async function copy(key: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = key;
		} catch {
			copied = `${key}:failed`; // no clipboard here: the text is shown instead, to copy by hand
		}
		setTimeout(() => (copied = null), copied?.endsWith(':failed') ? 20_000 : 1600);
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

<aside id="ticket-panel" tabindex="-1" aria-label="Selected ticket" class="outline-none box-border w-full flex-none overflow-y-auto border-t border-edge px-6 pt-5 pb-7 md:w-80 md:border-t-0 md:border-l">
	{#if focus}
		{#if nodes.length > 1}
			<button type="button" class="mb-3 -ml-2 min-h-11 rounded px-2 text-muted hover:text-ink" onclick={() => onfocus(null)}>
				← all {nodes.length}
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
		</dl>

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
						<div class="font-mono text-xs break-all text-muted">{s.cwd}</div>
						{#if s.branch}
							<div class="font-mono text-xs break-all text-muted">on {s.branch}</div>
						{/if}
						{#if note}
							{#if note.firstPrompt && note.firstPrompt !== note.lastPrompt}
								{@render said('Started with', note.firstPrompt, false)}
							{/if}
							{#if note.lastPrompt}
								{@render said('You last asked', note.lastPrompt, false)}
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
				class="mt-2.5 inline-flex min-h-11 items-center rounded-md border border-rail px-3.5 hover:bg-edge"
				onclick={() => copy(`pack:${focus.id}`, contextPack(focus, notes))}
			>
				{copied === `pack:${focus.id}` ? 'Copied' : 'Copy context for a new session'}
			</button>
			{#if copied === `pack:${focus.id}:failed`}
				<textarea id="context-pack" readonly rows="8" class="mt-2 block w-full rounded-md border border-rail bg-ground p-2 font-mono text-xs text-muted">{contextPack(focus, notes)}</textarea>
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
	{:else if unfinished.length}
		<!-- S-19: nothing selected, so answer the question the app is named after -->
		<h2 class="text-xl font-semibold">Unfinished <span class="font-normal text-muted">{unfinished.length}</span></h2>
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
