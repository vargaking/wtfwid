<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { ROW_H, tOf, xOf, type Cluster, type Layout } from './layout';
	import Mark from './Mark.svelte';

	interface Props {
		view: Layout;
		pxPerDay: number;
		/** ids of the nodes shown in the side panel */
		picked: string[];
		onpick: (cluster: Cluster) => void;
		/** Fold or unfold a finished lane. */
		onfold: (laneId: string) => void;
	}
	let { view, pxPerDay = $bindable(), picked, onpick, onfold }: Props = $props();

	const MIN_ZOOM = 12;
	const MAX_ZOOM = 1600;

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

	const glide = (): ScrollBehavior => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

	/** Scrolls so the node is in view, left of the middle to leave room for its label (S-15). */
	export function reveal(id: string) {
		for (const box of view.lanes) {
			const c = box.clusters.find((c) => c.nodes.some((n) => n.id === id));
			if (!c) continue;
			viewport.scrollTo({
				left: c.x - viewport.clientWidth * 0.4,
				top: box.y + box.lineY + c.row * ROW_H - viewport.clientHeight / 2,
				behavior: glide()
			});
			return;
		}
	}

	/** Back to where the view opens (S-14). */
	function toNow() {
		viewport.scrollTo({ left: view.nowX - viewport.clientWidth + 180, behavior: glide() });
	}

	function panStart(e: PointerEvent) {
		if (e.pointerType !== 'mouse' || e.button !== 0) return;
		if ((e.target as Element).closest('button')) return;
		dragging = true;
	}
	function panMove(e: PointerEvent) {
		// a button released outside the window never reports it: stop following the mouse
		if (dragging && !(e.buttons & 1)) dragging = false;
		if (!dragging) return;
		viewport.scrollLeft -= e.movementX;
		viewport.scrollTop -= e.movementY;
	}

	const isPicked = (c: Cluster) => c.nodes.some((n) => picked.includes(n.id));
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
				<div class="relative z-10" style="height: {box.height}px">
					<div
						aria-hidden="true"
						class="absolute h-0.5 {box.lane.closed ? 'bg-rail-dim' : 'bg-rail'}"
						style="top: {box.lineY - 1}px; left: {box.lineLeft}px; width: {Math.max(0, box.lineRight - box.lineLeft)}px"
					></div>
					<div class="flex items-end {box.folded ? 'h-5' : 'h-[30px]'}">
						<div class="flex-none" style="width: {Math.max(0, box.lineLeft - 9)}px"></div>
						<div class="sticky left-4 z-20 flex flex-none items-baseline gap-2.5 bg-ground py-0.5 pr-3 whitespace-nowrap">
							{#if box.lane.closed}
								<!-- S-16: a finished lane folds to a strip; its name opens it -->
								<button
									type="button"
									aria-expanded={!box.folded}
									title={box.folded ? 'Show this line in full' : 'Fold this line'}
									class="-mx-1 flex items-baseline gap-1.5 rounded px-1 font-medium text-muted hover:text-ink {box.folded ? 'text-[13px]' : 'text-[15px]'}"
									onclick={() => onfold(box.lane.id)}
								>
									<span aria-hidden="true" class="font-mono text-[10px]">{box.folded ? '▸' : '▾'}</span>
									{box.lane.name}
								</button>
							{:else}
								<span class="text-[15px] font-medium">{box.lane.name}</span>
							{/if}
							{#if box.lane.project}
								<span class="font-mono text-xs text-muted">{box.lane.project}</span>
							{/if}
							<span class="text-xs {box.urgent ? 'text-needs' : 'text-muted'}">{box.status}</span>
						</div>
					</div>

					{#each box.clusters as c (c.key)}
						{@const cy = box.lineY + c.row * ROW_H}
						<button
							type="button"
							aria-label={c.title}
							title={c.title}
							class="absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center {box.folded ? 'h-4 min-w-3.5' : 'h-6 min-w-6'}"
							style="left: {c.markX}px; top: {cy}px"
							onclick={() => onpick(c)}
						>
							<Mark state={c.state} stage={c.stage} count={c.nodes.length} selected={isPicked(c)} small={box.folded || (c.quiet && c.stage !== null)} />
						</button>
						{#if c.label}
							<!-- starts clear of the selection ring around the mark -->
							<div
								aria-hidden="true"
								class="s-{c.state} pointer-events-none absolute -translate-y-1/2 bg-ground pr-1 font-mono text-[11px] leading-4 whitespace-nowrap"
								style="left: {c.labelX}px; top: {cy}px; color: {c.quiet ? 'color-mix(in srgb, var(--color-muted) 70%, var(--color-ground))' : 'var(--tone)'}"
							>
								{c.label}
							</div>
						{/if}
					{/each}
				</div>
			{/each}
		</div>
	</section>

	<!-- what the three shapes mean; it sits on the timeline so the header has room -->
	<div class="pointer-events-none absolute bottom-4 left-4 z-40 hidden items-center gap-4 rounded-md border border-edge bg-ground px-3 py-2 text-xs text-muted sm:flex">
		<span class="inline-flex items-center gap-2"><Mark state="done" stage="ticket" small />ticket</span>
		<span class="inline-flex items-center gap-2"><Mark state="done" stage="session" small />has a session</span>
		<span class="inline-flex items-center gap-2"><Mark state="done" stage="pr" small />has a pull request</span>
	</div>

	<div class="absolute right-4 bottom-4 z-40 flex overflow-hidden rounded-md border border-rail bg-ground">
		<button type="button" class="h-11 px-3.5 font-mono text-xs hover:bg-edge" onclick={toNow}>now</button>
		<button type="button" aria-label="Zoom out" class="h-11 w-11 border-l border-rail text-lg hover:bg-edge" onclick={() => zoom(1 / 1.5)}>−</button>
		<button type="button" aria-label="Zoom in" class="h-11 w-11 border-l border-rail text-lg hover:bg-edge" onclick={() => zoom(1.5)}>+</button>
	</div>
</div>
