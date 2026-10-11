<script lang="ts">
	import { goto, refreshAll } from '$app/navigation';
	import { onMount, tick, untrack } from 'svelte';
	import LaneView from '#lib/LaneView.svelte';
	import type { Link } from '#lib/arcs.ts';
	import { dayOf } from '#lib/days.ts';
	import { DAY, layout, nextInState, restoreView, startOfDay, unfinished, type Cluster } from '#lib/layout.ts';
	import type { Action, Graph, GraphNode, Lane, LiveEvent, NodeState } from '#lib/model.ts';
	import { alerts, reliable, type Alert } from '#lib/notify.ts';
	import Panel from '#lib/Panel.svelte';
	import { relationsOf } from '#lib/relations.ts';
	import Search from '#lib/Search.svelte';
	import Settings from '#lib/Settings.svelte';
	import Update from '#lib/Update.svelte';
	import Welcome from '#lib/Welcome.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const VIEW_KEY = 'wtfwid.view';
	function readStored(): string | null {
		try {
			return localStorage.getItem(VIEW_KEY);
		} catch {
			return null;
		}
	}

	// S-78: the view comes back the way it was left. The page only runs in a browser, so
	// storage can be read before anything is drawn and the timeline opens at the right zoom.
	const kept = restoreView(readStored());
	let pxPerDay = $state(kept.pxPerDay);
	let hideFinished = $state(kept.hideFinished);
	let picked = $state<string[]>([]);
	let focusId = $state<string | null>(null);
	let settingsOpen = $state(false);

	const graph = $derived(data.graph);
	const now = $derived(Date.parse(graph.fetchedAt));
	// S-16: finished lanes are folded until their name is clicked
	let unfolded = $state<string[]>(kept.unfolded);
	$effect(() => {
		const view = JSON.stringify({ pxPerDay, hideFinished, unfolded });
		try {
			localStorage.setItem(VIEW_KEY, view);
		} catch {
			// no storage: the view lasts until the window closes
		}
	});
	/** S-17: the finished line a ticket was opened on from a list, shown in full while that ticket is open. */
	let peek = $state<string | null>(null);
	const view = $derived(layout(graph, now, pxPerDay, hideFinished, undefined, new Set(unfolded), peek));
	const fold = (id: string) => (unfolded = unfolded.includes(id) ? unfolded.filter((x) => x !== id) : [...unfolded, id]);
	const byId = $derived(new Map(graph.lanes.flatMap((l) => l.nodes).map((n) => [n.id, n])));
	const pickedNodes = $derived(picked.map((id) => byId.get(id)).filter((n): n is GraphNode => !!n));
	const focus = $derived((focusId && byId.get(focusId)) || (pickedNodes.length === 1 ? pickedNodes[0] : null));
	const laneOf = $derived(new Map(graph.lanes.flatMap((l) => l.nodes.map((n) => [n.id, l] as const))));
	/** S-86: what the open ticket is related to, strongest first. At most this many are drawn and listed. */
	const RELATED_SHOWN = 6;
	const related = $derived(
		focus
			? relationsOf(graph.relations, focus.id)
					.flatMap(({ other, relation }) => (byId.has(other) ? [{ node: byId.get(other)!, relation }] : []))
					.slice(0, RELATED_SHOWN)
			: []
	);
	/** The ways sessions went that pass through the open ticket (S-86): each the tickets one session worked on, in order. */
	const ways = $derived(focus ? (graph.threads ?? []).filter((t) => t.nodes.includes(focus.id)) : []);
	/**
	 * What the timeline draws for the open ticket: its relations, and the whole way of every
	 * session that worked on it, lighter away from the ticket itself.
	 */
	const links = $derived.by(() => {
		const out = new Map<string, Link>(related.map((r) => [`${r.relation.a}>${r.relation.b}`, r.relation]));
		for (const way of ways) {
			for (let i = 1; i < way.nodes.length; i++) {
				const [a, b] = [way.nodes[i - 1], way.nodes[i]];
				if (out.has(`${a}>${b}`) || out.has(`${b}>${a}`)) continue;
				out.set(`${a}>${b}`, { a, b, continued: true, weight: 0, far: a !== focus?.id && b !== focus?.id });
			}
		}
		return [...out.values()];
	});
	const updated = $derived(new Date(now).toTimeString().slice(0, 5));
	const left = $derived(unfinished(graph));

	const toPanel = () => document.getElementById('ticket-panel')?.focus({ preventScroll: true });

	async function pick(cluster: Cluster) {
		picked = cluster.nodes.map((n) => n.id);
		focusId = null;
		// a line that was opened for another ticket goes back to how it was
		if (!cluster.nodes.some((n) => laneOf.get(n.id)?.id === peek)) peek = null;
		await tick();
		// the keyboard goes where the ticket is shown, not on through the rest of the timeline
		toPanel();
	}

	/** Lets go of the open ticket; with none open, of the day (S-89). */
	function clear() {
		if (!picked.length) dayPick = null;
		picked = [];
		focusId = null;
		peek = null;
	}

	// S-89: a date on the axis was clicked. The side panel says what happened then.
	let dayPick = $state<{ from: number; to: number } | null>(null);
	const day = $derived(dayPick ? dayOf(graph.lanes, dayPick.from, dayPick.to) : null);
	const today = $derived(dayOf(graph.lanes, startOfDay(now)));
	/** `days` is how many days the stretch covers; the same date again lets go of it. */
	async function pickDay(from: number | null, days = 1) {
		picked = [];
		focusId = null;
		peek = null;
		// half a day past the last one, then back to midnight: right on days the clock changes too
		dayPick = from === null || dayPick?.from === from ? null : { from, to: startOfDay(from + days * DAY + DAY / 2) };
		await tick();
		if (dayPick) toPanel();
	}

	const JUMPS = [
		{ state: 'needs', tone: 'text-needs', text: (n: number) => `${n} ${n === 1 ? 'needs' : 'need'} you` },
		{ state: 'working', tone: 'text-working', text: (n: number) => `${n} working` },
		{ state: 'review', tone: 'text-review', text: (n: number) => `${n} ready for review` },
		{ state: 'failed', tone: 'text-failed', text: (n: number) => `${n} failed` },
		// started and not finished, with nothing running on it: the easiest kind to forget
		{ state: 'open', tone: 'text-ink', text: (n: number) => `${n} open` }
	] as const;

	let timeline = $state<LaneView>();

	/**
	 * Shows a ticket: selects it and scrolls to it. If its line is finished and hidden or
	 * folded, the line is shown in full for as long as the ticket is open; what you chose to
	 * hide or fold is not changed by looking something up.
	 */
	async function show(node: GraphNode, lane: Lane | undefined) {
		peek = lane?.closed ? lane.id : null;
		picked = [node.id];
		focusId = null;
		await tick();
		timeline?.reveal(node.id);
		// hand the keyboard to the ticket that was just opened, not back to the top of the page
		toPanel();
	}

	/** S-15: go to the next ticket in this state, after the one that is open, and open it. */
	function jump(state: NodeState) {
		const next = nextInState(view, state, focus?.id ?? null);
		if (next) show(next, undefined);
	}

	// After settings change: leave the demo if we were in it, and load again. Always fetch
	// fresh: data loaded before the save would still say "not connected".
	const reload = () => (graph.demo ? goto('/', { invalidateAll: true }) : refreshAll());

	/** The last things each running session did, by session id, kept up to date by the stream (S-85). */
	let live = $state<Record<string, Action[]>>({});
	let streaming = false;
	const LIVE_KEPT = 12;

	// S-18: say so when a ticket starts needing you, a session fails, or one stops working.
	const canNotify = typeof Notification !== 'undefined';
	let notifyOn = $state(false);
	let notifyBlocked = $state(false);

	async function toggleNotify() {
		if (!notifyOn && Notification.permission !== 'granted') {
			notifyBlocked = (await Notification.requestPermission()) !== 'granted';
			if (notifyBlocked) return;
		}
		notifyOn = !notifyOn;
		try {
			localStorage.setItem('wtfwid.notify', notifyOn ? '1' : '0');
		} catch {
			// no storage: the choice lasts until the window closes
		}
	}

	function send(alert: Alert) {
		try {
			const n = new Notification(alert.title, { body: alert.body, tag: alert.id });
			n.onclick = () => {
				window.focus();
				const lane = graph.lanes.find((l) => l.nodes.some((node) => node.id === alert.id));
				const node = byId.get(alert.id);
				if (node) show(node, lane);
			};
		} catch {
			// the system refused it; the header still shows the count
		}
	}

	// Compare each refresh with the last one that could be trusted. A refresh where a source
	// failed is skipped, so the failure and the recovery are not mistaken for changes.
	let seen: Graph | null = null;
	$effect(() => {
		if (!reliable(graph)) return;
		const before = seen;
		seen = graph;
		if (!before || !untrack(() => notifyOn)) return;
		for (const alert of alerts(before, graph)) send(alert);
	});

	// S-65: read everything again every minute. In between, ask every 15 seconds whether a
	// session changed state, and read again at once if one did (S-18).
	onMount(() => {
		if (canNotify) {
			let stored: string | null = null;
			try {
				stored = localStorage.getItem('wtfwid.notify');
			} catch {
				// no storage
			}
			// on by default where notifications are already allowed, as in the desktop app
			notifyOn = stored === null ? Notification.permission === 'granted' : stored === '1' && Notification.permission === 'granted';
		}

		const refresh = () => !graph.setup && refreshAll();

		// S-85: a stream from the server that says what running sessions are doing as it happens,
		// and when a session starts, stops or changes state. It reconnects by itself.
		let stream: EventSource | undefined;
		if (typeof EventSource !== 'undefined') {
			stream = new EventSource('/api/live');
			stream.onopen = () => (streaming = true);
			stream.onerror = () => (streaming = false);
			stream.onmessage = (message) => {
				const event = JSON.parse(message.data) as LiveEvent;
				if (event.type === 'hello') live = event.sessions;
				else if (event.type === 'actions') live[event.id] = [...(live[event.id] ?? []), ...event.actions].slice(-LIVE_KEPT);
				else if (event.type === 'sessions') refresh();
			};
		}

		// Without the stream, ask now and then whether a session changed state (S-18).
		let beat: string | null = null;
		const check = async () => {
			if (graph.setup || graph.demo) return;
			const next = await fetch('/api/pulse').then((r) => (r.ok ? r.text() : null), () => null);
			if (next === null) return;
			if (beat !== null && next !== beat) refresh();
			beat = next;
		};
		check();
		const slow = setInterval(refresh, 60_000);
		const fast = setInterval(() => !streaming && check(), 15_000);
		const onVisible = () => document.visibilityState === 'visible' && check();
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			stream?.close();
			clearInterval(slow);
			clearInterval(fast);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
</script>

<svelte:head>
	<!-- the count shows in the window title and the task bar, where you see it without looking here -->
	<title>{!graph.setup && view.counts.needs ? `(${view.counts.needs}) ` : ''}wtfwid</title>
</svelte:head>

<!-- Escape lets go of the selected ticket, unless a dialog or the search box wants the key -->
<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && !settingsOpen && !(document.activeElement instanceof HTMLInputElement)) clear();
	}}
