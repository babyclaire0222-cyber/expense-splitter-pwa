<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { db } from '$lib/db/schema';
	import { supabase } from '$lib/supabase/client';
	import { createExpenseLocal } from '$lib/db/writeHelpers';
	import { computeEqualSplit, computePercentageSplit, computeCustomSplit, SplitValidationError } from '$lib/ledger/splitEngine';
	import type { SplitType } from '$lib/db/types';

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
	let splitType = $state<SplitType>('equal');
	let includedMemberIds = $state<Set<string>>(new Set());
	let percentageByMemberId = $state<Record<string, string>>({});
	let customDollarsByMemberId = $state<Record<string, string>>({});
	let errorMessage = $state<string | null>(null);
	let isSubmitting = $state(false);

	$effect(() => {
		if (!groupId) return;

		(async () => {
			const groupMembers = await db.members.where('groupId').equals(groupId).toArray();
			const approved = groupMembers.filter((m) => m.status === 'approved' && m.deletedAt === null);

			members = approved.map((m) => ({ id: m.id, displayName: m.displayName }));
			includedMemberIds = new Set(approved.map((m) => m.id));

			const evenPercentage = (100 / approved.length).toFixed(2);
			const pctInit: Record<string, string> = {};
			for (const m of approved) pctInit[m.id] = evenPercentage;
			percentageByMemberId = pctInit;

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

	function amountCentsValue(): number {
		return Math.round(parseFloat(amountDollars || '0') * 100);
	}

	let percentageTotal = $derived(
		Array.from(includedMemberIds).reduce(
			(acc, id) => acc + (parseFloat(percentageByMemberId[id] ?? '0') || 0),
			0
		)
	);

	let customTotalCents = $derived(
		Array.from(includedMemberIds).reduce(
			(acc, id) => acc + Math.round((parseFloat(customDollarsByMemberId[id] ?? '0') || 0) * 100),
			0
		)
	);

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		errorMessage = null;

		const amountCents = amountCentsValue();

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
			let computedShares;

			if (splitType === 'equal') {
				computedShares = computeEqualSplit({
					amountCents,
					memberIds: Array.from(includedMemberIds)
				});
			} else if (splitType === 'percentage') {
				computedShares = computePercentageSplit({
					amountCents,
					shares: Array.from(includedMemberIds).map((id) => ({
						memberId: id,
						percentage: parseFloat(percentageByMemberId[id] ?? '0') || 0
					}))
				});
			} else {
				computedShares = computeCustomSplit({
					amountCents,
					shares: Array.from(includedMemberIds).map((id) => ({
						memberId: id,
						shareCents: Math.round((parseFloat(customDollarsByMemberId[id] ?? '0') || 0) * 100)
					}))
				});
			}

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
					splitType,
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
			if (err instanceof SplitValidationError) {
				errorMessage = err.message;
			} else {
				errorMessage = err instanceof Error ? err.message : 'Something went wrong.';
			}
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
			<span class="mb-2 block text-sm text-ink/70">Split type</span>
			<div class="flex gap-2">
				<button type="button" onclick={() => (splitType = 'equal')} class="flex-1 rounded border px-3 py-2 text-sm {splitType === 'equal' ? 'border-brass bg-brass text-white' : 'border-ink/20 text-ink'}">Equal</button>
				<button type="button" onclick={() => (splitType = 'percentage')} class="flex-1 rounded border px-3 py-2 text-sm {splitType === 'percentage' ? 'border-brass bg-brass text-white' : 'border-ink/20 text-ink'}">Percentage</button>
				<button type="button" onclick={() => (splitType = 'custom')} class="flex-1 rounded border px-3 py-2 text-sm {splitType === 'custom' ? 'border-brass bg-brass text-white' : 'border-ink/20 text-ink'}">Custom</button>
			</div>
		</div>

		{#if splitType === 'equal'}
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
		{:else if splitType === 'percentage'}
			<div>
				<span class="mb-2 block text-sm text-ink/70">Percentage per member</span>
				<div class="space-y-2">
					{#each members as member (member.id)}
						<div class="flex items-center gap-2 rounded border border-ink/10 bg-card px-3 py-2">
							<input type="checkbox" checked={includedMemberIds.has(member.id)} onchange={() => toggleMember(member.id)} />
							<span class="flex-1 text-ink">{member.id === currentMemberId ? 'You' : member.displayName}</span>
							{#if includedMemberIds.has(member.id)}
								<input
									type="number"
									step="0.01"
									class="w-20 rounded border border-ink/20 bg-white px-2 py-1 text-right text-ink"
									value={percentageByMemberId[member.id] ?? ''}
									oninput={(e) => (percentageByMemberId = { ...percentageByMemberId, [member.id]: e.currentTarget.value })}
								/>
								<span class="text-ink/50">%</span>
							{/if}
						</div>
					{/each}
				</div>
				<p class="mt-2 text-right font-mono text-xs {Math.abs(percentageTotal - 100) < 0.5 ? 'text-credit' : 'text-debit'}">
					Total: {percentageTotal.toFixed(2)}%
				</p>
			</div>
		{:else}
			<div>
				<span class="mb-2 block text-sm text-ink/70">Amount per member</span>
				<div class="space-y-2">
					{#each members as member (member.id)}
						<div class="flex items-center gap-2 rounded border border-ink/10 bg-card px-3 py-2">
							<input type="checkbox" checked={includedMemberIds.has(member.id)} onchange={() => toggleMember(member.id)} />
							<span class="flex-1 text-ink">{member.id === currentMemberId ? 'You' : member.displayName}</span>
							{#if includedMemberIds.has(member.id)}
								<span class="text-ink/50">$</span>
								<input
									type="number"
									step="0.01"
									class="w-24 rounded border border-ink/20 bg-white px-2 py-1 text-right text-ink"
									value={customDollarsByMemberId[member.id] ?? ''}
									oninput={(e) => (customDollarsByMemberId = { ...customDollarsByMemberId, [member.id]: e.currentTarget.value })}
								/>
							{/if}
						</div>
					{/each}
				</div>
				<p class="mt-2 text-right font-mono text-xs {customTotalCents === amountCentsValue() ? 'text-credit' : 'text-debit'}">
					Total: ${(customTotalCents / 100).toFixed(2)} of ${(amountCentsValue() / 100).toFixed(2)}
				</p>
			</div>
		{/if}

		{#if errorMessage}
			<p class="text-sm text-debit">{errorMessage}</p>
		{/if}

		<button type="submit" disabled={isSubmitting} class="w-full rounded bg-brass px-4 py-2 font-medium text-white disabled:opacity-50">
			{isSubmitting ? 'Saving...' : 'Save expense'}
		</button>
	</form>
</div>