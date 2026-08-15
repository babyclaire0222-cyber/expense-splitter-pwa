<script lang="ts">
	import { supabase } from '$lib/supabase/client';
	import { goto } from '$app/navigation';

	let code = $state('');
	let displayName = $state('');
	let errorMessage = $state<string | null>(null);
	let isSubmitting = $state(false);
	let joinedGroupId = $state<string | null>(null);

	function generateId(): string {
		return crypto.randomUUID();
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		errorMessage = null;

		if (!code.trim()) {
			errorMessage = 'Enter a join code.';
			return;
		}
		if (!displayName.trim()) {
			errorMessage = 'Enter your name.';
			return;
		}

		isSubmitting = true;

		const { data, error } = await supabase.rpc('join_group_by_code', {
			p_code: code.trim().toUpperCase(),
			p_member_id: generateId(),
			p_display_name: displayName.trim()
		});

		isSubmitting = false;

		if (error) {
			errorMessage = error.message.includes('Invalid join code')
				? 'That code doesn\'t match any group.'
				: error.message;
			return;
		}

		joinedGroupId = data as string;
	}
</script>

<div class="mx-auto max-w-lg px-4 py-6">
	<h1 class="mb-6 font-display text-2xl text-ink">Join a group</h1>

	{#if joinedGroupId}
		<div class="rounded-lg border border-ink/10 bg-card px-4 py-8 text-center">
			<p class="mb-1 font-display text-lg text-ink">Request sent</p>
			<p class="mb-4 text-sm text-ink/60">
				Waiting for the group creator to approve you. You'll see the group once approved.
			</p>
			<a href="/" class="text-sm font-medium text-brass hover:underline">Back to your groups</a>
		</div>
	{:else}
		<form onsubmit={handleSubmit} class="space-y-4">
			<label class="block">
				<span class="mb-1 block text-sm text-ink/70">Join code</span>
				<input
					type="text"
					bind:value={code}
					class="w-full rounded border border-ink/20 bg-white px-3 py-2 font-mono uppercase tracking-widest text-ink"
					placeholder="ABC123"
					maxlength="12"
				/>
			</label>

			<label class="block">
				<span class="mb-1 block text-sm text-ink/70">Your name</span>
				<input
					type="text"
					bind:value={displayName}
					class="w-full rounded border border-ink/20 bg-white px-3 py-2 text-ink"
					placeholder="Alex"
				/>
			</label>

			{#if errorMessage}
				<p class="text-sm text-debit">{errorMessage}</p>
			{/if}

			<button
				type="submit"
				disabled={isSubmitting}
				class="w-full rounded bg-brass px-4 py-2 font-medium text-white disabled:opacity-50"
			>
				{isSubmitting ? 'Joining...' : 'Join group'}
			</button>
		</form>
	{/if}
</div>