<script lang="ts">
	import { page } from '$app/state';
	import { useLiveQuery } from '$lib/utils/liveQuery.svelte';
	import { db } from '$lib/db/schema';
	import { computeGroupBalances, type MemberBalance } from '$lib/ledger/balances';
	import { supabase } from '$lib/supabase/client';

	let groupId = $derived(page.params.groupId ?? '');

	interface BalancesViewModel {
		groupName: string | null;
		balances: (MemberBalance & { displayName: string })[];
		currentAuthUserId: string | null;
	}

	const viewModel = useLiveQuery<BalancesViewModel>(async () => {
		const {
			data: { user }
		} = await supabase.auth.getUser();

		const group = await db.groups.get(groupId);
		const allExpenses = await db.expenses.where('groupId').equals(groupId).toArray();
		const activeExpenses = allExpenses.filter((e) => e.deletedAt === null);

		const allSplits = await db.splits.toArray();
		const splitsByExpenseId = new Map<string, typeof allSplits>();
		for (const split of allSplits) {
			const list = splitsByExpenseId.get(split.expenseId) ?? [];
			list.push(split);
			splitsByExpenseId.set(split.expenseId, list);
		}

		const rawBalances =
			activeExpenses.length > 0 ? computeGroupBalances(activeExpenses, splitsByExpenseId) : [];

		const members = await db.members.where('groupId').equals(groupId).toArray();
        const memberNameById = new Map(members.map((m) => [m.id, m.displayName]));
		return {
			groupName: group?.name ?? null,
			balances: rawBalances.map((b) => ({
				...b,
				displayName: memberNameById.get(b.memberId) ?? 'Unknown member'
			})),
			currentAuthUserId: user?.id ?? null
		};
	}, { groupName: null, balances: [], currentAuthUserId: null });

	function formatCents(cents: number): string {
		const dollars = Math.abs(cents) / 100;
		return `$${dollars.toFixed(2)}`;
	}
</script>

<div class="mx-auto max-w-lg px-4 py-6">
	<h1 class="mb-1 font-display text-2xl text-ink">{viewModel.value.groupName ?? 'Loading...'}</h1>
	<p class="mb-6 font-mono text-xs text-ink/50">Balances</p>

	{#if viewModel.value.balances.length === 0}
		<div class="rounded-lg border border-dashed border-ink/20 bg-card py-12 text-center">
			<p class="font-display text-lg text-ink">No expenses yet</p>
			<p class="text-sm text-ink/60">Add one from the Expenses tab to see balances here.</p>
		</div>
	{:else}
		<ul class="space-y-2">
			{#each viewModel.value.balances as balance (balance.memberId)}
				<li class="flex items-center justify-between rounded-lg border border-ink/10 bg-card px-4 py-3">
					<span class="text-ink">{balance.displayName}</span>
					{#if balance.netCents > 0}
						<span class="font-display text-credit">+{formatCents(balance.netCents)}</span>
					{:else if balance.netCents < 0}
						<span class="font-display text-debit">-{formatCents(balance.netCents)}</span>
					{:else}
						<span class="font-display text-ink/40">Settled</span>
					{/if}
				</li>
			{/each}
		</ul>

		<hr class="stub-tear" />

		<p class="text-center font-mono text-xs text-ink/40">
			Green = owed to them &middot; Red = they owe
		</p>
	{/if}
</div>