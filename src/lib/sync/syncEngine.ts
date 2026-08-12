// src/lib/sync/syncEngine.ts
import { db } from '$lib/db/schema';
import { supabase } from '$lib/supabase/client';
import {
	getQueuedEntriesInOrder,
	removeQueueEntry,
	markQueueEntryFailed,
	isWithinBackoffWindow,
	MAX_AUTO_ATTEMPTS
} from './syncQueue';
import {
	groupToRemote,
	groupFromRemote,
	memberToRemote,
	memberFromRemote,
	expenseToRemote,
	expenseFromRemote,
	splitToRemote,
	splitFromRemote,
	auditLogToRemote
} from './mappers';
import type { SyncQueueEntry } from '$lib/db/types';

let isSyncing = false;

/**
 * Pushes a single queue entry to its matching Supabase table. Written as
 * an explicit switch (rather than a dynamic string lookup) because the
 * generated Supabase types only accept literal table name strings in
 * `.from(...)` — a widened `string` variable doesn't satisfy that, even
 * if its runtime value is always correct.
 */
async function pushOneEntry(entry: SyncQueueEntry): Promise<void> {
	const localRecord = JSON.parse(entry.payload);

	switch (entry.tableName) {
		case 'groups': {
			const { error } = await supabase.from('groups').upsert(groupToRemote(localRecord));
			if (error) throw error;
			await db.groups.update(entry.recordId, { syncStatus: 'synced' });
			break;
		}
		case 'members': {
			const { error } = await supabase.from('members').upsert(memberToRemote(localRecord));
			if (error) throw error;
			await db.members.update(entry.recordId, { syncStatus: 'synced' });
			break;
		}
		case 'expenses': {
			const { error } = await supabase.from('expenses').upsert(expenseToRemote(localRecord));
			if (error) throw error;
			await db.expenses.update(entry.recordId, { syncStatus: 'synced' });
			break;
		}
		case 'splits': {
			const { error } = await supabase.from('splits').upsert(splitToRemote(localRecord));
			if (error) throw error;
			await db.splits.update(entry.recordId, { syncStatus: 'synced' });
			break;
		}
		case 'auditLog': {
			const { error } = await supabase.from('audit_log').insert(auditLogToRemote(localRecord));
			// Postgres unique_violation (23505) on retry-of-already-synced entry is fine to ignore.
			if (error && error.code !== '23505') throw error;
			await db.auditLog.update(entry.recordId, { syncStatus: 'synced' });
			break;
		}
	}
}

/**
 * PUSH: drains the local outbox to Supabase, oldest entry first.
 */
export async function pushPendingChanges(): Promise<void> {
	if (!navigator.onLine) return;

	const entries = await getQueuedEntriesInOrder();

	for (const entry of entries) {
		if (entry.attempts >= MAX_AUTO_ATTEMPTS) continue; // needs manual retry
		if (isWithinBackoffWindow(entry)) continue;

		try {
			await pushOneEntry(entry);
			await removeQueueEntry(entry.id);
		} catch (err) {
			await markQueueEntryFailed(entry.id, err instanceof Error ? err.message : String(err));
		}
	}
}

/**
 * PULL: fetches everything RLS allows the current user to see and upserts
 * it into Dexie. Safe to call repeatedly — bulkPut overwrites by primary key.
 */
export async function pullRemoteChanges(): Promise<void> {
	if (!navigator.onLine) return;

	const {
		data: { user }
	} = await supabase.auth.getUser();
	if (!user) return; // not logged in yet, nothing to pull

	const [groupsRes, membersRes, expensesRes, splitsRes] = await Promise.all([
		supabase.from('groups').select('*'),
		supabase.from('members').select('*'),
		supabase.from('expenses').select('*'),
		supabase.from('splits').select('*')
	]);

	if (groupsRes.data) {
		await db.groups.bulkPut(groupsRes.data.map(groupFromRemote));
	}
	if (membersRes.data) {
		await db.members.bulkPut(membersRes.data.map(memberFromRemote));
	}
	if (expensesRes.data) {
		await db.expenses.bulkPut(expensesRes.data.map(expenseFromRemote));
	}
	if (splitsRes.data) {
		await db.splits.bulkPut(splitsRes.data.map(splitFromRemote));
	}
}

/** Runs pull then push, guarded against overlapping concurrent runs. */
export async function runFullSync(): Promise<void> {
	if (isSyncing) return;
	isSyncing = true;
	try {
		await pullRemoteChanges();
		await pushPendingChanges();
	} finally {
		isSyncing = false;
	}
}

/** Call once on app startup. Wires 'online' event + runs an initial sync. */
export function startSyncEngine(): void {
	if (typeof window === 'undefined') return; // SSR guard

	window.addEventListener('online', () => {
		void runFullSync();
	});

	void runFullSync();
}