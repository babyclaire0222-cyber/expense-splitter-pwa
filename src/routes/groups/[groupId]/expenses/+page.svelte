<script lang="ts">
	import { page } from '$app/state';
	import { useLiveQuery } from '$lib/utils/liveQuery.svelte';
	import { db } from '$lib/db/schema';

	let groupId = $derived(page.params.groupId ?? '');

	interface ExpenseRow {
		id: string;
		description: string;
		amountCents: number;
		splitType: string;
		payerName: string;
		expenseDate: string;
		syncStatus: string;
	}

	const expenses = useLiveQuery<ExpenseRow[]>(async () => {
		const allExpenses = await db.expenses.where('groupId').equals(groupId).toArray();
		const activeExpenses = allExpenses.filter((e) => e.deletedAt === null);

		const members = await db.members.where('groupId').equals(groupId).toArray();
		const nameById = new Map(members.map((m) => [m.id, m.displayName]));

		return activeExpenses
			.sort((a, b) => b.expenseDate.localeCompare(a.expenseDate))
			.map((e) => ({
				id: e.id,
				description: e.description,
				amountCents: e.amountCents,
				splitType: e.splitType,
				payerName: nameById.get(e.paidByMemberId) ?? 'Unknown',
				expenseDate: e.expenseDate,
				syncStatus: e.syncStatus
			}));
	}, []);

	function formatCents(cents: number): string {
		return `$${(cents / 100).toFixed(2)}`;
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}
</script>

<div class="mx-auto max-w-lg px-4 py-6">
	<div class="mb-6 flex items-center justify-between">
		<h1 class="font-display text-2xl text-ink">Expenses</h1>
		<a href={`/groups/${groupId}/expenses/new`} class="rounded bg-brass px-4 py-2 text-sm font-medium text-white">Add expense</a>
	</div>

	{#if expenses.value.length === 0}
		<div class="rounded-lg border border-dashed border-ink/20 bg-card py-12 text-center">
			<p class="mb-1 font-display text-lg text-ink">No expenses yet</p>
			<p class="text-sm text-ink/60">Add the first one to start tracking balances.</p>
		</div>
	{:else}
		<ul class="space-y-2">
			{#each expenses.value as expense (expense.id)}
				<li>
					<a
						href={`/groups/${groupId}/expenses/${expense.id}/edit`}
						class="block rounded-lg border border-ink/10 bg-card px-4 py-3 hover:border-brass/40"
					>
						<div class="flex items-center justify-between">
							<span class="text-ink">{expense.description}</span>
							<span class="font-display text-ink">{formatCents(expense.amountCents)}</span>
						</div>
						<div class="mt-1 flex items-center justify-between font-mono text-xs text-ink/50">
							<span>{expense.payerName} paid - {formatDate(expense.expenseDate)}</span>
							{#if expense.syncStatus === 'pending'}
								<span class="text-brass">pending sync</span>
							{/if}
						</div>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>