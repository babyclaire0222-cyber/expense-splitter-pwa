// src/lib/utils/liveQuery.svelte.ts
// Wraps Dexie's liveQuery() (an Observable) into a Svelte 5 rune-based
// reactive value. Call this inside a component's <script> block — like
// any other rune-using function, it must run during component setup.
import { liveQuery } from 'dexie';

export function useLiveQuery<T>(querier: () => T | Promise<T>, initialValue: T) {
	let value = $state<T>(initialValue);

	$effect(() => {
		const observable = liveQuery(querier);
		const subscription = observable.subscribe({
			next: (result) => {
				value = result;
			},
			error: (err) => console.error('liveQuery error:', err)
		});
		return () => subscription.unsubscribe();
	});

	return {
		get value() {
			return value;
		}
	};
}