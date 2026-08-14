<!-- src/routes/groups/[groupId]/+layout.svelte -->
<script lang="ts">
	import { page } from '$app/state';
	import GroupBottomNav from '$lib/components/GroupBottomNav.svelte';

	let { children } = $props();
	let groupId = $derived(page.params.groupId ?? '');
</script>

<div class="pb-20">
	{@render children()}
</div>

<GroupBottomNav {groupId} />