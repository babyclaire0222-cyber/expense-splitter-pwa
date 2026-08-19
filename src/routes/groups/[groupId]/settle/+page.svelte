<script lang="ts">
	import { page } from '$app/state';
	import { useLiveQuery } from '$lib/utils/liveQuery.svelte';
	import { db } from '$lib/db/schema';
	import { supabase } from '$lib/supabase/client';
	import { computeGroupBalances } from '$lib/ledger/balances';
	import { simplifyDebts, type SettlementTransfer } from '$lib/ledger/debtSimplifier';
	import { recordSettlementLocal, deleteSettlementLocal } from '$lib/db/writeHelpers';

	let groupId = $derived(page.params.groupId ?? '');

	interface RecentSettlement {
		id: string;
		fromName: string;
		toName: string;
		amountCents: number;
		settledAt: string;
	}

	interface SettleViewModel {
		transfers: (SettlementTransfer & { fromName: string; toName: string })[];
		isSettled: boolean;
		hasExpenses: boolean;
		currentMemberId: string | null;
		recent: RecentSettlement[];
	}

	let recordingKey = $state<string | null>(null);
	let undoingId = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	const viewModel = useLiveQuery<SettleViewModel>(async () => {
		const allExpenses = await db.expenses.where('groupId').equals(groupId).toArray();
		const activeExpenses = allExpenses.filter((e) => e.deletedAt === null);

		const allSplits = await db.splits.toArray();
		const splitsByExpenseId = new Map<string, typeof allSplits>();
		for (const split of allSplits) {
			const list = splitsByExpenseId.get(split.expenseId) ?? [];
			list.push(split);
			splitsByExpenseId.set(split.expenseId, list);
		}

		const allSettlements = await db.settlements.where('groupId').equals(groupId).toArray();
		const activeSettlements = allSettlements.filter((s) => s.deletedAt === null);

		const members = await db.members.where('groupId').equals(groupId).toArray();
		const nameById = new Map(members.map((m) => [m.id, m.displayName]));

		const {
			data: { user }
		} = await supabase.auth.getUser();
		const me = members.find((m) => m.authUserId === user?.id);

		const recent: RecentSettlement[] = activeSettlements
			.sort((a, b) => b.settledAt.localeCompare(a.settledAt))
			.slice(0, 10)
			.map((s) => ({
				id: s.id,
				fromName: nameById.get(s.fromMemberId) ?? 'Unknown',
				toName: nameById.get(s.toMemberId) ?? 'Unknown',
				amountCents: s.amountCents,
				settledAt: s.settledAt
			}));

		if (activeExpenses.length === 0 && activeSettlements.length === 0) {
			return {
				transfers: [],
				isSettled: false,
				hasExpenses: false,
				currentMemberId: me?.id ?? null,
				recent
			};
		}

		const balances = computeGroupBalances(activeExpenses, splitsByExpenseId, activeSettlements);
		const rawTransfers = simplifyDebts(balances);

		return {
			transfers: rawTransfers.map((t) => ({
				...t,
				fromName: nameById.get(t.fromMemberId) ?? 'Unknown',
				toName: nameById.get(t.toMemberId) ?? 'Unknown'
			})),
			isSettled: rawTransfers.length === 0,
			hasExpenses: true,
			currentMemberId: me?.id ?? null,
			recent
		};
	}, { transfers: [], isSettled: false, hasExpenses: false, currentMemberId: null, recent: [] });

	function formatCents(cents: number): string {
		return `$${(cents / 100).toFixed(2)}`;
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function generateId(): string {
		return crypto.randomUUID();
	}

	async function handleRecord(transfer: SettlementTransfer & { fromName: string; toName: string }) {
		errorMessage = null;
		const key = `${transfer.fromMemberId}-${transfer.toMemberId}`;

		if (
			!confirm(
				`Record that ${transfer.fromName} paid ${transfer.toName} ${formatCents(transfer.amountCents)}?`
			)
		) {
			return;
		}

		const recordedByMemberId = viewModel.value.currentMemberId;
		if (!recordedByMemberId) {
			errorMessage = "Couldn't determine your member record in this group.";
			return;
		}

		recordingKey = key;
		try {
			await recordSettlementLocal(
				groupId,
				transfer.fromMemberId,
				transfer.toMemberId,
				transfer.amountCents,
				recordedByMemberId,
				generateId
			);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Could not record payment.';
		} finally {
			recordingKey = null;
		}
	}

	async function handleUndo(settlementId: string) {
		if (!confirm('Undo this recorded payment?')) return;
		errorMessage = null;
		undoingId = settlementId;
		try {
			await deleteSettlementLocal(settlementId, generateId);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Could not undo.';
		} finally {
			undoingId = null;
		}
	}
</script>

<div class="mx-auto max-w-lg px-4 py-6">
	<h1 class="mb-1 font-display text-2xl text-ink">Settle up</h1>
	<p class="mb-6 font-mono text-xs text-ink/50">Fewest payments to balance the group</p>

	{#if errorMessage}
		<p class="mb-4 text-sm text-debit">{errorMessage}</p>
	{/if}

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
				{@const key = `${transfer.fromMemberId}-${transfer.toMemberId}`}
				<li class="rounded-lg border border-ink/10 bg-card px-4 py-3">
					<div class="flex items-center justify-between">
						<div>
							<p class="text-ink">
								<span class="font-medium">{transfer.fromName}</span>
								<span class="text-ink/50">pays</span>
								<span class="font-medium">{transfer.toName}</span>
							</p>
							<p class="font-display text-lg text-brass">{formatCents(transfer.amountCents)}</p>
						</div>
						<button
							onclick={() => handleRecord(transfer)}
							disabled={recordingKey === key}
							class="rounded bg-credit px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
						>
							{recordingKey === key ? 'Recording…' : 'Mark as paid'}
						</button>
					</div>
				</li>
			{/each}
		</ul>

		<hr class="stub-tear" />

		<p class="text-center font-mono text-xs text-ink/40">
			{viewModel.value.transfers.length} {viewModel.value.transfers.length === 1 ? 'payment' : 'payments'} to settle everyone up
		</p>
	{/if}

	{#if viewModel.value.recent.length > 0}
		<div class="mt-8">
			<p class="mb-2 text-sm font-medium text-ink">Recently settled</p>
			<ul class="space-y-2">
				{#each viewModel.value.recent as settlement (settlement.id)}
					<li class="flex items-center justify-between rounded-lg border border-ink/10 bg-card px-4 py-2">
						<div>
							<p class="text-sm text-ink">
								<span class="font-medium">{settlement.fromName}</span>
								<span class="text-ink/50">paid</span>
								<span class="font-medium">{settlement.toName}</span>
							</p>
							<p class="font-mono text-xs text-ink/40">{formatDate(settlement.settledAt)}</p>
						</div>
						<div class="flex items-center gap-2">
							<span class="font-display text-sm text-ink">{formatCents(settlement.amountCents)}</span>
							<button
								onclick={() => handleUndo(settlement.id)}
								disabled={undoingId === settlement.id}
								class="text-xs text-debit hover:underline disabled:opacity-50"
							>
								{undoingId === settlement.id ? '…' : 'Undo'}
							</button>
						</div>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>