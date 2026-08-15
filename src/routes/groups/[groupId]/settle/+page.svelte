<script lang="ts">
	import { page } from '$app/state';
	import { useLiveQuery } from '$lib/utils/liveQuery.svelte';
	import { db } from '$lib/db/schema';
	import { computeGroupBalances } from '$lib/ledger/balances';
	import { simplifyDebts, type SettlementTransfer } from '$lib/ledger/debtSimplifier';

	let groupId = $derived(page.params.groupId ?? '');

	interface SettleViewModel {
		transfers: (SettlementTransfer & { fromName: string; toName: string })[];
		isSettled: boolean;
		hasExpenses: boolean;
	}

	const viewModel = useLiveQuery<SettleViewModel>(async () => {
		const allExpenses = await db.expenses.where('groupId').equals(groupId).toArray();
		const activeExpenses = allExpenses.filter((e) => e.deletedAt === null);

		if (activeExpenses.length === 0) {
			return { transfers: [], isSettled: false, hasExpenses: false };
		}

		const allSplits = await db.splits.toArray();
		const splitsByExpenseId = new Map<string, typeof allSplits>();
		for (const split of allSplits) {
			const list = splitsByExpenseId.get(split.expenseId) ?? [];
			list.push(split);
			splitsByExpenseId.set(split.expenseId, list);
		}

		const balances = computeGroupBalances(activeExpenses, splitsByExpenseId);
		const rawTransfers = simplifyDebts(balances);

		const members = await db.members.where('groupId').equals(groupId).toArray();
		const nameById = new Map(members.map((m) => [m.id, m.displayName]));

		return {
			transfers: rawTransfers.map((t) => ({
				...t,
				fromName: nameById.get(t.fromMemberId) ?? 'Unknown',
				toName: nameById.get(t.toMemberId) ?? 'Unknown'
			})),
			isSettled: rawTransfers.length === 0,
			hasExpenses: true
		};
	}, { transfers: [], isSettled: false, hasExpenses: false });

	function formatCents(cents: number): string {
		return `$${(cents / 100).toFixed(2)}`;
	}
</script>

<div class="mx-auto max-w-lg px-4 py-6">
	<h1 class="mb-1 font-display text-2xl text-ink">Settle up</h1>
	<p class="mb-6 font-mono text-xs text-ink/50">Fewest payments to balance the group</p>

	{#if !viewModel.value.hasExpenses}
		<div class="rounded-lg border border-dashed border-ink/20 bg-card py-12 text-center">
			<p class="font-display text-lg text-ink">Nothing to settle</p>
			<p class="text-sm text-ink/60">Add an expense first.</p>
		</div>
	{:else if viewModel.value.isSettled}
		<div class="flex flex-col items-center justify-center rounded-lg border border-ink/10 bg-card py-16">
			<div class="rotate-[-6deg] rounded border-4 border-credit px-6 py-3">
				<span class="font-display text-3xl font-bold tracking-widest text-credit">SETTLED</span>
			</div>
			<p class="mt-4 text-sm text-ink/60">Everyone's square. Nice.</p>
		</div>
	{:else}
		<ul class="space-y-2">
			{#each viewModel.value.transfers as transfer, i (i)}
				<li class="rounded-lg border border-ink/10 bg-card px-4 py-3">
					<p class="text-ink">
						<span class="font-medium">{transfer.fromName}</span>
						<span class="text-ink/50">pays</span>
						<span class="font-medium">{transfer.toName}</span>
					</p>
					<p class="font-display text-lg text-brass">{formatCents(transfer.amountCents)}</p>
				</li>
			{/each}
		</ul>

		<hr class="stub-tear" />

		<p class="text-center font-mono text-xs text-ink/40">
			{viewModel.value.transfers.length} {viewModel.value.transfers.length === 1 ? 'payment' : 'payments'} to settle everyone up
		</p>
	{/if}
</div>