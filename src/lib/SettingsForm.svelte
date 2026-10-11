<script lang="ts">
	import { onMount } from 'svelte';
	import type { PublicSettings, SecretState } from './model';

	interface Props {
		/** First-run setup: only what is needed to get going. */
		first?: boolean;
		onsaved: () => void;
		oncancel?: () => void;
	}
	let { first = false, onsaved, oncancel }: Props = $props();

	type Secret = 'linearKey' | 'githubToken';

	let current = $state<PublicSettings | null>(null);
	let team = $state('');
	let repos = $state('');
	let typed = $state<Record<Secret, string>>({ linearKey: '', githubToken: '' });
	let removing = $state<Record<Secret, boolean>>({ linearKey: false, githubToken: false });
	let error = $state('');
	let saving = $state(false);

	onMount(async () => {
		const res = await fetch('/api/settings').catch(() => null);
		if (!res?.ok) {
			error = 'Could not load the settings.';
			return;
		}
		current = await res.json();
		team = current!.linearTeam;
		repos = current!.githubRepos.join(', ');
	});

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
		onsaved();
	}

	// S-79: try every source with what is saved, and show what came back
	interface Check {
		name: string;
		ok: boolean | null;
		summary: string;
		details: string[];
	}
	let checking = $state(false);
	let report = $state<{ checks: Check[]; text: string } | null>(null);
	let reportNote = $state('');

	async function check() {
		checking = true;
		reportNote = '';
		const res = await fetch('/api/doctor').catch(() => null);
		checking = false;
		if (!res?.ok) {
			reportNote = 'Could not run the check.';
			return;
		}
		report = await res.json();
	}

	async function copyReport() {
		try {
			await navigator.clipboard.writeText(report!.text);
			reportNote = 'Copied.';
		} catch {
			reportNote = 'Could not copy. Select the text below instead.';
		}
	}

	const VERDICT = { true: ['WORKS', 'text-review'], false: ['FAILS', 'text-failed'], null: ['NOT SET', 'text-muted'] } as const;

	const HINT: Record<Secret, Record<SecretState, string>> = {
		linearKey: {
			saved: 'A key is saved. Type a new one to replace it.',
			locked: 'A key is saved, but the desktop app encrypted it and it cannot be read here. Type it again to use it here.',
			env: 'Using the key from your .env file. A key saved here takes its place.',
			none: 'Create one in Linear under Settings → Account → Security & Access.'
		},
		githubToken: {
			saved: 'A token is saved. Type a new one to replace it.',
			locked: 'A token is saved, but the desktop app encrypted it and it cannot be read here. Type it again to use it here.',
			env: 'Using the token from your environment. A token saved here takes its place.',
			none: 'Optional. Without one, wtfwid uses the login of the GitHub CLI (gh).'
		}
	};
</script>

{#snippet secret(name: Secret, label: string, required: boolean)}
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
				{required}
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

<form class="flex flex-col gap-5" onsubmit={save}>
	{@render secret('linearKey', 'Linear API key', first)}

	<div>
		<label class="font-medium" for="settings-team">Linear team key{first ? ' (optional)' : ''}</label>
		<input id="settings-team" class="field mt-1.5 w-full" autocomplete="off" spellcheck="false" placeholder="ENG" aria-describedby="settings-team-hint" bind:value={team} />
		<p id="settings-team-hint" class="mt-1.5 text-[13px] text-muted">The prefix of your issue IDs. Leave empty to read every team.</p>
	</div>

	<div>
		<label class="font-medium" for="settings-repos">GitHub repositories{first ? ' (optional)' : ''}</label>
		<input id="settings-repos" class="field mt-1.5 w-full" autocomplete="off" spellcheck="false" placeholder="owner/repo, owner/other" aria-describedby="settings-repos-hint" bind:value={repos} />
		<p id="settings-repos-hint" class="mt-1.5 text-[13px] text-muted">Where to read pull requests from, separated by commas.</p>
	</div>

	{#if !first}
		{@render secret('githubToken', 'GitHub token', false)}
	{/if}

	{#if current}
		<p class="border-t border-edge pt-4 text-[13px] text-muted">
			{current.storage === 'keychain' ? 'Keys are encrypted with your system keychain and kept in' : 'Keys are kept without encryption in'}
			<span class="font-mono break-all">{current.file}</span>.
		</p>
	{/if}

	{#if !first}
		<div class="border-t border-edge pt-4">
			<div class="flex items-center justify-between gap-4">
				<div>
					<div class="font-medium">Check connections</div>
					<p class="mt-0.5 text-[13px] text-muted">Tries each source with the settings as saved. Shows counts only, never titles or what a session said.</p>
				</div>
				<button type="button" class="quiet flex-none" disabled={checking} onclick={check}>{checking ? 'Checking…' : 'Check'}</button>
			</div>
			{#if report}
				<ul class="mt-4 flex flex-col gap-3" aria-live="polite">
					{#each report.checks as c (c.name)}
						{@const [word, tone] = VERDICT[`${c.ok}`]}
						<li>
							<div class="flex items-baseline gap-2.5">
								<span class="w-16 flex-none font-mono text-xs {tone}">{word}</span>
								<span class="font-medium">{c.name}</span>
							</div>
							<div class="ml-[4.625rem] text-[13px]">
								<p>{c.summary}</p>
								{#each c.details as d (d)}
									<p class="text-muted">{d}</p>
								{/each}
							</div>
						</li>
					{/each}
				</ul>
				<div class="mt-3 flex items-center gap-3">
					<button type="button" class="quiet" onclick={copyReport}>Copy as text</button>
					<span class="text-[13px] text-muted" role="status">{reportNote}</span>
				</div>
				{#if reportNote.startsWith('Could not copy')}
					<textarea id="settings-report" readonly rows="8" class="mt-2 block w-full rounded-md border border-rail bg-ground p-2 font-mono text-xs text-muted">{report.text}</textarea>
				{/if}
			{:else if reportNote}
				<p class="mt-2 text-[13px] text-failed" role="alert">{reportNote}</p>
			{/if}
		</div>
	{/if}

	{#if error}
		<p role="alert" class="text-failed">{error}</p>
	{/if}

	<div class="flex gap-2 {first ? '' : 'justify-end'}">
		{#if oncancel}
			<button type="button" class="quiet" onclick={oncancel}>Cancel</button>
		{/if}
		<button type="submit" class="min-h-11 rounded-md bg-ink px-4 font-medium text-ground disabled:opacity-60" disabled={saving}>
			{saving ? 'Saving…' : first ? 'Connect' : 'Save'}
		</button>
	</div>
</form>

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
