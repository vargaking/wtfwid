<script lang="ts">
	import { dayLabel } from './layout';
	import Mark from './Mark.svelte';
	import type { GraphNode, NodeState } from './model';

	interface Props {
		/** the nodes of the cluster that was clicked */
		nodes: GraphNode[];
		/** the one node shown in detail, if any */
		focus: GraphNode | null;
		onfocus: (id: string | null) => void;
	}
	let { nodes, focus, onfocus }: Props = $props();

	const STATE_LABEL: Record<NodeState, string> = {
		needs: 'Needs you',
		failed: 'Failed',
		working: 'Working',
		review: 'Ready for review',
		open: 'Open',
		done: 'Done'
	};
	const SESSION_LABEL = { needs: 'waiting for you', working: 'working', failed: 'failed', open: 'idle', done: 'finished' };

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

<aside aria-label="Selected ticket" class="box-border w-full flex-none overflow-y-auto border-t border-edge px-6 pt-5 pb-7 md:w-80 md:border-t-0 md:border-l">
	{#if focus}
		{#if nodes.length > 1}
			<button type="button" class="mb-3 -ml-2 min-h-11 rounded px-2 text-muted hover:text-ink" onclick={() => onfocus(null)}>
				← all {nodes.length}
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
				<dd>{when(focus.startedAt)}</dd>
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
					<li>
						<div class="font-medium">{s.name ?? 'unnamed session'}</div>
						<div class="s-{s.state}" style="color: var(--tone)">
							{SESSION_LABEL[s.state]}{#if s.waitingFor}: {s.waitingFor}{/if}{#if s.gone}, no longer listed{/if}
						</div>
						<div class="font-mono text-xs break-all text-muted">{s.cwd}</div>
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
	{:else}
		<p class="text-muted">Click a node to see the ticket, its session and its pull request.</p>
	{/if}
</aside>
