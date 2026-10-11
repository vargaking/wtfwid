<script lang="ts">
	import type { NodeState, Stage } from './model';

	interface Props {
		state: NodeState;
		/** null draws a counted cluster */
		stage: Stage | null;
		count?: number;
		selected?: boolean;
		small?: boolean;
		/** Something is happening on it right now: the mark breathes (S-85). */
		alive?: boolean;
		/** Related to the ticket that is open (S-86). */
		linked?: boolean;
	}
	let { state, stage, count = 0, selected = false, small = false, alive = false, linked = false }: Props = $props();
</script>

<span
	aria-hidden="true"
	class="mark s-{state}"
	class:circle={stage === 'ticket'}
	class:diamond={stage === 'pr'}
	class:pill={stage === null}
	class:selected
	class:small
	class:alive
	class:linked
>
	{#if stage === null}{count}{/if}
</span>

<style>
	.mark {
		display: block;
		flex: none;
		box-sizing: border-box;
		width: 18px;
		height: 18px;
		background: var(--fill);
		border: 2px solid var(--stroke);
		border-radius: 4px;
		outline: 2px solid transparent;
		outline-offset: 3px;
	}
	.small {
		width: 12px;
		height: 12px;
		border-radius: 3px;
	}
	.circle {
		border-radius: 50%;
	}
	.diamond {
		border-radius: 2px;
		transform: rotate(45deg) scale(0.86);
	}
	.pill {
		width: auto;
		min-width: 30px;
		height: 22px;
		padding: 0 7px;
		border-radius: 11px;
		color: var(--on);
		font: 600 12px/18px var(--font-mono);
		text-align: center;
	}
	.pill.small {
		min-width: 22px;
		height: 16px;
		padding: 0 5px;
		border-radius: 8px;
		font: 600 10px/12px var(--font-mono);
	}
	.selected {
		outline-color: var(--color-ink);
	}
	.linked {
		outline: 1px solid var(--color-muted);
		outline-offset: 2px;
	}
	.alive {
		animation: breathe 2.4s ease-in-out infinite;
	}
	@keyframes breathe {
		0%,
		100% {
			box-shadow: 0 0 0 0 color-mix(in srgb, var(--stroke) 60%, transparent);
		}
		60% {
			box-shadow: 0 0 0 7px transparent;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.alive {
			animation: none;
		}
	}
</style>
