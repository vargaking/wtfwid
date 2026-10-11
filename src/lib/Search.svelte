<script lang="ts">
	import Mark from './Mark.svelte';
	import type { Lane } from './model';
	import { search, type Hit } from './search';

	interface Props {
		lanes: Lane[];
		onchoose: (hit: Hit) => void;
	}
	let { lanes, onchoose }: Props = $props();

	let query = $state('');
	let active = $state(0);
	let open = $state(false);
	let input: HTMLInputElement;

	const hits = $derived(search(lanes, query));

	function choose(hit: Hit | undefined) {
		if (!hit) return;
		onchoose(hit);
		query = '';
		open = false;
		input.blur();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (hits.length) active = (active + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
		} else if (e.key === 'Enter') {
			choose(hits[active]);
		} else if (e.key === 'Escape') {
			query = '';
			input.blur();
		}
	}

	// "/" from anywhere on the page starts a search, unless something is being typed already
	function onwindowkey(e: KeyboardEvent) {
		if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
		const el = document.activeElement;
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
		e.preventDefault();
		input.focus();
	}
</script>

<svelte:window onkeydown={onwindowkey} />

<div class="relative">
	<input
		bind:this={input}
		bind:value={query}
		id="find-ticket"
		type="search"
		role="combobox"
		autocomplete="off"
		spellcheck="false"
		aria-label="Find a ticket by ID or title"
		aria-expanded={open && hits.length > 0}
		aria-controls="find-ticket-results"
		aria-activedescendant={open && hits.length ? `find-hit-${active}` : undefined}
		placeholder="Find a ticket   /"
		class="h-11 w-48 rounded-md border border-rail bg-ground px-3 text-sm text-ink placeholder:text-muted focus:border-muted focus:outline-none"
		oninput={() => {
			active = 0;
			open = true;
		}}
		onfocus={() => (open = true)}
		onblur={() => (open = false)}
		{onkeydown}
	/>
	{#if open && query.trim()}
		<ul id="find-ticket-results" role="listbox" class="absolute right-0 z-50 mt-1 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-rail bg-ground py-1 shadow-lg shadow-black/40">
			{#each hits as hit, i (hit.node.id)}
				<!-- mousedown, not click: the input's blur would close the list before a click lands -->
				<li
					id="find-hit-{i}"
					role="option"
					aria-selected={i === active}
					class="flex cursor-pointer items-center gap-3 px-3 py-2 text-left {i === active ? 'bg-edge' : ''}"
					onmousedown={(e) => {
						e.preventDefault();
						choose(hit);
					}}
					onmouseenter={() => (active = i)}
				>
					<Mark state={hit.node.state} stage={hit.node.stage} small />
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm text-ink">{hit.node.title}</span>
						<span class="block truncate font-mono text-xs text-muted">{hit.node.status === null ? 'Unsorted' : `${hit.node.label} · ${hit.lane.name}`}</span>
					</span>
				</li>
			{:else}
				<li class="px-3 py-2 text-sm text-muted">Nothing matches.</li>
			{/each}
		</ul>
	{/if}
</div>
