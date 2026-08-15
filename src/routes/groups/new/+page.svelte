<script lang="ts">
	import { goto } from '$app/navigation';
	import { supabase } from '$lib/supabase/client';
	import { createGroupLocal } from '$lib/db/writeHelpers';

	let name = $state('');
	let currency = $state('USD');
	let errorMessage = $state<string | null>(null);
	let isSubmitting = $state(false);

	function generateId(): string {
		return crypto.randomUUID();
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		errorMessage = null;

		if (!name.trim()) {
			errorMessage = 'Enter a group name.';
			return;
		}

		isSubmitting = true;

		try {
			const {
				data: { user }
			} = await supabase.auth.getUser();

			if (!user) {
				errorMessage = 'You must be signed in.';
				isSubmitting = false;
				return;
			}

			const displayName = user.email?.split('@')[0] ?? 'You';

			const { groupId } = await createGroupLocal(
				name.trim(),
				currency,
				displayName,
				user.id,
				generateId
			);

			await goto(`/groups/${groupId}`);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Something went wrong.';
			isSubmitting = false;
		}
	}
</script>

<div class="mx-auto max-w-lg px-4 py-6">
	<h1 class="mb-6 font-display text-2xl text-ink">New group</h1>

	<form onsubmit={handleSubmit} class="space-y-4">
		<label class="block">
			<span class="mb-1 block text-sm text-ink/70">Group name</span>
			<input type="text" bind:value={name} class="w-full rounded border border-ink/20 bg-white px-3 py-2 text-ink" placeholder="Bali Trip 2026" />
		</label>

		<label class="block">
			<span class="mb-1 block text-sm text-ink/70">Currency</span>
			<select bind:value={currency} class="w-full rounded border border-ink/20 bg-white px-3 py-2 text-ink">
				<option value="USD">USD</option>
				<option value="EUR">EUR</option>
				<option value="GBP">GBP</option>
				<option value="SGD">SGD</option>
			</select>
		</label>

		{#if errorMessage}
			<p class="text-sm text-debit">{errorMessage}</p>
		{/if}

		<button type="submit" disabled={isSubmitting} class="w-full rounded bg-brass px-4 py-2 font-medium text-white disabled:opacity-50">
			{isSubmitting ? 'Creating...' : 'Create group'}
		</button>
	</form>
</div>