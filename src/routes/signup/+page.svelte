<!-- src/routes/signup/+page.svelte -->
<script lang="ts">
	import { supabase } from '$lib/supabase/client';
	import { goto } from '$app/navigation';

	let email = $state('');
	let password = $state('');
	let confirmPassword = $state('');
	let errorMessage = $state<string | null>(null);
	let isSubmitting = $state(false);
	// Supabase projects can be configured either way: some issue a session
	// immediately on sign-up, others require the user to click a
	// confirmation link in their email first (data.session is null in that
	// case). Handle both rather than assuming one.
	let awaitingConfirmation = $state(false);

	async function handleSignup(event: SubmitEvent) {
		event.preventDefault();
		errorMessage = null;

		if (password !== confirmPassword) {
			errorMessage = "Passwords don't match.";
			return;
		}

		isSubmitting = true;
		const { data, error } = await supabase.auth.signUp({ email, password });
		isSubmitting = false;

		if (error) {
			errorMessage = error.message;
			return;
		}

		if (data.session) {
			await goto('/');
		} else {
			awaitingConfirmation = true;
		}
	}
</script>

<div class="flex min-h-screen items-center justify-center bg-paper px-4">
	{#if awaitingConfirmation}
		<div class="w-full max-w-sm rounded-lg border border-ink/10 bg-card p-6 shadow-sm">
			<h1 class="mb-3 font-display text-2xl text-ink">Check your email</h1>
			<p class="text-sm text-ink/70">
				We sent a confirmation link to <span class="font-medium text-ink">{email}</span>. Click
				it, then come back and sign in.
			</p>
			<a href="/login" class="mt-4 inline-block text-sm text-brass underline">Back to sign in</a>
		</div>
	{:else}
		<form
			onsubmit={handleSignup}
			class="w-full max-w-sm rounded-lg border border-ink/10 bg-card p-6 shadow-sm"
		>
			<h1 class="mb-6 font-display text-2xl text-ink">Create an account</h1>

			<label class="mb-3 block">
				<span class="mb-1 block text-sm text-ink/70">Email</span>
				<input
					type="email"
					bind:value={email}
					required
					class="w-full rounded border border-ink/20 bg-white px-3 py-2 text-ink"
				/>
			</label>

			<label class="mb-3 block">
				<span class="mb-1 block text-sm text-ink/70">Password</span>
				<input
					type="password"
					bind:value={password}
					required
					minlength="6"
					class="w-full rounded border border-ink/20 bg-white px-3 py-2 text-ink"
				/>
			</label>

			<label class="mb-4 block">
				<span class="mb-1 block text-sm text-ink/70">Confirm password</span>
				<input
					type="password"
					bind:value={confirmPassword}
					required
					minlength="6"
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
				{isSubmitting ? 'Creating account…' : 'Create account'}
			</button>

			<p class="mt-4 text-center text-sm text-ink/70">
				Already have an account? <a href="/login" class="text-brass underline">Sign in</a>
			</p>
		</form>
	{/if}
</div>