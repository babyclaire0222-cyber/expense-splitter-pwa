<script lang="ts">
	import { page } from '$app/state';

	let { groupId }: { groupId: string } = $props();

	const tabs = $derived([
		{ label: 'Balances', href: `/groups/${groupId}` },
		{ label: 'Expenses', href: `/groups/${groupId}/expenses` },
		{ label: 'Settle', href: `/groups/${groupId}/settle` }
	]);
</script>

<nav class="fixed right-0 bottom-0 left-0 z-20 flex border-t border-ink/10 bg-card">
	{#each tabs as tab (tab.href)}
		{@const isActive = page.url.pathname === tab.href}
		<a href={tab.href} class="flex-1 py-3 text-center font-sans text-sm">
			<span class={isActive ? 'font-semibold text-brass' : 'text-ink/60'}>
				{tab.label}
			</span>
		</a>
	{/each}
</nav>