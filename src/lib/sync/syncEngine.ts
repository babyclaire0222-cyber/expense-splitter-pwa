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
	auditLogToRemote,
	settlementToRemote,
	settlementFromRemote
} from './mappers';
import type { SyncQueueEntry, SyncTableName, Conflict } from '$lib/db/types';

let isSyncing = false;

// Tables that support in-place edits and therefore genuine version
// collisions between two offline devices. 'splits' and 'auditLog' are
// deliberately excluded — see the Conflict type's doc comment in
// db/types.ts for why splits are handled at the parent-expense level
// instead of getting their own conflict rows.
type ConflictableTable = 'groups' | 'members' | 'expenses' | 'settlements';

function remoteTableFor(tableName: ConflictableTable): 'groups' | 'members' | 'expenses' | 'settlements' {
	return tableName === 'groups'
		? 'groups'
		: tableName === 'members'
			? 'members'
			: tableName === 'expenses'
				? 'expenses'
				: 'settlements';
}

// Supabase's typed client needs a LITERAL table-name argument at each
// .from() call to resolve that table's specific Row/Insert/Update types.
// Since our table name is only known at runtime (picked via a ternary on
// a non-literal parameter), TypeScript can't narrow it enough to satisfy
// .from()'s overloads even with remoteTableFor's literal-union return
// type — same underlying issue as localTableFor's Dexie escape hatch
// below, just on the Supabase side. Casting to `any` at this one
// boundary is far more maintainable than fighting the type system at
// every call site that needs a runtime-determined table.
function remoteTable(tableName: ConflictableTable) {
	return supabase.from(remoteTableFor(tableName)) as any;
}

// Dexie's EntityTable generics make a truly generic helper awkward without
// more infrastructure than this app otherwise uses — `as any` here is a
// deliberate, narrow escape hatch, not a sign the rest of the codebase is
// loosely typed.
function localTableFor(tableName: ConflictableTable) {
	const table =
		tableName === 'groups'
			? db.groups
			: tableName === 'members'
				? db.members
				: tableName === 'expenses'
					? db.expenses
					: db.settlements;
	return table as any;
}

/**
 * Records (or refreshes) a conflict for a row this device tried to push
 * but whose version had already moved on remotely — see the Conflict
 * type's doc comment for the full picture. Marks the local record
 * `syncStatus: 'conflict'` so the UI can surface it; does NOT touch the
 * local record's actual field values, so the user's pending edit stays
 * visible until they explicitly resolve (see resolveConflictKeepMine /
 * resolveConflictKeepTheirs in writeHelpers.ts).
 */
async function handleConflict(
	tableName: ConflictableTable,
	recordId: string,
	localSnapshot: unknown
): Promise<void> {
	const { data: remoteRow } = await remoteTable(tableName)
		.select('*')
		.eq('id', recordId)
		.maybeSingle();

	const existing = await db.conflicts
		.where('[tableName+recordId]')
		.equals([tableName, recordId])
		.filter((c) => c.resolvedAt === null)
		.first();

	const timestamp = new Date().toISOString();
	const groupId =
		tableName === 'groups' ? recordId : ((localSnapshot as any)?.groupId ?? recordId);

	if (existing) {
		await db.conflicts.update(existing.id, {
			localSnapshot: JSON.stringify(localSnapshot),
			remoteSnapshot: JSON.stringify(remoteRow ?? null),
			detectedAt: timestamp
		});
	} else {
		const conflict: Conflict = {
			id: crypto.randomUUID(),
			tableName,
			recordId,
			groupId,
			localSnapshot: JSON.stringify(localSnapshot),
			remoteSnapshot: JSON.stringify(remoteRow ?? null),
			detectedAt: timestamp,
			resolvedAt: null,
			resolution: null
		};
		await db.conflicts.add(conflict);
	}

	await localTableFor(tableName).update(recordId, { syncStatus: 'conflict' });
}

/**
 * Pushes one non-split queue entry. Inserts are unconditional (a
 * client-generated UUID can't collide with anyone else's row by
 * definition). Updates are conditional on `version` matching what this
 * device last saw — that's the actual conflict check. A 0-row result
 * means someone else's edit already moved the version on, so we stop
 * and hand off to handleConflict() instead of overwriting.
 */
