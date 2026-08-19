<!-- src/routes/login/+page.svelte -->
<script lang="ts">
	import { supabase } from '$lib/supabase/client';
	import { goto } from '$app/navigation';

	let email = $state('');
	let password = $state('');
	let errorMessage = $state<string | null>(null);
	let isSubmitting = $state(false);

	async function handleLogin(event: SubmitEvent) {
		event.preventDefault();
		errorMessage = null;
		isSubmitting = true;

		const {data, error } = await supabase.auth.signInWithPassword({ email, password });

		isSubmitting = false;

		console.log('Login data:', data)
		console.log('Login error:', error)

		if (error) {
			errorMessage = error.message;
			return;
		}

		console.log('session:', data.session)
		console.log('user:', data.user )


		await goto('/');
	}
</script>

<div class="flex min-h-screen items-center justify-center bg-paper px-4">
	<form
		onsubmit={handleLogin}
		class="w-full max-w-sm rounded-lg border border-ink/10 bg-card p-6 shadow-sm"
	>
		<h1 class="mb-6 font-display text-2xl text-ink">Sign in</h1>

		<label class="mb-3 block">
			<span class="mb-1 block text-sm text-ink/70">Email</span>
			<input
				type="email"
				bind:value={email}
				required
				class="w-full rounded border border-ink/20 bg-white px-3 py-2 text-ink"
			/>
		</label>

		<label class="mb-4 block">
			<span class="mb-1 block text-sm text-ink/70">Password</span>
			<input
				type="password"
				bind:value={password}
				required
				class="w-full rounded border border-ink/20 bg-white px-3 py-2 text-ink"
			/>
		</label>

		{#if errorMessage}
			<p class="mb-4 text-sm text-debit">{errorMessage}</p>
		{/if}

		<button
			type="submit"
			disabled={isSubmitting}
			class="w-full rounded bg-brass px-4 py-2 font-medium text-white disabled:opacity-50"
		>
			{isSubmitting ? 'Signing in…' : 'Sign in'}
		</button>

		<p class="mt-4 text-center text-sm text-ink/70">
			New here? <a href="/signup" class="text-brass underline">Create an account</a>
		</p>
	</form>
</div>