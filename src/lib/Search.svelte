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
	// the list can get shorter under the highlight when the data refreshes
	const current = $derived(Math.min(active, hits.length - 1));
	const showing = $derived(open && query.trim() !== '');

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
			if (hits.length) active = (current + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
		} else if (e.key === 'Enter') {
			choose(hits[current]);
		} else if (e.key === 'Escape') {
			// only the search is let go of; the page's own Escape would also drop the open ticket
			e.stopPropagation();
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
		aria-expanded={showing && hits.length > 0}
		aria-controls="find-ticket-results"
		aria-activedescendant={showing && hits.length ? `find-hit-${current}` : undefined}
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
	{#if showing && hits.length}
		<ul id="find-ticket-results" role="listbox" aria-label="Matching tickets" class="absolute right-0 z-50 mt-1 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-rail bg-ground py-1 shadow-lg shadow-black/40">
			{#each hits as hit, i (hit.node.id)}
				<!-- mousedown, not click: the input's blur would close the list before a click lands -->
				<li
					id="find-hit-{i}"
					role="option"
					aria-selected={i === current}
					class="flex cursor-pointer items-center gap-3 px-3 py-2 text-left {i === current ? 'bg-edge' : ''}"
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
			{/each}
		</ul>
	{/if}
	<!-- always in the page, so a screen reader hears it change -->
	<div role="status" class={showing && !hits.length ? 'absolute right-0 z-50 mt-1 w-96 max-w-[calc(100vw-2rem)] rounded-md border border-rail bg-ground px-3 py-2 text-sm text-muted shadow-lg shadow-black/40' : 'sr-only'}>
		{showing ? (hits.length ? `${hits.length} ${hits.length === 1 ? 'ticket matches' : 'tickets match'}` : 'Nothing matches.') : ''}
	</div>
</div>
