<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { supabase } from '$lib/supabase/client';
	import TopBar from '$lib/components/TopBar.svelte';

	let { children } = $props();

	onMount(() => {
		if (page.url.pathname === '/login') return;

		supabase.auth.getSession().then(({ data: { session } }) => {
			if (!session) {
				goto('/login');
			}
		});

		const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
			if (!session && page.url.pathname !== '/login') {
				goto('/login');
			}
		});

		return () => authListener.subscription.unsubscribe();
	});

	let showChrome = $derived(page.url.pathname !== '/login');
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#if showChrome}
	<TopBar />
{/if}

{@render children()}