/>

{#if graph.setup}
	<Welcome onsaved={reload} />
{:else}
<div class="flex h-screen flex-col">
	<header class="flex flex-wrap items-center gap-x-7 gap-y-2 border-b border-edge px-6 py-3">
		<div class="flex items-baseline gap-3">
			<span class="font-mono text-lg font-semibold tracking-wide">wtfwid</span>
			<span class="text-muted">updated {updated}</span>
		</div>
		{#if !graph.demo}<Update />{/if}
		<div class="flex flex-wrap gap-x-5 gap-y-1 font-medium">
			{#each JUMPS as j (j.state)}
				{#if view.counts[j.state]}
					<button
						type="button"
						title="Go to the next one"
						class="-mx-1.5 -my-1 rounded px-1.5 py-1 underline-offset-4 hover:bg-edge hover:underline {j.tone}"
						onclick={() => jump(j.state)}
					>
						{j.text(view.counts[j.state])}
					</button>
				{:else}
					<span class="opacity-60 {j.tone}">{j.text(0)}</span>
				{/if}
			{/each}
		</div>
		<div class="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
			{#if graph.demo}
				<span class="rounded border border-rail px-2 py-0.5 font-mono text-xs">demo data</span>
				<a class="underline underline-offset-2 hover:text-ink" href="/">leave demo</a>
			{/if}
			{#if canNotify && !graph.demo}
				<button
					type="button"
					aria-pressed={notifyOn}
					title={notifyBlocked ? 'Notifications are blocked for this page. Allow them in the browser to turn this on.' : 'Notify me when a ticket needs me, a session fails or one stops working'}
					class="min-h-11 rounded-md border px-3.5 text-sm hover:bg-edge {notifyOn ? 'border-muted text-ink' : 'border-rail text-muted'}"
					onclick={toggleNotify}
				>
					{notifyBlocked ? 'Notifications blocked' : notifyOn ? 'Notifying' : 'Notify me'}
				</button>
			{/if}
			{#if graph.lanes.length}
				<Search lanes={graph.lanes} onchoose={(hit) => show(hit.node, hit.lane)} />
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
		{#if graph.lanes.length}
			<LaneView
				bind:this={timeline}
				{view}
				bind:pxPerDay
				{picked}
				onpick={pick}
				onfold={fold}
				{links}
				worked={focus?.work ? { spans: focus.work.spans, commits: focus.work.commits, state: focus.state } : null}
				day={dayPick}
				ondaypick={(t) => pickDay(t, t === startOfDay(now) ? 1 : view.tickDays)}
			/>
			<Panel
				nodes={pickedNodes}
				{focus}
				onfocus={(id) => (focusId = id)}
				unfinished={left.map((u) => u.node)}
				onshow={(node) => show(node, laneOf.get(node.id))}
				{related}
				ways={ways.map((w) => ({ session: w.session, nodes: w.nodes.flatMap((id) => byId.get(id) ?? []) }))}
				{day}
				{today}
				onday={pickDay}
				onclear={clear}
				{live}
			/>
		{:else}
			<div class="flex flex-1 items-center justify-center px-6 text-center">
				<div class="max-w-md">
					<h2 class="text-xl font-semibold">Nothing on the timeline yet</h2>
					<p class="mt-2 text-muted">
						A ticket shows up once it has been started or completed, or has a Claude Code session or a pull request. If you expected
						some here, check the team key in Settings.
					</p>
				</div>
			</div>
		{/if}
	</main>
</div>

<Settings bind:open={settingsOpen} onsaved={reload} />
{/if}
