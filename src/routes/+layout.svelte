<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { supabase } from '$lib/supabase/client';
	import TopBar from '$lib/components/TopBar.svelte';

	let { children } = $props();

	const isAuthRoute = (pathname: string) => pathname === '/login' || pathname === '/signup';

	onMount(() => {
		if (!isAuthRoute(page.url.pathname)) {
			supabase.auth.getSession().then(({ data: { session } }) => {
				if (!session) {
					goto('/login');
				}
			});
		}

		const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
			if (!session && !isAuthRoute(page.url.pathname)) {
				goto('/login');
			}
		});

		return () => authListener.subscription.unsubscribe();
	});

	let showChrome = $derived(!isAuthRoute(page.url.pathname));
</script>

{#if showChrome}
	<TopBar />
{/if}

{@render children()}