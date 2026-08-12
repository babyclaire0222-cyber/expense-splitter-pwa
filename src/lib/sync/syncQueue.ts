// src/lib/sync/syncQueue.ts
import { db } from '$lib/db/schema';
import type { SyncTableName, SyncOperation, SyncQueueEntry } from '$lib/db/types';

/**
 * Enqueues a sync entry. MUST be called inside the same db.transaction()
 * as the actual local write it describes, so the two are atomic — see
 * writeHelpers.ts for the pattern.
 */
export async function enqueueSyncEntry(
	generateId: () => string,
	tableName: SyncTableName,
	recordId: string,
	operation: SyncOperation,
	payload: unknown
): Promise<void> {
	const entry: SyncQueueEntry = {
		id: generateId(),
		tableName,
		recordId,
		operation,
		payload: JSON.stringify(payload),
		createdAt: new Date().toISOString(),
		attempts: 0,
		lastAttemptAt: null,
		lastError: null
	};
	await db.syncQueue.add(entry);
}

/** Oldest-first, so dependency order (group -> member -> expense -> split) is respected. */
export async function getQueuedEntriesInOrder(): Promise<SyncQueueEntry[]> {
	return db.syncQueue.orderBy('createdAt').toArray();
}

export async function removeQueueEntry(id: string): Promise<void> {
	await db.syncQueue.delete(id);
}

export async function markQueueEntryFailed(id: string, error: string): Promise<void> {
	const entry = await db.syncQueue.get(id);
	if (!entry) return;
	await db.syncQueue.update(id, {
		attempts: entry.attempts + 1,
		lastAttemptAt: new Date().toISOString(),
		lastError: error
	});
}

/** Exponential backoff: 2^attempts seconds, capped at 5 min. Entries past MAX_ATTEMPTS are skipped by the engine until manually retried. */
export const MAX_AUTO_ATTEMPTS = 5;

export function isWithinBackoffWindow(entry: SyncQueueEntry): boolean {
	if (!entry.lastAttemptAt) return false;
	const backoffMs = Math.min(2 ** entry.attempts * 1000, 5 * 60 * 1000);
	return Date.now() - new Date(entry.lastAttemptAt).getTime() < backoffMs;
}

/** Resets an entry's attempt count so the user can manually force a retry. */
export async function resetQueueEntryForRetry(id: string): Promise<void> {
	await db.syncQueue.update(id, { attempts: 0, lastAttemptAt: null, lastError: null });
}