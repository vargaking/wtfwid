<script lang="ts">
	import { onMount } from 'svelte';
	import { ASK, buttonText, CHECK_EVERY_MS, type UpdateStatus, type VersionInfo } from './update';

	// S-82: says when a newer version is out. Where the app can replace itself (a Linux
	// AppImage) it is a button that downloads it and then offers the restart; everywhere
	// else it is a link to the release page. Nothing is shown when the app is up to date.
	let info = $state<VersionInfo | null>(null);
	let status = $state<UpdateStatus>({ state: 'idle' });
	let restarting = $state(false);
	let watching: ReturnType<typeof setTimeout> | undefined;

	async function check() {
		const res = await fetch('/api/version').catch(() => null);
		// no answer keeps what was known: the server keeps its own answer for hours anyway
		if (res?.ok) info = await res.json();
		watch();
	}

	/** Asks how far the install has got, and again shortly for as long as it is downloading. */
	async function watch() {
		clearTimeout(watching);
		const res = await fetch('/api/update').catch(() => null);
		if (res?.ok) status = await res.json();
		if (status.state === 'downloading') watching = setTimeout(watch, 700);
	}

	async function press() {
		if (status.state === 'idle') {
			const res = await fetch('/api/update', ASK).catch(() => null);
			if (res?.ok) return watch();
			const said = await res?.json().catch(() => null);
			status = { state: 'failed', message: said?.message ?? 'Could not start the update.' };
		} else if (status.state === 'ready' && !restarting) {
			restarting = true;
			const res = await fetch('/api/update/restart', ASK).catch(() => null);
			// The app closes this window on its way out. An answer that says no means it is not restarting.
			if (res && !res.ok) {
				restarting = false;
				watch();
			}
		}
	}

	onMount(() => {
		check();
		const every = setInterval(check, CHECK_EVERY_MS);
		return () => {
			clearInterval(every);
			clearTimeout(watching);
		};
	});

	const latest = $derived(info?.latest ?? null);
	// a version that is downloaded and waiting is worth a button even if nothing else is known
	const text = $derived(status.state === 'ready' || (latest && info?.canInstall) ? buttonText(latest?.version ?? '', status) : null);
	const busy = $derived(status.state === 'downloading' || restarting);
</script>

<!-- These sit in the header's own row, right after "updated HH:MM": the negative margin
     takes back most of the header's gap, so it reads as part of that group. -->
{#if text}
	<!-- one button from start to finish, so the keyboard stays on it while its words change -->
	<button
		type="button"
		aria-disabled={busy}
		class="-ml-4 min-h-11 rounded-md border border-rail px-3.5 text-sm tabular-nums {busy ? 'cursor-default text-muted' : 'text-ink hover:bg-edge'}"
		onclick={press}
	>
		{restarting ? 'Restarting' : text}
	</button>
{:else if latest}
	<a class="-ml-4 text-muted underline underline-offset-2 hover:text-ink" href={latest.url} target="_blank" rel="noreferrer">
		v{latest.version} is out
	</a>
{/if}
{#if status.state === 'failed'}
	<!-- a row of its own under the header, like a source that could not be loaded -->
	<p class="order-last w-full text-failed" role="status">Could not update. {status.message}</p>
{/if}
