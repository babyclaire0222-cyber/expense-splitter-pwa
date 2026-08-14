<!-- src/lib/components/TopBar.svelte -->
<script lang="ts">
	import { useLiveQuery } from '$lib/utils/liveQuery.svelte';
	import { db } from '$lib/db/schema';
	import { supabase } from '$lib/supabase/client';
	import { goto } from '$app/navigation';

	const pendingCount = useLiveQuery(() => db.syncQueue.count(), 0);
	let isOnline = $state(typeof navigator !== 'undefined' ? navigator.onLine : true);

	$effect(() => {
		const goOnline = () => (isOnline = true);
		const goOffline = () => (isOnline = false);
		window.addEventListener('online', goOnline);
		window.addEventListener('offline', goOffline);
		return () => {
			window.removeEventListener('online', goOnline);
			window.removeEventListener('offline', goOffline);
		};
	});

	let statusLabel = $derived(
		!isOnline ? 'Offline' : pendingCount.value > 0 ? `Syncing ${pendingCount.value}…` : 'Synced'
	);
	let statusColor = $derived(
		!isOnline ? 'bg-debit' : pendingCount.value > 0 ? 'bg-brass' : 'bg-credit'
	);

	async function handleSignOut() {
		await supabase.auth.signOut();
		await goto('/login');
	}
</script>

<header
	class="sticky top-0 z-20 flex items-center justify-between border-b border-ink/10 bg-card px-4 py-3"
>
	<a href="/" class="font-display text-xl text-ink">Tally</a>

	<div class="flex items-center gap-3">
		<span class="flex items-center gap-1.5 font-mono text-xs text-ink/70">
			<span class="h-2 w-2 rounded-full {statusColor}"></span>
			{statusLabel}
		</span>
		<button onclick={handleSignOut} class="text-sm text-ink/60 hover:text-ink" aria-label="Sign out">
			Sign out
		</button>
	</div>
</header>