// src/lib/db/writeHelpers.ts
// Atomic "write to Dexie + enqueue sync entry" functions. UI code (Step 6+)
// calls these instead of touching db.expenses directly, so the outbox
// guarantee is never accidentally skipped by a component.
import { db } from './schema';
import { enqueueSyncEntry } from '$lib/sync/syncQueue';
import { pushPendingChanges } from '$lib/sync/syncEngine';
import type { Expense, Split } from './types';

function nowIso(): string {
	return new Date().toISOString();
}

function maybeKickPush(): void {
	if (typeof navigator !== 'undefined' && navigator.onLine) {
		void pushPendingChanges();
	}
}

export async function createExpenseLocal(
	expense: Omit<Expense, 'syncStatus' | 'updatedAt' | 'createdAt' | 'deletedAt'>,
	splits: Omit<Split, 'syncStatus' | 'updatedAt'>[],
	generateId: () => string
): Promise<void> {
	const timestamp = nowIso();

	const fullExpense: Expense = {
		...expense,
		createdAt: timestamp,
		updatedAt: timestamp,
		syncStatus: 'pending',
		deletedAt: null
	};
	const fullSplits: Split[] = splits.map((s) => ({
		...s,
		updatedAt: timestamp,
		syncStatus: 'pending'
	}));

	await db.transaction('rw', db.expenses, db.splits, db.syncQueue, async () => {
		await db.expenses.add(fullExpense);
		await db.splits.bulkAdd(fullSplits);
		await enqueueSyncEntry(generateId, 'expenses', fullExpense.id, 'insert', fullExpense);
		for (const split of fullSplits) {
			await enqueueSyncEntry(generateId, 'splits', split.id, 'insert', split);
		}
	});

	maybeKickPush();
}

/**
 * Soft-deletes an expense. Per the Immutability rule, this does NOT hard
 * delete — it sets deletedAt, which balances.ts already excludes from
 * calculations. The audit log entry is the caller's responsibility (added
 * alongside the calling UI action in a later step, once we have a "who is
 * performing this action" context to attach).
 */
export async function deleteExpenseLocal(
	expenseId: string,
	generateId: () => string
): Promise<void> {
	const timestamp = nowIso();

	await db.transaction('rw', db.expenses, db.syncQueue, async () => {
		await db.expenses.update(expenseId, { deletedAt: timestamp, updatedAt: timestamp, syncStatus: 'pending' });
		const updated = await db.expenses.get(expenseId);
		if (updated) {
			await enqueueSyncEntry(generateId, 'expenses', expenseId, 'update', updated);
		}
	});

	maybeKickPush();
}