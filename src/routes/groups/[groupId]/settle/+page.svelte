<script lang="ts">
	import { page } from '$app/state';
	import { useLiveQuery } from '$lib/utils/liveQuery.svelte';
	import { db } from '$lib/db/schema';
	import { supabase } from '$lib/supabase/client';
	import { computeGroupBalances } from '$lib/ledger/balances';
	import { simplifyDebts, type SettlementTransfer } from '$lib/ledger/debtSimplifier';
	import { recordSettlementLocal, deleteSettlementLocal, findPossibleDuplicateSettlement } from '$lib/db/writeHelpers';

	let groupId = $derived(page.params.groupId ?? '');

	interface MemberOption {
		id: string;
		displayName: string;
	}

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
		members: MemberOption[];
	}

	let recordingKey = $state<string | null>(null);
	let undoingId = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	// Manual "Add a payment" form state — separate from the suggested-
	// transfer "Mark as paid" flow, but calls the exact same underlying
	// write path (recordSettlementLocal), so it gets the same duplicate
	// warning and server-side dedup protection for free.
	let showAddForm = $state(false);
	let addFromMemberId = $state('');
	let addToMemberId = $state('');
	let addAmountDollars = $state('');
	let addingPayment = $state(false);

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

		const allMembers = await db.members.where('groupId').equals(groupId).toArray();
		const approvedMembers = allMembers.filter((m) => m.status === 'approved' && m.deletedAt === null);
		const nameById = new Map(approvedMembers.map((m) => [m.id, m.displayName]));
		const members: MemberOption[] = approvedMembers.map((m) => ({ id: m.id, displayName: m.displayName }));

		const {
			data: { user }
		} = await supabase.auth.getUser();
		const me = approvedMembers.find((m) => m.authUserId === user?.id);

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
				recent,
				members
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
			recent,
			members
		};
	}, { transfers: [], isSettled: false, hasExpenses: false, currentMemberId: null, recent: [], members: [] });

	function formatCents(cents: number): string {
		return `$${(cents / 100).toFixed(2)}`;
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function generateId(): string {
		return crypto.randomUUID();
	}

	function nameFor(memberId: string): string {
		return viewModel.value.members.find((m) => m.id === memberId)?.displayName ?? 'Unknown';
	}

	async function recordWithDuplicateCheck(
		fromMemberId: string,
		toMemberId: string,
		amountCents: number
	): Promise<void> {
		const fromName = nameFor(fromMemberId);
		const toName = nameFor(toMemberId);

		// Settlements are insert-only with fresh UUIDs, so this device can't
		// detect a payment another device recorded while BOTH were offline —
		// only what's already synced down locally. Still catches the common
		// case (accidental double-tap, or someone else's payment that
		// already synced in).
		const possibleDuplicate = await findPossibleDuplicateSettlement(
			groupId,
			fromMemberId,
			toMemberId,
			amountCents
		);

		const confirmMessage = possibleDuplicate
			? `${fromName} already appears to have paid ${toName} ${formatCents(amountCents)} recently. Record it again anyway?`
			: `Record that ${fromName} paid ${toName} ${formatCents(amountCents)}?`;

		if (!confirm(confirmMessage)) return;

		const recordedByMemberId = viewModel.value.currentMemberId;
		if (!recordedByMemberId) {
			errorMessage = "Couldn't determine your member record in this group.";
			return;
		}

		await recordSettlementLocal(
			groupId,
			fromMemberId,
			toMemberId,
			amountCents,
			recordedByMemberId,
			generateId
		);
	}

	async function handleRecord(transfer: SettlementTransfer & { fromName: string; toName: string }) {
		errorMessage = null;
		const key = `${transfer.fromMemberId}-${transfer.toMemberId}`;
		recordingKey = key;
		try {
			await recordWithDuplicateCheck(transfer.fromMemberId, transfer.toMemberId, transfer.amountCents);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Could not record payment.';
		} finally {
			recordingKey = null;
		}
	}

	async function handleAddPayment(event: SubmitEvent) {
		event.preventDefault();
		errorMessage = null;

		if (!addFromMemberId || !addToMemberId) {
			errorMessage = 'Choose who paid and who received it.';
			return;
		}
		if (addFromMemberId === addToMemberId) {
			errorMessage = "Payer and recipient can't be the same person.";
			return;
		}
		const amountCents = Math.round(parseFloat(addAmountDollars || '0') * 100);
		if (!Number.isFinite(amountCents) || amountCents <= 0) {
			errorMessage = 'Enter a valid amount greater than zero.';
			return;
		}

		addingPayment = true;
		try {
			await recordWithDuplicateCheck(addFromMemberId, addToMemberId, amountCents);
			addFromMemberId = '';
			addToMemberId = '';
			addAmountDollars = '';
			showAddForm = false;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Could not record payment.';
		} finally {
			addingPayment = false;
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
	<div class="mb-1 flex items-center justify-between">
		<h1 class="font-display text-2xl text-ink">Settle up</h1>
		<button
			onclick={() => (showAddForm = !showAddForm)}
			class="rounded border border-ink/20 px-3 py-1.5 text-xs font-medium text-ink hover:border-brass/40"
		>
			{showAddForm ? 'Cancel' : '+ Add a payment'}
		</button>
	</div>
	<p class="mb-6 font-mono text-xs text-ink/50">Fewest payments to balance the group</p>

	{#if errorMessage}
		<p class="mb-4 text-sm text-debit">{errorMessage}</p>
	{/if}

	{#if showAddForm}
		<form onsubmit={handleAddPayment} class="mb-6 space-y-3 rounded-lg border border-ink/10 bg-card p-4">
			<p class="text-sm font-medium text-ink">Record a payment</p>
			<p class="text-xs text-ink/50">
				For any payment that isn't one of the suggestions below — any amount, any pair of members.
			</p>

			<div class="flex items-center gap-2">
				<select
					bind:value={addFromMemberId}
					class="flex-1 rounded border border-ink/20 bg-white px-2 py-2 text-sm text-ink"
				>
					<option value="" disabled selected>Who paid?</option>
					{#each viewModel.value.members as member (member.id)}
						<option value={member.id}>{member.displayName}</option>
					{/each}
				</select>
				<span class="text-xs text-ink/40">paid</span>
				<select
					bind:value={addToMemberId}
					class="flex-1 rounded border border-ink/20 bg-white px-2 py-2 text-sm text-ink"
				>
					<option value="" disabled selected>Who received it?</option>
					{#each viewModel.value.members as member (member.id)}
						<option value={member.id}>{member.displayName}</option>
					{/each}
				</select>
			</div>

			<label class="block">
				<span class="mb-1 block text-xs text-ink/60">Amount</span>
				<input
					type="number"
					step="0.01"
					min="0"
					bind:value={addAmountDollars}
					placeholder="0.00"
					class="w-full rounded border border-ink/20 bg-white px-3 py-2 font-display text-ink"
				/>
			</label>

			<button
				type="submit"
				disabled={addingPayment}
				class="w-full rounded bg-brass px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
			>
				{addingPayment ? 'Recording…' : 'Record payment'}
			</button>
		</form>
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