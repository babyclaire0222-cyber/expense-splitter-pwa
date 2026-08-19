<script lang="ts">
	import { page } from '$app/state';
	import { useLiveQuery } from '$lib/utils/liveQuery.svelte';
	import { db } from '$lib/db/schema';
	import { computeGroupBalances, type MemberBalance } from '$lib/ledger/balances';
	import { supabase } from '$lib/supabase/client';
	import { pullRemoteChanges } from '$lib/sync/syncEngine';
	import { dismissSyncNotification } from '$lib/db/writeHelpers';

	let groupId = $derived(page.params.groupId ?? '');

	interface PendingMember {
		id: string;
		displayName: string;
	}

	interface NotificationRow {
		id: string;
		summary: string;
		resolvedByName: string;
		createdAt: string;
	}

	interface BalancesViewModel {
		groupName: string | null;
		balances: (MemberBalance & { displayName: string })[];
		currentAuthUserId: string | null;
		isCreator: boolean;
		pendingMembers: PendingMember[];
		notifications: NotificationRow[];
	}

	let actionInProgressId = $state<string | null>(null);
	let dismissingId = $state<string | null>(null);

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

		const allSettlements = await db.settlements.where('groupId').equals(groupId).toArray();

		const rawBalances =
			activeExpenses.length > 0 || allSettlements.length > 0
				? computeGroupBalances(activeExpenses, splitsByExpenseId, allSettlements)
				: [];

		const members = await db.members.where('groupId').equals(groupId).toArray();
		const memberNameById = new Map(members.map((m) => [m.id, m.displayName]));

		const isCreator = members.some(
			(m) => m.authUserId === user?.id && m.role === 'creator' && m.status === 'approved'
		);

		const pendingMembers = members
			.filter((m) => m.status === 'pending' && m.deletedAt === null)
			.map((m) => ({ id: m.id, displayName: m.displayName }));

		const allNotifications = await db.syncNotifications.where('groupId').equals(groupId).toArray();
		const notifications: NotificationRow[] = allNotifications
			.filter((n) => n.dismissedAt === null)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map((n) => ({
				id: n.id,
				summary: n.summary,
				resolvedByName: memberNameById.get(n.resolvedByMemberId) ?? 'Someone',
				createdAt: n.createdAt
			}));

		return {
			groupName: group?.name ?? null,
			balances: rawBalances.map((b) => ({
				...b,
				displayName: memberNameById.get(b.memberId) ?? 'Unknown member'
			})),
			currentAuthUserId: user?.id ?? null,
			isCreator,
			pendingMembers,
			notifications
		};
	}, {
		groupName: null,
		balances: [],
		currentAuthUserId: null,
		isCreator: false,
		pendingMembers: [],
		notifications: []
	});

	function formatCents(cents: number): string {
		const dollars = Math.abs(cents) / 100;
		return `$${dollars.toFixed(2)}`;
	}

	function formatRelativeTime(iso: string): string {
		const diffMs = Date.now() - new Date(iso).getTime();
		const minutes = Math.round(diffMs / 60000);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes} min ago`;
		const hours = Math.round(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	async function handleApprove(memberId: string) {
		actionInProgressId = memberId;
		const {
			data: { user }
		} = await supabase.auth.getUser();

		await supabase
			.from('members')
			.update({ status: 'approved', approved_at: new Date().toISOString(), approved_by: user?.id })
			.eq('id', memberId);

		await pullRemoteChanges();
		actionInProgressId = null;
	}

	async function handleReject(memberId: string) {
		actionInProgressId = memberId;

		await supabase.from('members').update({ status: 'rejected' }).eq('id', memberId);

		await pullRemoteChanges();
		actionInProgressId = null;
	}

	async function handleDismissNotification(notificationId: string) {
		dismissingId = notificationId;
		try {
			await dismissSyncNotification(notificationId);
		} finally {
			dismissingId = null;
		}
	}
</script>

<div class="mx-auto max-w-lg px-4 py-6">
	<h1 class="mb-1 font-display text-2xl text-ink">{viewModel.value.groupName ?? 'Loading...'}</h1>
	<p class="mb-6 font-mono text-xs text-ink/50">Balances</p>

	{#if viewModel.value.notifications.length > 0}
		<div class="mb-6 space-y-2">
			{#each viewModel.value.notifications as notification (notification.id)}
				<div class="flex items-start justify-between gap-3 rounded-lg border border-brass/40 bg-card px-4 py-3">
					<div>
						<p class="text-sm text-ink">
							<span class="font-medium">{notification.resolvedByName}</span>
							<span class="text-ink/60">resolved a sync conflict —</span>
							{notification.summary}
						</p>
						<p class="mt-1 font-mono text-[10px] text-ink/40">
							{formatRelativeTime(notification.createdAt)} · not an ordinary refresh, someone's edit was overridden
						</p>
					</div>
					<button
						onclick={() => handleDismissNotification(notification.id)}
						disabled={dismissingId === notification.id}
						class="shrink-0 text-xs text-ink/50 hover:text-ink disabled:opacity-50"
					>
						Dismiss
					</button>
				</div>
			{/each}
		</div>
	{/if}

	{#if viewModel.value.isCreator && viewModel.value.pendingMembers.length > 0}
		<div class="mb-6 rounded-lg border border-brass/40 bg-card px-4 py-3">
			<p class="mb-3 text-sm font-medium text-ink">Pending requests</p>
			<ul class="space-y-2">
				{#each viewModel.value.pendingMembers as pending (pending.id)}
					<li class="flex items-center justify-between">
						<span class="text-ink">{pending.displayName}</span>
						<div class="flex gap-2">
							<button
								onclick={() => handleApprove(pending.id)}
								disabled={actionInProgressId === pending.id}
								class="rounded bg-credit px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
							>
								Approve
							</button>
							<button
								onclick={() => handleReject(pending.id)}
								disabled={actionInProgressId === pending.id}
								class="rounded border border-ink/20 px-3 py-1 text-xs font-medium text-ink disabled:opacity-50"
							>
								Reject
							</button>
						</div>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

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

		<p class="text-center font-mono text-xs text-ink/40">Green = owed to them &middot; Red = they owe</p>
	{/if}
</div>