async function pushConflictableEntry(
	tableName: ConflictableTable,
	entry: SyncQueueEntry,
	localRecord: any
): Promise<void> {
	const toRemote =
		tableName === 'groups'
			? groupToRemote
			: tableName === 'members'
				? memberToRemote
				: tableName === 'expenses'
					? expenseToRemote
					: settlementToRemote;

	const localTable = localTableFor(tableName);

	if (entry.operation === 'insert') {
		const { error } = await remoteTable(tableName).insert(toRemote(localRecord));
		if (error) {
			if (error.code === '23505') {
				// Row already exists server-side — this insert already
				// succeeded on a previous attempt (e.g. a network hiccup
				// after the write landed but before local cleanup ran).
				// Re-fetch to pick up its real current version rather than
				// assuming ours is still correct.
				const { data: existingRow } = await remoteTable(tableName)
					.select('*')
					.eq('id', entry.recordId)
					.maybeSingle();
				await localTable.update(entry.recordId, {
					syncStatus: 'synced',
					version: existingRow?.version ?? localRecord.version
				});
				return;
			}
			throw error;
		}
		await localTable.update(entry.recordId, { syncStatus: 'synced' });
		return;
	}

	const { data, error } = await remoteTable(tableName)
		.update(toRemote(localRecord))
		.eq('id', entry.recordId)
		.eq('version', localRecord.version)
		.select();

	if (error) throw error;

	if (!data || data.length === 0) {
		await handleConflict(tableName, entry.recordId, localRecord);
		return;
	}

	await localTable.update(entry.recordId, { syncStatus: 'synced', version: data[0].version });
}

async function pushSingleTableEntry(entry: SyncQueueEntry): Promise<void> {
	const localRecord = JSON.parse(entry.payload);

	switch (entry.tableName) {
		case 'groups':
		case 'members':
		case 'expenses':
			await pushConflictableEntry(entry.tableName, entry, localRecord);
			break;
		case 'settlements':
			if (entry.operation === 'insert') {
				await pushSettlementInsert(entry, localRecord);
			} else {
				// Soft-delete (undo) — no dedup concern, a real row already
				// exists and this just updates its deletedAt, so the normal
				// version-checked conditional update is correct as-is.
				await pushConflictableEntry('settlements', entry, localRecord);
			}
			break;
		case 'auditLog': {
			const { error } = await supabase.from('audit_log').insert(auditLogToRemote(localRecord));
			if (error && error.code !== '23505') throw error;
			await db.auditLog.update(entry.recordId, { syncStatus: 'synced' });
			break;
		}
	}
}

/**
 * Pushes a brand-new settlement via record_settlement_dedup() instead of
 * a plain insert — see migration 0006's doc comment for the full
 * reasoning. The RPC is the authoritative check: it can catch a
 * duplicate even when the two recording devices were both offline and
 * neither could see the other's pending settlement locally (unlike
 * findPossibleDuplicateSettlement in writeHelpers.ts, which only warns
 * based on what THIS device already has cached).
 *
 * If the server reports this was a duplicate, this device's own
 * optimistically-created local row was a phantom — delete it and adopt
 * the canonical row the RPC actually returns instead, so the group ends
 * up with exactly one settlement for the one real-world payment either
 * way.
 */
