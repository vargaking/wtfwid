<script lang="ts">
	import type { PublicSettings, SecretState } from './model';

	interface Props {
		open: boolean;
		onsaved: () => void;
	}
	let { open = $bindable(), onsaved }: Props = $props();

	type Secret = 'linearKey' | 'githubToken';

	let dialog: HTMLDialogElement;
	let current = $state<PublicSettings | null>(null);
	let team = $state('');
	let repos = $state('');
	let typed = $state<Record<Secret, string>>({ linearKey: '', githubToken: '' });
	let removing = $state<Record<Secret, boolean>>({ linearKey: false, githubToken: false });
	let error = $state('');
	let saving = $state(false);

	$effect(() => {
		if (open && !dialog.open) {
			load();
			dialog.showModal();
		} else if (!open && dialog.open) dialog.close();
	});

	async function load() {
		error = '';
		typed = { linearKey: '', githubToken: '' };
		removing = { linearKey: false, githubToken: false };
		const res = await fetch('/api/settings');
		if (!res.ok) {
			error = 'Could not load the settings.';
			return;
		}
		current = await res.json();
		team = current!.linearTeam;
		repos = current!.githubRepos.join(', ');
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		error = '';
		const body: Record<string, unknown> = { linearTeam: team, githubRepos: repos.split(/[\s,]+/).filter(Boolean) };
		for (const name of ['linearKey', 'githubToken'] as const) {
			if (typed[name]) body[name] = typed[name];
			else if (removing[name]) body[name] = null;
		}
		const res = await fetch('/api/settings', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}).catch(() => null);
		saving = false;
		if (!res?.ok) {
			error = (await res?.json().catch(() => null))?.message ?? 'Could not save the settings.';
			return;
		}
		open = false;
		onsaved();
	}

	const HINT: Record<Secret, Record<SecretState, string>> = {
		linearKey: {
			saved: 'A key is saved. Type a new one to replace it.',
			locked: 'A key is saved, but the desktop app encrypted it and it cannot be read here. Type it again to use it here.',
			env: 'Using the key from your .env file. A key saved here takes its place.',
			none: 'Create one in Linear under Settings → Account → Security & Access. Without a key you see demo data.'
		},
		githubToken: {
			saved: 'A token is saved. Type a new one to replace it.',
			locked: 'A token is saved, but the desktop app encrypted it and it cannot be read here. Type it again to use it here.',
			env: 'Using the token from your environment. A token saved here takes its place.',
			none: 'Optional. Without one, wtfwid uses the login of the GitHub CLI (gh).'
		}
	};
</script>

{#snippet secret(name: Secret, label: string)}
	{@const status = current?.[name] ?? 'none'}
	<div>
		<label class="font-medium" for="settings-{name}">{label}</label>
		<div class="mt-1.5 flex gap-2">
			<input
				id="settings-{name}"
				type="password"
				autocomplete="off"
				spellcheck="false"
				class="field min-w-0 flex-1"
				placeholder={status === 'saved' && !removing[name] ? '••••••••••••' : ''}
				aria-describedby="settings-{name}-hint"
				bind:value={typed[name]}
			/>
			{#if status === 'saved'}
				<button type="button" class="quiet" aria-pressed={removing[name]} onclick={() => (removing[name] = !removing[name])}>
					{removing[name] ? 'Keep' : 'Remove'}
				</button>
			{/if}
		</div>
		<p id="settings-{name}-hint" class="mt-1.5 text-[13px] text-muted">
			{removing[name] && !typed[name] ? 'Will be removed when you save.' : HINT[name][status]}
		</p>
	</div>
{/snippet}

<dialog
	bind:this={dialog}
	aria-labelledby="settings-title"
	class="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-lg border border-rail bg-ground p-0 text-ink backdrop:bg-black/60"
	onclose={() => (open = false)}
>
	<form class="flex flex-col gap-5 p-6" onsubmit={save}>
		<h2 id="settings-title" class="text-xl font-semibold">Settings</h2>

		{@render secret('linearKey', 'Linear API key')}

		<div>
			<label class="font-medium" for="settings-team">Linear team key</label>
			<input id="settings-team" class="field mt-1.5 w-full" autocomplete="off" spellcheck="false" placeholder="ENG" aria-describedby="settings-team-hint" bind:value={team} />
			<p id="settings-team-hint" class="mt-1.5 text-[13px] text-muted">The prefix of your issue IDs. Leave empty to read every team.</p>
		</div>

		<div>
			<label class="font-medium" for="settings-repos">GitHub repositories</label>
			<input id="settings-repos" class="field mt-1.5 w-full" autocomplete="off" spellcheck="false" placeholder="owner/repo, owner/other" aria-describedby="settings-repos-hint" bind:value={repos} />
			<p id="settings-repos-hint" class="mt-1.5 text-[13px] text-muted">Where to read pull requests from, separated by commas.</p>
		</div>

		{@render secret('githubToken', 'GitHub token')}

		{#if current}
			<p class="border-t border-edge pt-4 text-[13px] text-muted">
				{current.storage === 'keychain' ? 'Keys are encrypted with your system keychain and kept in' : 'Keys are kept without encryption in'}
				<span class="font-mono break-all">{current.file}</span>.
			</p>
		{/if}

		{#if error}
			<p role="alert" class="text-failed">{error}</p>
		{/if}

		<div class="flex justify-end gap-2">
			<button type="button" class="quiet" onclick={() => (open = false)}>Cancel</button>
			<button type="submit" class="min-h-11 rounded-md bg-ink px-4 font-medium text-ground disabled:opacity-60" disabled={saving}>
				{saving ? 'Saving…' : 'Save'}
			</button>
		</div>
	</form>
</dialog>

<style>
	.field {
		box-sizing: border-box;
		height: 44px;
		border: 1px solid var(--color-rail);
		border-radius: 6px;
		background: var(--color-edge);
		padding: 0 12px;
		color: var(--color-ink);
		font-family: var(--font-mono);
		font-size: 14px;
	}
	.field::placeholder {
		color: var(--color-faint);
	}
	.quiet {
		min-height: 44px;
		border: 1px solid var(--color-rail);
		border-radius: 6px;
		padding: 0 14px;
		color: var(--color-ink);
	}
	.quiet:hover {
		background: var(--color-edge);
	}
</style>
