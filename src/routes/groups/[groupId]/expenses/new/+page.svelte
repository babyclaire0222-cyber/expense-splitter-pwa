<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { db } from '$lib/db/schema';
	import { supabase } from '$lib/supabase/client';
	import { createExpenseLocal } from '$lib/db/writeHelpers';
	import { computeEqualSplit } from '$lib/ledger/splitEngine';

	let groupId = $derived(page.params.groupId ?? '');

	interface MemberOption {
		id: string;
		displayName: string;
	}

	let members = $state<MemberOption[]>([]);
	let currentMemberId = $state<string | null>(null);

	let description = $state('');
	let amountDollars = $state('');
	let paidByMemberId = $state('');
	let includedMemberIds = $state<Set<string>>(new Set());
	let errorMessage = $state<string | null>(null);
	let isSubmitting = $state(false);

	$effect(() => {
		if (!groupId) return;

		(async () => {
			const groupMembers = await db.members.where('groupId').equals(groupId).toArray();
			const approved = groupMembers.filter((m) => m.status === 'approved' && m.deletedAt === null);

			members = approved.map((m) => ({ id: m.id, displayName: m.displayName }));
			includedMemberIds = new Set(approved.map((m) => m.id));

			const {
				data: { user }
			} = await supabase.auth.getUser();
			const me = approved.find((m) => m.authUserId === user?.id);

			if (me) {
				currentMemberId = me.id;
				paidByMemberId = me.id;
			} else if (approved.length > 0) {
				paidByMemberId = approved[0].id;
			}
		})();
	});

	function toggleMember(memberId: string) {
		const next = new Set(includedMemberIds);
		if (next.has(memberId)) {
			next.delete(memberId);
		} else {
			next.add(memberId);
		}
		includedMemberIds = next;
	}

	function generateId(): string {
		return crypto.randomUUID();
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		errorMessage = null;

		const amountCents = Math.round(parseFloat(amountDollars) * 100);

		if (!description.trim()) {
			errorMessage = 'Enter a description.';
			return;
		}
		if (!Number.isFinite(amountCents) || amountCents <= 0) {
			errorMessage = 'Enter a valid amount greater than zero.';
			return;
		}
		if (!paidByMemberId) {
			errorMessage = 'Choose who paid.';
			return;
		}
		if (includedMemberIds.size === 0) {
			errorMessage = 'Select at least one member to split with.';
			return;
		}

		isSubmitting = true;

		try {
			const computedShares = computeEqualSplit({
				amountCents,
				memberIds: Array.from(includedMemberIds)
			});

			const timestamp = new Date().toISOString();
			const expenseId = generateId();

			await createExpenseLocal(
				{
					id: expenseId,
					groupId,
					description: description.trim(),
					amountCents,
					currency: 'USD',
					paidByMemberId,
					splitType: 'equal',
					expenseDate: timestamp,
					createdByMemberId: currentMemberId ?? paidByMemberId,
					reversalOfExpenseId: null
				},
				computedShares.map((share) => ({
					id: generateId(),
					expenseId,
					memberId: share.memberId,
					shareCents: share.shareCents,
					sharePercentage: share.sharePercentage
				})),
				generateId
			);

			await goto(`/groups/${groupId}/expenses`);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Something went wrong.';
			isSubmitting = false;
		}
	}
</script>

<div class="mx-auto max-w-lg px-4 py-6">
	<h1 class="mb-6 font-display text-2xl text-ink">Add expense</h1>

	<form onsubmit={handleSubmit} class="space-y-4">
		<label class="block">
			<span class="mb-1 block text-sm text-ink/70">Description</span>
			<input type="text" bind:value={description} class="w-full rounded border border-ink/20 bg-white px-3 py-2 text-ink" placeholder="Dinner, taxi, groceries..." />
		</label>

		<label class="block">
			<span class="mb-1 block text-sm text-ink/70">Amount</span>
			<input type="number" step="0.01" min="0" bind:value={amountDollars} class="w-full rounded border border-ink/20 bg-white px-3 py-2 font-display text-ink" placeholder="0.00" />
		</label>

		<label class="block">
			<span class="mb-1 block text-sm text-ink/70">Paid by</span>
			<select bind:value={paidByMemberId} class="w-full rounded border border-ink/20 bg-white px-3 py-2 text-ink">
				{#each members as member (member.id)}
					<option value={member.id}>{member.id === currentMemberId ? 'You' : member.displayName}</option>
				{/each}
			</select>
		</label>

		<div>
			<span class="mb-2 block text-sm text-ink/70">Split equally between</span>
			<div class="space-y-2">
				{#each members as member (member.id)}
					<label class="flex items-center gap-2 rounded border border-ink/10 bg-card px-3 py-2">
						<input type="checkbox" checked={includedMemberIds.has(member.id)} onchange={() => toggleMember(member.id)} />
						<span class="text-ink">{member.id === currentMemberId ? 'You' : member.displayName}</span>
					</label>
				{/each}
			</div>
		</div>

		{#if errorMessage}
			<p class="text-sm text-debit">{errorMessage}</p>
		{/if}

		<button type="submit" disabled={isSubmitting} class="w-full rounded bg-brass px-4 py-2 font-medium text-white disabled:opacity-50">
			{isSubmitting ? 'Saving...' : 'Save expense'}
		</button>
	</form>
</div>