async function pushSettlementInsert(entry: SyncQueueEntry, localRecord: any): Promise<void> {
	const { data, error } = await supabase.rpc('record_settlement_dedup', {
		p_id: localRecord.id,
		p_group_id: localRecord.groupId,
		p_from_member_id: localRecord.fromMemberId,
		p_to_member_id: localRecord.toMemberId,
		p_amount_cents: localRecord.amountCents,
		p_settled_at: localRecord.settledAt,
		p_recorded_by_member_id: localRecord.recordedByMemberId,
		p_created_at: localRecord.createdAt
	});

	if (error) throw error;

	const result = data?.[0];
	if (!result) {
		throw new Error('record_settlement_dedup returned no row');
	}

	if (result.is_duplicate) {
		await db.settlements.delete(entry.recordId);
		await db.settlements.put(
			settlementFromRemote({
				id: result.id,
				group_id: result.group_id,
				from_member_id: result.from_member_id,
				to_member_id: result.to_member_id,
				amount_cents: result.amount_cents,
				settled_at: result.settled_at,
				recorded_by_member_id: result.recorded_by_member_id,
				created_at: result.created_at,
				updated_at: result.updated_at,
				deleted_at: result.deleted_at,
				version: result.version
			})
		);
	} else {
		await db.settlements.update(entry.recordId, {
			syncStatus: 'synced',
			version: result.version
		});
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
 *
 * This batching is also why splits don't get their own per-row version
 * check (a conditional batch upsert isn't something PostgREST supports
 * in one call) — conflict protection for splits happens one level up,
 * by holding back a conflicted expense's splits entirely. See
 * pushPendingChanges.
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

	// Expenses and their splits are always edited together (see
	// updateExpenseLocal) — if the parent expense currently has an
	// unresolved conflict, its queued split changes shouldn't be pushed
	// either, since they were computed against a version of the expense
	// that's no longer current. They stay queued (untouched) and are
	// simply skipped every cycle until the expense conflict is resolved.
	const unresolvedConflicts = await db.conflicts.toArray();
	const conflictedExpenseIds = new Set(
		unresolvedConflicts
			.filter((c) => c.tableName === 'expenses' && c.resolvedAt === null)
			.map((c) => c.recordId)
	);

	const splitEntries = eligible.filter((e) => {
		if (e.tableName !== 'splits') return false;
		const payload = JSON.parse(e.payload);
		return !conflictedExpenseIds.has(payload.expenseId);
	});
	const otherEntries = eligible.filter((e) => e.tableName !== 'splits');

	// Push non-split entries individually, in queue order (groups/members/
	// expenses/settlements have no cross-row constraint, so one-at-a-time
	// is fine and keeps per-entry retry/backoff granular).
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

	const [groupsRes, membersRes, expensesRes, splitsRes, settlementsRes, syncOverridesRes] =
		await Promise.all([
			supabase.from('groups').select('*'),
			supabase.from('members').select('*'),
			supabase.from('expenses').select('*'),
			supabase.from('splits').select('*'),
			supabase.from('settlements').select('*'),
			supabase.from('sync_overrides').select('*')
		]);

	// A row with an unresolved local conflict must NOT be silently
	// overwritten by a routine pull — that would apply a "keep theirs"
	// resolution without ever asking the user. Excluded rows stay exactly
	// as they are locally (the user's pending edit, marked 'conflict')
	// until resolveConflictKeepMine/KeepTheirs in writeHelpers.ts runs.
	const unresolvedConflicts = await db.conflicts.toArray();
	const conflictedIdsByTable = new Map<SyncTableName, Set<string>>();
	for (const c of unresolvedConflicts) {
		if (c.resolvedAt !== null) continue;
		if (!conflictedIdsByTable.has(c.tableName)) conflictedIdsByTable.set(c.tableName, new Set());
		conflictedIdsByTable.get(c.tableName)!.add(c.recordId);
	}

	function excludeConflicted<T extends { id: string }>(rows: T[], tableName: SyncTableName): T[] {
		const conflicted = conflictedIdsByTable.get(tableName);
		if (!conflicted || conflicted.size === 0) return rows;
		return rows.filter((r) => !conflicted.has(r.id));
	}

	if (groupsRes.data) {
		await db.groups.bulkPut(excludeConflicted(groupsRes.data, 'groups').map(groupFromRemote));
	}
	if (membersRes.data) {
		await db.members.bulkPut(excludeConflicted(membersRes.data, 'members').map(memberFromRemote));
	}
	if (expensesRes.data) {
		await db.expenses.bulkPut(
			excludeConflicted(expensesRes.data, 'expenses').map(expenseFromRemote)
		);
	}
	if (splitsRes.data) {
		// Splits don't carry their own conflict entries — gate them via
		// their parent expense's conflict status instead (see the big
		// comment on pushSplitEntriesBatched).
		const conflictedExpenseIds = conflictedIdsByTable.get('expenses') ?? new Set<string>();
		const filteredSplits = splitsRes.data.filter(
			(row) => !conflictedExpenseIds.has(row.expense_id)
		);
		await db.splits.bulkPut(filteredSplits.map(splitFromRemote));
	}
	if (settlementsRes.data) {
		await db.settlements.bulkPut(
			excludeConflicted(settlementsRes.data, 'settlements').map(settlementFromRemote)
		);
	}

	// Turn any new "keep mine" resolution events into local notifications
	// — but only for OTHER people's resolutions. The person who actually
	// resolved the conflict was staring at the resolution UI moments ago
	// and doesn't need a banner about their own action.
	if (syncOverridesRes.data && membersRes.data) {
		const ownMemberIds = new Set(
			membersRes.data.filter((m) => m.auth_user_id === user.id).map((m) => m.id)
		);

		const newOverrides = syncOverridesRes.data.filter(
			(o) => !ownMemberIds.has(o.resolved_by_member_id)
		);

		for (const override of newOverrides) {
			const alreadyKnown = await db.syncNotifications.get(override.id);
			if (alreadyKnown) continue;

			await db.syncNotifications.add({
				id: override.id,
				groupId: override.group_id,
				tableName: override.table_name,
				recordId: override.record_id,
				resolvedByMemberId: override.resolved_by_member_id,
				summary: override.summary,
				createdAt: override.created_at,
				dismissedAt: null
			});
		}
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

	// The initial runFullSync() below fires at app boot, before the user has
	// necessarily signed in — pullRemoteChanges() correctly no-ops with no
	// session at that point. Since login navigates client-side (goto('/')),
	// hooks.client.ts never re-executes, so without this listener nothing
	// ever pulls data after a successful sign-in until the next full page
	// reload or online/offline toggle. Covers login, future signup, and
	// session restore alike.
	supabase.auth.onAuthStateChange((event) => {
		if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
			void runFullSync();
		}
	});

	void runFullSync();
}
