<script lang="ts">
	import { page } from '$app/state';
	import { useLiveQuery } from '$lib/utils/liveQuery.svelte';
	import { db } from '$lib/db/schema';
	import { supabase } from '$lib/supabase/client';
	import { resolveConflictKeepMine, resolveConflictKeepTheirs } from '$lib/db/writeHelpers';
	import { diffFields, entityLabelFor, type FieldDiff } from '$lib/sync/conflictSummary';

	let groupId = $derived(page.params.groupId ?? '');

	interface ConflictRow {
		id: string;
		tableName: string;
		summary: string;
		fields: FieldDiff[];
	}

	interface ConflictsViewModel {
		conflicts: ConflictRow[];
		currentMemberId: string | null;
	}

	const viewModel = useLiveQuery<ConflictsViewModel>(async () => {
		const rows = await db.conflicts.where('groupId').equals(groupId).toArray();
		const unresolved = rows.filter((c) => c.resolvedAt === null);

		const {
			data: { user }
		} = await supabase.auth.getUser();
		const members = await db.members.where('groupId').equals(groupId).toArray();
		const me = members.find((m) => m.authUserId === user?.id);

		const conflicts: ConflictRow[] = unresolved.map((c) => {
			const mine = JSON.parse(c.localSnapshot);
			const theirs = c.remoteSnapshot ? JSON.parse(c.remoteSnapshot) : null;

			return {
				id: c.id,
				tableName: c.tableName,
				summary: entityLabelFor(c.tableName, mine),
				fields: diffFields(c.tableName, theirs, mine)
			};
		});

		return { conflicts, currentMemberId: me?.id ?? null };
	}, { conflicts: [], currentMemberId: null });

	let resolvingId = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	function generateId(): string {
		return crypto.randomUUID();
	}

	async function handleKeepMine(conflictId: string) {
		errorMessage = null;
		const memberId = viewModel.value.currentMemberId;
		if (!memberId) {
			errorMessage = "Couldn't determine your member record in this group.";
			return;
		}
		resolvingId = conflictId;
		try {
			await resolveConflictKeepMine(conflictId, memberId, generateId);
		} finally {
			resolvingId = null;
		}
	}

	async function handleKeepTheirs(conflictId: string) {
		errorMessage = null;
		resolvingId = conflictId;
		try {
			await resolveConflictKeepTheirs(conflictId);
		} finally {
			resolvingId = null;
		}
	}
</script>

<div class="mx-auto max-w-lg px-4 py-6">
	<h1 class="mb-1 font-display text-2xl text-ink">Conflicts</h1>
	<p class="mb-6 font-mono text-xs text-ink/50">
		Someone else changed these while you were offline too
	</p>

	{#if errorMessage}
		<p class="mb-4 text-sm text-debit">{errorMessage}</p>
	{/if}

	{#if viewModel.value.conflicts.length === 0}
		<div class="rounded-lg border border-dashed border-ink/20 bg-card py-12 text-center">
			<p class="font-display text-lg text-ink">All clear</p>
			<p class="text-sm text-ink/60">No unresolved conflicts in this group.</p>
		</div>
	{:else}
		<ul class="space-y-4">
			{#each viewModel.value.conflicts as conflict (conflict.id)}
				<li class="rounded-lg border border-debit/40 bg-card px-4 py-4">
					<p class="mb-3 font-display text-lg text-ink">{conflict.summary}</p>

					<div class="mb-4 space-y-2">
						{#each conflict.fields as field (field.label)}
							<div class="grid grid-cols-[auto_1fr_1fr] items-baseline gap-2 text-sm">
								<span class="text-ink/50">{field.label}</span>
								<span class={field.differs ? 'font-medium text-brass' : 'text-ink'}>
									{field.after}
								</span>
								<span class={field.differs ? 'font-medium text-debit' : 'text-ink'}>
									{field.before}
								</span>
							</div>
						{/each}
						<div class="grid grid-cols-[auto_1fr_1fr] gap-2 font-mono text-[10px] text-ink/40">
							<span></span>
							<span>yours</span>
							<span>theirs</span>
						</div>
					</div>

					<div class="flex gap-2">
						<button
							onclick={() => handleKeepMine(conflict.id)}
							disabled={resolvingId === conflict.id}
							class="flex-1 rounded bg-brass px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
						>
							Keep mine
						</button>
						<button
							onclick={() => handleKeepTheirs(conflict.id)}
							disabled={resolvingId === conflict.id}
							class="flex-1 rounded border border-ink/20 px-3 py-2 text-xs font-medium text-ink disabled:opacity-50"
						>
							Keep theirs
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>
