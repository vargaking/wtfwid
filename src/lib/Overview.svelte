<script lang="ts">
	import { onMount } from 'svelte';
	import type { Layout } from './layout';
	import { BASE_Y, LABEL_H, STRIP_H, keyTarget, overview, scrollFor, toStrip, windowAt, windowText } from './overview';

	interface Props {
		view: Layout;
		/** The element that scrolls the timeline. Asked for when needed: it exists only once the timeline is on screen. */
		scroller: () => HTMLElement;
		/** Back to where the view opens (S-14). End does what the "now" button does. */
		onnow: () => void;
	}
	let { view, scroller, onnow }: Props = $props();

	let strip: HTMLElement;
	let width = $state(0);
	// Where the timeline is scrolled to and how wide it is, read at most once per frame.
	let scrollLeft = $state(0);
	let clientWidth = $state(0);
	let scrollMax = $state(0);
	let dragging = $state(false);
	let overWindow = $state(false);
	/** The id of the timeline's scrolling element, for screen readers: this strip is its scrollbar. */
	let controls = $state('');

	// The bars depend on the layout and the strip's width only. Scrolling changes the three
	// numbers above, and with them just the window: the bars are not worked out again.
	const map = $derived(overview(view, width));
	const win = $derived(windowAt(map, width, scrollLeft, clientWidth));
	const percent = $derived(scrollMax > 0 ? Math.round((100 * Math.min(scrollLeft, scrollMax)) / scrollMax) : 0);
	const showing = $derived(windowText(view, scrollLeft, clientWidth));

	let queue = () => {};
	onMount(() => {
		const el = scroller();
		// the timeline has no id of its own; a scrollbar has to name what it scrolls
		controls = el.id ||= 'timeline';
		let frame = 0;
		const read = () => {
			frame = 0;
			scrollLeft = el.scrollLeft;
			clientWidth = el.clientWidth;
			scrollMax = el.scrollWidth - el.clientWidth;
		};
		queue = () => (frame ||= requestAnimationFrame(read));
		el.addEventListener('scroll', queue, { passive: true });
		const sizes = new ResizeObserver(queue);
		sizes.observe(el);
		read();
		return () => {
			el.removeEventListener('scroll', queue);
			sizes.disconnect();
			cancelAnimationFrame(frame);
		};
	});
	// A new layout (zoom, new data, lines hidden) can change what there is to scroll without a scroll event.
	$effect(() => {
		void view;
		queue();
	});

	/** How far from the middle of the window it was taken hold of, in strip pixels. */
	let grab = 0;
	/** Where the pointer went down inside the window, until it has moved: letting go there is a click, not a drag. */
	let pressed: number | null = null;
	const at = (e: PointerEvent) => e.clientX - strip.getBoundingClientRect().left;
	const inWindow = (sx: number) => sx >= win.x && sx <= win.x + win.w;

	function go(sx: number) {
		const el = scroller();
		el.scrollLeft = scrollFor(sx - grab, map, el.clientWidth);
	}
	function down(e: PointerEvent) {
		if (e.button !== 0) return;
		const sx = at(e);
		const el = scroller();
		// Taking hold of the window moves it from where it is. Anywhere else, that time comes to the middle.
		pressed = inWindow(sx) ? sx : null;
		grab = pressed === null ? 0 : sx - toStrip(el.scrollLeft + el.clientWidth / 2, map);
		dragging = true;
		// keep following the pointer when it leaves the strip
		strip.setPointerCapture(e.pointerId);
		go(sx);
	}
	function move(e: PointerEvent) {
		const sx = at(e);
		if (!dragging) return void (overWindow = inWindow(sx));
		if (pressed !== null && Math.abs(sx - pressed) > 3) pressed = null;
		go(sx);
	}
	function up(e: PointerEvent) {
		// a click inside the window, not a drag: that time comes to the middle, as it does anywhere else
		if (dragging && pressed !== null) {
			grab = 0;
			go(at(e));
		}
		stop();
	}
	function stop() {
		pressed = null;
		dragging = false;
	}
	function key(e: KeyboardEvent) {
		if (e.altKey || e.ctrlKey || e.metaKey) return;
		const el = scroller();
		const to = keyTarget(e.key, el.scrollLeft, el.clientWidth);
		if (to === null) return;
		e.preventDefault();
		if (to === 'now') onnow();
		else el.scrollLeft = to;
	}
</script>

<!-- S-80: the whole of time in one strip. For screen readers and the keyboard it is the timeline's scrollbar. -->
<div
	bind:this={strip}
	bind:clientWidth={width}
	role="scrollbar"
	tabindex="0"
	aria-label="Overview of the whole timeline. Click or drag to go to a time; arrow keys pan, Home goes to the start, End to now."
	aria-orientation="horizontal"
	aria-controls={controls}
	aria-valuemin={0}
	aria-valuemax={100}
	aria-valuenow={percent}
	aria-valuetext="Showing {showing}"
	class="strip relative box-border h-12 flex-none touch-none overflow-hidden border-t border-edge bg-ground select-none"
	class:cursor-pointer={!dragging && !overWindow}
	class:cursor-grab={!dragging && overWindow}
	class:cursor-grabbing={dragging}
	onpointerdown={down}
	onpointermove={move}
	onpointerup={up}
	onpointercancel={stop}
	onlostpointercapture={stop}
	onpointerleave={() => (overWindow = false)}
	onkeydown={key}
>
	{#each map.labels as l (l.x)}
		<div aria-hidden="true" class="absolute inset-y-0.5 w-px bg-edge" style="left: {l.x}px"></div>
		<span aria-hidden="true" class="absolute top-[3px] font-mono text-[10px] leading-3 whitespace-nowrap text-muted" style="left: {l.x + 5}px">{l.text}</span>
	{/each}

	<svg aria-hidden="true" class="absolute top-0 left-0" width={width} height={STRIP_H}>
		{#each map.bars as b (b.x)}
			<!-- everything started in this stretch of time, in the dim colour of finished work -->
			<rect class="s-done" x={b.x} y={BASE_Y - b.h} width={b.w} height={b.h} rx="1" fill="var(--stroke)" />
			{#if b.state}
				<!-- the unfinished part of it, at the foot, in the colour of its most urgent state -->
				<rect class="s-{b.state}" x={b.x} y={BASE_Y - b.live} width={b.w} height={b.live} rx="1" fill="var(--stroke)" />
			{/if}
			<!-- the whole height answers the mouse, so a short bar has a tooltip too -->
			<rect x={b.x} y="0" width={b.w + 1} height={STRIP_H} fill="transparent"><title>{b.title}</title></rect>
		{/each}
	</svg>

	<div aria-hidden="true" class="absolute inset-y-0.5 border-l border-dashed border-faint" style="left: {map.nowX}px"></div>
	<span aria-hidden="true" class="absolute top-[3px] font-mono text-[10px] leading-3 text-ink" style="left: {map.nowX + 5}px">now</span>

	<!-- the part of time the timeline is showing; it starts under the date labels so they stay readable -->
	<div
		aria-hidden="true"
		class="pointer-events-none absolute bottom-0.5 left-0 box-border rounded-[3px] border border-ink/80 bg-ink/15"
		style="top: {LABEL_H}px; transform: translateX({win.x}px); width: {win.w}px"
	></div>
</div>

<style>
	/* The strip runs along the edge of the window, where a ring outside it would be cut off.
	   What is drawn in the strip keeps two pixels from its edges, so nothing crosses the ring. */
	.strip:focus-visible {
		outline-offset: -2px;
	}
</style>
