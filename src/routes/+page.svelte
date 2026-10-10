<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import LaneView from '#lib/LaneView.svelte';
	import { layout, type Cluster } from '#lib/layout.ts';
	import Mark from '#lib/Mark.svelte';
	import type { GraphNode } from '#lib/model.ts';
	import Panel from '#lib/Panel.svelte';
	import Settings from '#lib/Settings.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let pxPerDay = $state(160);
	let hideFinished = $state(false);
	let picked = $state<string[]>([]);
	let focusId = $state<string | null>(null);
	let settingsOpen = $state(false);

	const graph = $derived(data.graph);
	const now = $derived(Date.parse(graph.fetchedAt));
	const view = $derived(layout(graph, now, pxPerDay, hideFinished));
	const byId = $derived(new Map(graph.lanes.flatMap((l) => l.nodes).map((n) => [n.id, n])));
	const pickedNodes = $derived(picked.map((id) => byId.get(id)).filter((n): n is GraphNode => !!n));
	const focus = $derived((focusId && byId.get(focusId)) || (pickedNodes.length === 1 ? pickedNodes[0] : null));
	const updated = $derived(new Date(now).toTimeString().slice(0, 5));

	function pick(cluster: Cluster) {
		picked = cluster.nodes.map((n) => n.id);
		focusId = null;
	}

	// S-65
	onMount(() => {
		const timer = setInterval(() => refreshAll(), 60_000);
		return () => clearInterval(timer);
	});
</script>

<div class="flex h-screen flex-col">
	<header class="flex flex-wrap items-center gap-x-7 gap-y-2 border-b border-edge px-6 py-3">
		<div class="flex items-baseline gap-3">
			<span class="font-mono text-lg font-semibold tracking-wide">wtfwid</span>
			<span class="text-muted">updated {updated}</span>
		</div>
		<div class="flex flex-wrap gap-x-5 gap-y-1 font-medium">
			<span class="text-needs">{view.counts.needs} {view.counts.needs === 1 ? 'needs' : 'need'} you</span>
			<span class="text-working">{view.counts.working} working</span>
			<span class="text-review">{view.counts.review} ready for review</span>
			<span class="text-failed">{view.counts.failed} failed</span>
		</div>
		<div class="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
			<span class="inline-flex items-center gap-2"><Mark state="done" stage="ticket" small />ticket</span>
			<span class="inline-flex items-center gap-2"><Mark state="done" stage="session" small />has a session</span>
			<span class="inline-flex items-center gap-2"><Mark state="done" stage="pr" small />has a pull request</span>
			{#if graph.demo}
				<span class="rounded border border-rail px-2 py-0.5 font-mono text-xs">demo data</span>
			{/if}
			<button
				type="button"
				aria-pressed={hideFinished}
				class="min-h-11 rounded-md border border-rail px-3.5 text-sm text-ink hover:bg-edge"
				onclick={() => (hideFinished = !hideFinished)}
			>
				{hideFinished ? 'Show finished' : 'Hide finished'}
			</button>
			<button
				type="button"
				class="min-h-11 rounded-md border px-3.5 text-sm hover:bg-edge {graph.demo ? 'border-needs text-needs' : 'border-rail text-ink'}"
				onclick={() => (settingsOpen = true)}
			>
				{graph.demo ? 'Connect Linear' : 'Settings'}
			</button>
		</div>
		{#if graph.warnings.length}
			<ul class="w-full text-failed" role="status">
				{#each graph.warnings as w (w)}
					<li>Could not load {w}</li>
				{/each}
			</ul>
		{/if}
	</header>

	<main class="flex min-h-0 flex-1 flex-col md:flex-row">
		<LaneView {view} bind:pxPerDay {picked} onpick={pick} />
		<Panel nodes={pickedNodes} {focus} onfocus={(id) => (focusId = id)} />
	</main>
</div>

<Settings bind:open={settingsOpen} onsaved={() => refreshAll()} />
