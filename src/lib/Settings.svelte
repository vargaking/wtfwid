<script lang="ts">
	import SettingsForm from './SettingsForm.svelte';

	interface Props {
		open: boolean;
		onsaved: () => void;
	}
	let { open = $bindable(), onsaved }: Props = $props();

	let dialog: HTMLDialogElement;

	$effect(() => {
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="settings-title"
	class="m-auto max-h-[calc(100vh-2rem)] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-rail bg-ground p-0 text-ink backdrop:bg-black/60"
	onclose={() => (open = false)}
>
	<div class="p-6">
		<h2 id="settings-title" class="mb-5 text-xl font-semibold">Settings</h2>
		{#if open}
			<!-- mounted fresh each time, so it always shows what is saved now -->
			<SettingsForm
				oncancel={() => (open = false)}
				onsaved={() => {
					open = false;
					onsaved();
				}}
			/>
		{/if}
	</div>
</dialog>
