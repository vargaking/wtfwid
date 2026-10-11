<script lang="ts">
	import SettingsForm from './SettingsForm.svelte';

	let { onsaved }: { onsaved: () => void } = $props();
</script>

<!-- First run: nothing is connected yet (S-63). -->
<main class="flex min-h-screen items-center justify-center px-4 py-10">
	<div class="w-full max-w-[30rem]">
		<p class="font-mono text-lg font-semibold tracking-wide">wtfwid</p>
		<h1 class="mt-6 text-2xl leading-tight font-semibold">Connect Linear to get started</h1>
		<p class="mt-3 mb-7 text-muted">
			wtfwid puts the tickets you have worked on along a timeline, with the Claude Code session and pull request behind each one. It only
			reads; it changes nothing.
		</p>

		<SettingsForm first {onsaved} />

		<p class="mt-7 border-t border-edge pt-4 text-[13px] text-muted">
			A session lands on its ticket by name, so start sessions with the ticket ID:
			<span class="font-mono text-ink">claude -n "ENG-123 fix login"</span>
		</p>
		<p class="mt-4 text-[13px]">
			<a class="text-muted underline underline-offset-2 hover:text-ink" href="/?demo">Look around with demo data first</a>
		</p>
	</div>
</main>
