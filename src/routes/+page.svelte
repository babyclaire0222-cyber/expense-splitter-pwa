<script lang="ts">
	import { useLiveQuery } from '$lib/utils/liveQuery.svelte';
	import { db } from '$lib/db/schema';

	interface GroupWithMemberCount {
		id: string;
		name: string;
		joinCode: string;
		approvedMemberCount: number;
	}

	const groups = useLiveQuery<GroupWithMemberCount[]>(async () => {
		const allGroups = await db.groups.toArray();
		const allMembers = await db.members.toArray();

		return allGroups
			.filter((g) => g.deletedAt === null)
			.map((g) => ({
				id: g.id,
				name: g.name,
				joinCode: g.joinCode,
				approvedMemberCount: allMembers.filter(
					(m) => m.groupId === g.id && m.status === 'approved' && m.deletedAt === null
				).length
			}));
	}, []);
</script>

<div class="mx-auto max-w-lg px-4 py-6">
	<div class="mb-6 flex items-center justify-between">
		<h1 class="font-display text-2xl text-ink">Your groups</h1>
		<div class="flex gap-2">
	<a href="/groups/join" class="rounded border border-ink/20 px-4 py-2 text-sm font-medium text-ink">Join group</a>
	<a href="/groups/new" class="rounded bg-brass px-4 py-2 text-sm font-medium text-white">New group</a>
        </div>
        </div>


	{#if groups.value.length === 0}
		<div class="rounded-lg border border-dashed border-ink/20 bg-card py-12 text-center">
			<p class="mb-1 font-display text-lg text-ink">No groups yet</p>
			<p class="mb-4 text-sm text-ink/60">Start one for a trip, a household, or a night out.</p>
			<a href="/groups/new" class="text-sm font-medium text-brass hover:underline">Create your first group -&gt;</a>
		</div>
	{:else}
		<ul class="space-y-3">
			{#each groups.value as group (group.id)}
				<li>
					<a href={`/groups/${group.id}`} class="block rounded-lg border border-ink/10 bg-card px-4 py-4 hover:border-brass/40">
						<p class="font-display text-lg text-ink">{group.name}</p>
						<p class="font-mono text-xs text-ink/50">{group.approvedMemberCount} {group.approvedMemberCount === 1 ? 'member' : 'members'} - {group.joinCode}</p>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>
