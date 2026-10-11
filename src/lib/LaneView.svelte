<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { MAX_ZOOM, MIN_ZOOM, ROW_H, startOfDay, tOf, xOf, type Cluster, type Layout } from './layout';
	import { arcs as drawArcs, type Link } from './arcs';
	import Mark from './Mark.svelte';
	import type { NodeState } from './model';
	import Overview from './Overview.svelte';

	interface Props {
		view: Layout;
		pxPerDay: number;
		/** ids of the nodes shown in the side panel */
		picked: string[];
		onpick: (cluster: Cluster) => void;
		/** Fold or unfold a finished lane. */
		onfold: (laneId: string) => void;
		/** S-86: what the open ticket is related to. Drawn as lines from it; everything else steps back. */
		links?: Link[];
		/** S-88: when the open ticket was worked on, as [from, to] in minutes since 1970, and its state for the colour. */
		worked?: { spans: [number, number][]; commits: number[]; state: NodeState } | null;
		/** S-89: the stretch of days the side panel is about, drawn as a band. */
		day?: { from: number; to: number } | null;
		/** A date on the axis was clicked: the start of that day. */
		ondaypick?: (t: number) => void;
	}
	let { view, pxPerDay = $bindable(), picked, onpick, onfold, links = [], worked = null, day = null, ondaypick }: Props = $props();

	const arcs = $derived(drawArcs(view, links));
	/** The ids at either end of a line. While there are lines, what is not among them is drawn dim. */
	const linked = $derived(new Set(links.flatMap((l) => [l.a, l.b])));
	const isLinked = (c: Cluster) => c.nodes.some((n) => linked.has(n.id));
	/** The ends of the lines that touch the open ticket itself: those get a ring. */
	const near = $derived(new Set(links.filter((l) => !l.far).flatMap((l) => [l.a, l.b])));
	const isNear = (c: Cluster) => c.nodes.some((n) => near.has(n.id));
	const MINUTE = 60_000;
	const clock = (minutes: number) => new Date(minutes * MINUTE).toTimeString().slice(0, 5);


	let viewport: HTMLElement;
	let dragging = $state(false);

	/** Zooms the time axis, keeping the time under `clientX` (or the middle) where it is. */
	async function zoom(factor: number, clientX?: number) {
		const rect = viewport.getBoundingClientRect();
		// With the buttons, zoom around the open ticket if it is in view, so it stays there;
		// otherwise around the middle. With the wheel, around the pointer.
		let offset = rect.width / 2;
		if (clientX !== undefined) offset = clientX - rect.left;
		else {
			const open = view.lanes.flatMap((box) => box.clusters).find(isPicked);
			const at = open ? open.markX - viewport.scrollLeft : -1;
			if (at >= 0 && at <= rect.width) offset = at;
		}
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

	/** Left and right arrow on a date go to the date before and after it (S-89). */
	function stepDay(e: KeyboardEvent) {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		const dates = [...viewport.querySelectorAll<HTMLElement>('[data-day]')];
		const next = dates[dates.indexOf(e.currentTarget as HTMLElement) + (e.key === 'ArrowLeft' ? -1 : 1)];
		if (!next) return;
		e.preventDefault();
		next.focus();
	}
</script>

<!-- S-80: the timeline, and under it the strip that shows all of time. The inner block is the timeline as it was. -->
<div class="flex min-w-0 flex-1 flex-col">
<div class="@container relative min-h-80 min-w-0 flex-1">
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
		<div class="relative min-h-full min-w-full select-none" style="width: {view.width}px; height: {view.height}px">
			{#each view.ticks as t (t.x)}
				<div aria-hidden="true" class="absolute inset-y-0 w-px bg-grid" style="left: {t.x}px"></div>
			{/each}
			<div aria-hidden="true" class="absolute inset-y-0 border-l border-dashed border-faint" style="left: {view.nowX}px"></div>
			{#if day}
				<!-- S-89: the day, or week, the side panel is about -->
				{@const left = xOf(day.from, view.t0, pxPerDay)}
				<!-- two lines, no fill: names on the timeline have their own background and would punch holes in one -->
				<div aria-hidden="true" class="absolute inset-y-0 box-border border-x border-rail" style="left: {left}px; width: {xOf(day.to, view.t0, pxPerDay) - left}px"></div>
			{/if}

			{#each view.connectors as c (c.left + ':' + c.top + ':' + c.height)}
				<div
					aria-hidden="true"
					class="pointer-events-none absolute box-border rounded-bl-[14px] border-b-2 border-l-2 border-rail"
					style="left: {c.left - 1}px; top: {c.top}px; width: {c.width + 1}px; height: {c.height + 1}px"
				></div>
			{/each}

			{#if arcs.length}
				<!-- S-86: lines from the open ticket to what it is related to. Under the names and the
				     line titles, which have a background of their own: a line never strikes through text. -->
				<svg aria-hidden="true" class="pointer-events-none absolute top-0 left-0 overflow-visible" width={view.width} height={view.height}>
					<defs>
						<marker id="arc-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
							<path d="M0 0.5 L7.5 4 L0 7.5 z" fill="var(--color-ink)" />
						</marker>
					</defs>
					{#each arcs as arc (arc.key)}
						<path
							d={arc.d}
							fill="none"
							stroke="var(--color-ink)"
							stroke-width={arc.far ? 1.25 : arc.width}
							stroke-opacity={arc.far ? 0.4 : arc.continued ? 0.9 : 0.55}
							stroke-dasharray={arc.continued ? undefined : '2 5'}
							stroke-linecap="round"
							marker-end={arc.head ? 'url(#arc-head)' : undefined}
						/>
					{/each}
				</svg>
			{/if}

			<div class="sticky top-0 z-30 box-border h-10 border-b border-edge bg-ground font-mono text-xs text-muted">
				{#each view.ticks as t (t.x)}
					{#if t.label && t.hour}
						<span class="absolute top-3 whitespace-nowrap opacity-70" style="left: {t.x + 6}px">{t.label}</span>
					{:else if t.label}
						<!-- S-89: a date is a button: what happened that day (that week, when dates are a week apart).
						     Tab stops at "now" only; from there the arrow keys go through the dates. -->
						<button
							type="button"
							tabindex="-1"
							data-day
							aria-pressed={day?.from === t.t}
							title={view.tickDays === 1 ? 'What happened that day' : 'What happened that week'}
							class="absolute top-1 h-8 rounded px-1.5 whitespace-nowrap hover:bg-edge hover:text-ink {day?.from === t.t ? 'bg-edge text-ink' : ''}"
							style="left: {t.x}px"
							onkeydown={stepDay}
							onclick={() => ondaypick?.(t.t)}>{t.label}</button
						>
					{/if}
				{/each}
				<button
					type="button"
					data-day
					aria-pressed={day?.from === startOfDay(view.now)}
					onkeydown={stepDay}
					title="What happened today. Arrow keys go to other days."
					class="absolute top-1 h-8 rounded px-1.5 whitespace-nowrap text-ink hover:bg-edge {day?.from === startOfDay(view.now) ? 'bg-edge' : ''}"
					style="left: {view.nowX}px"
					onclick={() => ondaypick?.(startOfDay(view.now))}>{view.nowLabel}</button
				>
				{#if worked}
					<!-- S-88: when the open ticket was worked on, along the bottom of the axis -->
					{#each worked.spans as [from, to], i (i)}
						{@const left = xOf(from * MINUTE, view.t0, pxPerDay)}
						<span
							title="Worked on {clock(from)} to {clock(to)}"
							class="s-{worked.state} absolute bottom-0 h-1 rounded-sm"
							style="left: {left}px; width: {Math.max(3, xOf(to * MINUTE, view.t0, pxPerDay) - left)}px; background: var(--tone)"
						></span>
					{/each}
					<!-- S-90: and when its pull requests' commits were made: the trace work in the cloud leaves -->
					{#each worked.commits as at, i (i)}
						<span
							title="Commit at {clock(at)}"
							class="s-{worked.state} absolute bottom-0 h-2 w-0.5 rounded-sm"
							style="left: {xOf(at * MINUTE, view.t0, pxPerDay) - 1}px; background: var(--tone)"
						></span>
					{/each}
				{/if}
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
							class="absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center transition-opacity {box.folded ? 'h-4 min-w-3.5' : 'h-6 min-w-6'}"
							class:opacity-50={links.length > 0 && c.quiet && !isLinked(c) && !isPicked(c)}
							style="left: {c.markX}px; top: {cy}px"
							onclick={() => onpick(c)}
						>
							<Mark
								state={c.state}
								stage={c.stage}
								count={c.nodes.length}
								selected={isPicked(c)}
								linked={isNear(c) && !isPicked(c)}
								small={box.folded || (c.quiet && c.stage !== null)}
								alive={c.state === 'working' || c.state === 'needs'}
							/>
						</button>
						{#if c.label}
							<!-- starts clear of the selection ring around the mark -->
							<div
								aria-hidden="true"
								class="s-{c.state} pointer-events-none absolute -translate-y-1/2 bg-ground pr-1 font-mono text-[11px] leading-4 whitespace-nowrap transition-opacity"
								class:opacity-50={links.length > 0 && c.quiet && !isLinked(c) && !isPicked(c)}
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
	<!-- only where the pane is wide enough to hold it next to the buttons without covering much -->
	<div class="pointer-events-none absolute bottom-4 left-4 z-40 hidden items-center gap-4 rounded-md border border-edge bg-ground px-3 py-2 text-xs text-muted @4xl:flex">
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
<Overview {view} scroller={() => viewport} onnow={toNow} />
</div>
