<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { supabase } from '$lib/supabase/client';

	let { children } = $props();

	onMount(() => {
		// Skip the guard on the login page itself, to avoid a redirect loop.
		if (page.url.pathname === '/login') return;

		supabase.auth.getSession().then(({ data: { session } }) => {
			if (!session) {
				goto('/login');
			}
		});

		// Also react to sign-out happening while the app is open.
		const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
			if (!session && page.url.pathname !== '/login') {
				goto('/login');
			}
		});

		return () => authListener.subscription.unsubscribe();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
