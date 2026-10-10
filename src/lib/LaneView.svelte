<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { LANE_H, LINE_Y, tOf, xOf, type Cluster, type Layout } from './layout';
	import Mark from './Mark.svelte';

	interface Props {
		view: Layout;
		pxPerDay: number;
		/** ids of the nodes shown in the side panel */
		picked: string[];
		onpick: (cluster: Cluster) => void;
	}
	let { view, pxPerDay = $bindable(), picked, onpick }: Props = $props();

	const MIN_ZOOM = 12;
	const MAX_ZOOM = 1600;
	const STATE_WORDS = { needs: 'needs you', failed: 'failed', working: 'working', review: 'ready for review', open: 'open', done: 'done' };

	let viewport: HTMLElement;
	let dragging = $state(false);

	/** Zooms the time axis, keeping the time under `clientX` (or the middle) where it is. */
	async function zoom(factor: number, clientX?: number) {
		const rect = viewport.getBoundingClientRect();
		const offset = clientX === undefined ? rect.width / 2 : clientX - rect.left;
		const t = tOf(viewport.scrollLeft + offset, view.t0, pxPerDay);
		const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pxPerDay * factor));
		pxPerDay = next;
		await tick();
		viewport.scrollLeft = xOf(t, view.t0, next) - offset;
	}

	onMount(() => {
		// S-14: open at now, with a little room to its right.
		viewport.scrollLeft = view.nowX - viewport.clientWidth + 180;

		const onWheel = (e: WheelEvent) => {
			if (!e.ctrlKey && !e.metaKey) return;
			e.preventDefault();
			zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX);
		};
		viewport.addEventListener('wheel', onWheel, { passive: false });
		return () => viewport.removeEventListener('wheel', onWheel);
	});

	function panStart(e: PointerEvent) {
		if (e.pointerType !== 'mouse' || e.button !== 0) return;
		if ((e.target as Element).closest('button')) return;
		dragging = true;
	}
	function panMove(e: PointerEvent) {
		if (!dragging) return;
		viewport.scrollLeft -= e.movementX;
		viewport.scrollTop -= e.movementY;
	}

	const isPicked = (c: Cluster) => c.nodes.some((n) => picked.includes(n.id));
	const describe = (c: Cluster) =>
		c.nodes.length === 1
			? `${c.nodes[0].label}: ${c.nodes[0].title}, ${STATE_WORDS[c.state]}`
			: `${c.label}, most urgent: ${STATE_WORDS[c.state]}`;
</script>

<div class="relative min-h-80 min-w-0 flex-1">
	<section
		bind:this={viewport}
		aria-label="Timeline. Drag or scroll to pan; ctrl or cmd plus wheel to zoom."
		class="absolute inset-0 overflow-auto"
		class:cursor-grab={!dragging}
		class:cursor-grabbing={dragging}
		onpointerdown={panStart}
		onpointermove={panMove}
		onpointerup={() => (dragging = false)}
		onpointerleave={() => (dragging = false)}
	>
		<div class="relative min-h-full select-none" style="width: {view.width}px; height: {view.height}px">
			{#each view.ticks as t (t.x)}
				<div aria-hidden="true" class="absolute inset-y-0 w-px bg-grid" style="left: {t.x}px"></div>
			{/each}
			<div aria-hidden="true" class="absolute inset-y-0 border-l border-dashed border-faint" style="left: {view.nowX}px"></div>

			{#each view.connectors as c (c.left + ':' + c.top + ':' + c.height)}
				<div
					aria-hidden="true"
					class="pointer-events-none absolute box-border rounded-bl-[14px] border-b-2 border-l-2 border-rail"
					style="left: {c.left - 1}px; top: {c.top}px; width: {c.width + 1}px; height: {c.height + 1}px"
				></div>
			{/each}

			<div class="sticky top-0 z-30 box-border h-10 border-b border-edge bg-ground font-mono text-xs text-muted">
				{#each view.ticks as t (t.x)}
					{#if t.label}
						<span class="absolute top-3 whitespace-nowrap" style="left: {t.x + 6}px">{t.label}</span>
					{/if}
				{/each}
				<span class="absolute top-3 whitespace-nowrap text-ink" style="left: {view.nowX + 6}px">{view.nowLabel}</span>
			</div>

			{#each view.lanes as box (box.lane.id)}
				<div class="relative z-10" style="height: {LANE_H}px">
					<div
						aria-hidden="true"
						class="absolute h-0.5 {box.lane.closed ? 'bg-rail-dim' : 'bg-rail'}"
						style="top: {LINE_Y - 1}px; left: {box.lineLeft}px; width: {Math.max(0, box.lineRight - box.lineLeft)}px"
					></div>
					<div class="flex h-[30px] items-end">
						<div class="flex-none" style="width: {Math.max(0, box.lineLeft - 9)}px"></div>
						<div class="sticky left-4 z-20 flex flex-none items-baseline gap-2.5 bg-ground py-0.5 pr-3 whitespace-nowrap">
							<span class="text-[15px] font-medium {box.lane.closed ? 'text-muted' : ''}">{box.lane.name}</span>
							{#if box.lane.project}
								<span class="font-mono text-xs text-muted">{box.lane.project}</span>
							{/if}
							<span class="text-xs {box.urgent ? 'text-needs' : 'text-muted'}">{box.status}</span>
						</div>
					</div>

					{#each box.clusters as c (c.key)}
						<button
							type="button"
							aria-label={describe(c)}
							class="absolute flex h-11 min-w-11 -translate-x-1/2 items-center justify-center"
							style="left: {c.x}px; top: {LINE_Y - 22}px"
							onclick={() => onpick(c)}
						>
							<Mark state={c.state} stage={c.stage} count={c.nodes.length} selected={isPicked(c)} />
						</button>
						<div
							aria-hidden="true"
							class="s-{c.state} pointer-events-none absolute -translate-x-1/2 font-mono text-[11px] whitespace-nowrap"
							style="left: {c.x}px; top: {LINE_Y + 22}px; color: var(--tone)"
						>
							{c.label}
						</div>
					{/each}
				</div>
			{/each}
		</div>
	</section>

	<div class="absolute right-4 bottom-4 z-40 flex overflow-hidden rounded-md border border-rail bg-ground">
		<button type="button" aria-label="Zoom out" class="h-11 w-11 text-lg hover:bg-edge" onclick={() => zoom(1 / 1.5)}>−</button>
		<button type="button" aria-label="Zoom in" class="h-11 w-11 border-l border-rail text-lg hover:bg-edge" onclick={() => zoom(1.5)}>+</button>
	</div>
</div>
