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

async function pushSingleTableEntry(entry: SyncQueueEntry): Promise<void> {
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
		case 'auditLog': {
			const { error } = await supabase.from('audit_log').insert(auditLogToRemote(localRecord));
			if (error && error.code !== '23505') throw error;
			await db.auditLog.update(entry.recordId, { syncStatus: 'synced' });
			break;
		}
	}
}

/**
 * Splits carry a deferred constraint trigger (check_split_sum) that
 * validates at the end of the SQL transaction, not per-row. Each
 * individual Supabase REST call is its own transaction, so pushing
 * splits one at a time causes the trigger to reject every row except
 * possibly the last (the running sum never matches the expense total
 * until all rows for that expense are present). We push ALL eligible
 * split entries in a single upsert() call instead, so they land in one
 * transaction and the trigger only evaluates once everything is in.
 */
async function pushSplitEntriesBatched(entries: SyncQueueEntry[]): Promise<void> {
	if (entries.length === 0) return;

	const remoteRows = entries.map((e) => splitToRemote(JSON.parse(e.payload)));
	const { error } = await supabase.from('splits').upsert(remoteRows);

	if (error) {
		for (const entry of entries) {
			await markQueueEntryFailed(entry.id, error.message);
		}
		return;
	}

	for (const entry of entries) {
		await removeQueueEntry(entry.id);
		await db.splits.update(entry.recordId, { syncStatus: 'synced' });
	}
}

export async function pushPendingChanges(): Promise<void> {
	if (!navigator.onLine) return;

	const allEntries = await getQueuedEntriesInOrder();
	const eligible = allEntries.filter(
		(e) => e.attempts < MAX_AUTO_ATTEMPTS && !isWithinBackoffWindow(e)
	);

	const splitEntries = eligible.filter((e) => e.tableName === 'splits');
	const otherEntries = eligible.filter((e) => e.tableName !== 'splits');

	// Push non-split entries individually, in queue order (groups/members/
	// expenses have no cross-row constraint, so one-at-a-time is fine and
	// keeps per-entry retry/backoff granular).
	for (const entry of otherEntries) {
		try {
			await pushSingleTableEntry(entry);
			await removeQueueEntry(entry.id);
		} catch (err) {
			await markQueueEntryFailed(entry.id, err instanceof Error ? err.message : String(err));
		}
	}

	// Push all eligible splits together in one transaction.
	await pushSplitEntriesBatched(splitEntries);
}

export async function pullRemoteChanges(): Promise<void> {
	if (!navigator.onLine) return;

	const {
		data: { user }
	} = await supabase.auth.getUser();
	if (!user) return;

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

export function startSyncEngine(): void {
	if (typeof window === 'undefined') return;

	window.addEventListener('online', () => {
		void runFullSync();
	});

	void runFullSync();
}