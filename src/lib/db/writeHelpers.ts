// src/lib/db/writeHelpers.ts
import { db } from './schema';
import { enqueueSyncEntry } from '$lib/sync/syncQueue';
import { pushPendingChanges } from '$lib/sync/syncEngine';
import { supabase } from '$lib/supabase/client';
import {
	groupFromRemote,
	memberFromRemote,
	expenseFromRemote,
	settlementFromRemote,
	splitFromRemote
} from '$lib/sync/mappers';
import { summarizeDiff } from '$lib/sync/conflictSummary';
import type { Expense, Split, Group, Member, Settlement, Conflict, SyncTableName } from './types';

function nowIso(): string {
	return new Date().toISOString();
}

function maybeKickPush(): void {
	if (typeof navigator !== 'undefined' && navigator.onLine) {
		void pushPendingChanges();
	}
}

function generateJoinCode(): string {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 ambiguity
	let code = '';
	for (let i = 0; i < 6; i++) {
		code += chars[Math.floor(Math.random() * chars.length)];
	}
	return code;
}

/**
 * Creates a new group AND the creator's own approved membership row in
 * one atomic transaction. The creator is auto-approved (per the Step 3
 * approval-gating design — the person who starts the group obviously
 * doesn't need to approve themselves).
 */
export async function createGroupLocal(
	name: string,
	currency: string,
	creatorDisplayName: string,
	creatorAuthUserId: string,
	generateId: () => string
): Promise<{ groupId: string }> {
	const timestamp = nowIso();
	const groupId = generateId();
	const memberId = generateId();

	const group: Group = {
		id: groupId,
		name,
		currency,
		createdAt: timestamp,
		createdBy: creatorAuthUserId,
		joinCode: generateJoinCode(),
		syncStatus: 'pending',
		updatedAt: timestamp,
		deletedAt: null,
		version: 1
	};

	const creatorMember: Member = {
		id: memberId,
		groupId,
		displayName: creatorDisplayName,
		authUserId: creatorAuthUserId,
		role: 'creator',
		status: 'approved',
		approvedByAuthUserId: creatorAuthUserId,
		approvedAt: timestamp,
		joinedAt: timestamp,
		syncStatus: 'pending',
		updatedAt: timestamp,
		deletedAt: null,
		version: 1
	};

	await db.transaction('rw', db.groups, db.members, db.syncQueue, async () => {
		await db.groups.add(group);
		await db.members.add(creatorMember);
		await enqueueSyncEntry(generateId, 'groups', group.id, 'insert', group);
		await enqueueSyncEntry(generateId, 'members', creatorMember.id, 'insert', creatorMember);
	});

	maybeKickPush();

	return { groupId };
}

export async function createExpenseLocal(
	expense: Omit<Expense, 'syncStatus' | 'updatedAt' | 'createdAt' | 'deletedAt' | 'version'>,
	splits: Omit<Split, 'syncStatus' | 'updatedAt' | 'version'>[],
	generateId: () => string
): Promise<void> {
	const timestamp = nowIso();

	const fullExpense: Expense = {
		...expense,
		createdAt: timestamp,
		updatedAt: timestamp,
		syncStatus: 'pending',
		deletedAt: null,
		version: 1
	};
	const fullSplits: Split[] = splits.map((s) => ({
		...s,
		updatedAt: timestamp,
		syncStatus: 'pending',
		version: 1
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

export async function updateExpenseLocal(
	expenseId: string,
	updates: Pick<
		Expense,
		'description' | 'amountCents' | 'paidByMemberId' | 'splitType' | 'expenseDate'
	>,
	computedShares: { memberId: string; shareCents: number; sharePercentage: number | null }[],
	generateId: () => string
): Promise<void> {
	const timestamp = nowIso();

	await db.transaction('rw', db.expenses, db.splits, db.syncQueue, async () => {
		await db.expenses.update(expenseId, {
			...updates,
			updatedAt: timestamp,
			syncStatus: 'pending'
		});
		const updatedExpense = await db.expenses.get(expenseId);
		if (updatedExpense) {
			await enqueueSyncEntry(generateId, 'expenses', expenseId, 'update', updatedExpense);
		}

		// Splits have no soft-delete column and no delete-sync path (see
		// migration 0002's comment), so a member removed from the split gets
		// their existing row zeroed out rather than deleted — balances.ts
		// already treats a 0-cent share as a no-op contribution, so this is
		// functionally identical to removal for ledger purposes.
		const existingSplits = await db.splits.where('expenseId').equals(expenseId).toArray();
		const existingByMemberId = new Map(existingSplits.map((s) => [s.memberId, s]));
		const newMemberIds = new Set(computedShares.map((cs) => cs.memberId));

		for (const share of computedShares) {
			const existing = existingByMemberId.get(share.memberId);
			if (existing) {
				await db.splits.update(existing.id, {
					shareCents: share.shareCents,
					sharePercentage: share.sharePercentage,
					updatedAt: timestamp,
					syncStatus: 'pending'
				});
				const updatedSplit = await db.splits.get(existing.id);
				if (updatedSplit) {
					await enqueueSyncEntry(generateId, 'splits', existing.id, 'update', updatedSplit);
				}
			} else {
				const newSplit: Split = {
					id: generateId(),
					expenseId,
					memberId: share.memberId,
					shareCents: share.shareCents,
					sharePercentage: share.sharePercentage,
					updatedAt: timestamp,
					syncStatus: 'pending',
					version: 1
				};
				await db.splits.add(newSplit);
				await enqueueSyncEntry(generateId, 'splits', newSplit.id, 'insert', newSplit);
			}
		}

		for (const existing of existingSplits) {
			if (newMemberIds.has(existing.memberId)) continue;
			await db.splits.update(existing.id, {
				shareCents: 0,
				sharePercentage: null,
				updatedAt: timestamp,
				syncStatus: 'pending'
			});
			const zeroedSplit = await db.splits.get(existing.id);
			if (zeroedSplit) {
				await enqueueSyncEntry(generateId, 'splits', existing.id, 'update', zeroedSplit);
			}
		}
	});

	maybeKickPush();
}

export async function deleteExpenseLocal(
	expenseId: string,
	generateId: () => string
): Promise<void> {
	const timestamp = nowIso();

	await db.transaction('rw', db.expenses, db.syncQueue, async () => {
		await db.expenses.update(expenseId, {
			deletedAt: timestamp,
			updatedAt: timestamp,
			syncStatus: 'pending'
		});
		const updated = await db.expenses.get(expenseId);
		if (updated) {
			await enqueueSyncEntry(generateId, 'expenses', expenseId, 'update', updated);
		}
	});

	maybeKickPush();
}

/**
 * Records that a real payment happened between two members, outside of
 * any shared expense (e.g. handing someone cash to settle up). Treated
 * as an immutable historical fact once created — see deleteSettlementLocal
 * for correcting a mistaken entry rather than editing the amount in place.
 */
export async function recordSettlementLocal(
	groupId: string,
	fromMemberId: string,
	toMemberId: string,
	amountCents: number,
	recordedByMemberId: string,
	generateId: () => string
): Promise<void> {
	const timestamp = nowIso();

	const settlement: Settlement = {
		id: generateId(),
		groupId,
		fromMemberId,
		toMemberId,
		amountCents,
		settledAt: timestamp,
		recordedByMemberId,
		createdAt: timestamp,
		syncStatus: 'pending',
		updatedAt: timestamp,
		deletedAt: null,
		version: 1
	};

	await db.transaction('rw', db.settlements, db.syncQueue, async () => {
		await db.settlements.add(settlement);
		await enqueueSyncEntry(generateId, 'settlements', settlement.id, 'insert', settlement);
	});

	maybeKickPush();
}

export async function deleteSettlementLocal(
	settlementId: string,
	generateId: () => string
): Promise<void> {
	const timestamp = nowIso();

	await db.transaction('rw', db.settlements, db.syncQueue, async () => {
		await db.settlements.update(settlementId, {
			deletedAt: timestamp,
			updatedAt: timestamp,
			syncStatus: 'pending'
		});
		const updated = await db.settlements.get(settlementId);
		if (updated) {
			await enqueueSyncEntry(generateId, 'settlements', settlementId, 'update', updated);
		}
	});

	maybeKickPush();
}

/**
 * Best-effort guard against the OTHER kind of offline collision:
 * settlements are insert-only with fresh client-generated UUIDs, so two
 * devices marking the SAME suggested transfer as paid while both offline
 * don't clobber each other (see optimistic-concurrency conflict
 * handling above) — they just both succeed, silently double-recording
 * the same payment.
 *
 * This only checks locally-cached settlements (whatever this device has
 * already pulled), so it can't catch a payment the OTHER device recorded
 * while THIS device was also offline — that's a real, accepted gap
 * given true de-duplication would need a server-side check at insert
 * time. It does catch the common case: an accidental double-tap, or
 * re-recording something already synced down from someone else.
 */
export async function findPossibleDuplicateSettlement(
	groupId: string,
	fromMemberId: string,
	toMemberId: string,
	amountCents: number,
	withinMinutes = 5
): Promise<Settlement | null> {
	const candidates = await db.settlements.where('groupId').equals(groupId).toArray();
	const cutoff = Date.now() - withinMinutes * 60 * 1000;

	const match = candidates.find(
		(s) =>
			s.deletedAt === null &&
			s.fromMemberId === fromMemberId &&
			s.toMemberId === toMemberId &&
			s.amountCents === amountCents &&
			new Date(s.settledAt).getTime() >= cutoff
	);

	return match ?? null;
}

type ConflictableTable = 'groups' | 'members' | 'expenses' | 'settlements';

function localTableForConflict(tableName: ConflictableTable) {
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
 * Resolve a conflict by keeping this device's local edit and re-pushing
 * it — rebased on top of the version that actually caused the conflict,
 * so the retry doesn't just conflict again. If the conflict is on an
 * expense, any of that expense's splits that were held back while the
 * conflict was unresolved (see pushPendingChanges in syncEngine.ts) are
 * now free to push on the next sync cycle — no extra action needed here,
 * since they were never removed from the queue, only skipped.
 *
 * Also writes a best-effort `sync_overrides` row directly (not through
 * the outbox — resolving a conflict already requires being online right
 * now), so OTHER members learn their already-synced value just got
 * overridden the next time they pull, instead of it silently changing
 * with no explanation. See pullRemoteChanges in syncEngine.ts for the
 * receiving side. If this insert fails (e.g. connection drops between
 * the main push above and this one), the actual data resolution has
 * already succeeded — only the "let others know" notification is lost,
 * which is treated as acceptable degradation rather than blocking the
 * resolution itself.
 */
export async function resolveConflictKeepMine(
	conflictId: string,
	resolvedByMemberId: string,
	generateId: () => string
): Promise<void> {
	const conflict = await db.conflicts.get(conflictId);
	if (!conflict) return;

	const tableName = conflict.tableName as ConflictableTable;
	const localSnapshot = JSON.parse(conflict.localSnapshot);
	const remoteSnapshot = conflict.remoteSnapshot ? JSON.parse(conflict.remoteSnapshot) : null;
	const timestamp = nowIso();

	const rebasedRecord = {
		...localSnapshot,
		// Re-base on the CURRENT remote version — the one that caused the
		// conflict — so this push's version check succeeds instead of
		// failing against the same stale value again.
		version: remoteSnapshot?.version ?? localSnapshot.version,
		updatedAt: timestamp,
		syncStatus: 'pending'
	};

	await localTableForConflict(tableName).put(rebasedRecord);
	await enqueueSyncEntry(generateId, tableName as SyncTableName, conflict.recordId, 'update', rebasedRecord);
	await db.conflicts.update(conflict.id, { resolvedAt: timestamp, resolution: 'kept_mine' });

	try {
		await supabase.from('sync_overrides').insert({
			id: generateId(),
			group_id: conflict.groupId,
			table_name: tableName,
			record_id: conflict.recordId,
			resolved_by_member_id: resolvedByMemberId,
			summary: summarizeDiff(tableName, remoteSnapshot, rebasedRecord)
		});
	} catch {
		// Best-effort — see doc comment above.
	}

	maybeKickPush();
}

/**
 * Resolve a conflict by discarding this device's local edit and adopting
 * whatever's actually on the server. For an expense conflict, this also
 * discards any queued split edits that went along with the abandoned
 * expense edit, and re-pulls the current remote splits so the local
 * copy matches the server's truth (pull was excluding this expense's
 * splits the whole time the conflict was open — see pullRemoteChanges).
 */
export async function resolveConflictKeepTheirs(conflictId: string): Promise<void> {
	const conflict = await db.conflicts.get(conflictId);
	if (!conflict) return;

	const tableName = conflict.tableName as ConflictableTable;
	const remoteSnapshot = conflict.remoteSnapshot ? JSON.parse(conflict.remoteSnapshot) : null;
	const timestamp = nowIso();

	if (remoteSnapshot) {
		const fromRemote =
			tableName === 'groups'
				? groupFromRemote
				: tableName === 'members'
					? memberFromRemote
					: tableName === 'expenses'
						? expenseFromRemote
						: settlementFromRemote;

		await localTableForConflict(tableName).put(fromRemote(remoteSnapshot));
	}

	if (tableName === 'expenses') {
		// Drop the abandoned local split edits for this expense — they
		// were computed against the expense version we're now discarding.
		const queuedSplitEntries = await db.syncQueue.where('tableName').equals('splits').toArray();
		for (const entry of queuedSplitEntries) {
			const payload = JSON.parse(entry.payload);
			if (payload.expenseId === conflict.recordId) {
				await db.syncQueue.delete(entry.id);
			}
		}

		// Re-pull the current remote splits for this expense — pull has
		// been excluding them the whole time this conflict was open.
		const { data: remoteSplits } = await supabase
			.from('splits')
			.select('*')
			.eq('expense_id', conflict.recordId);
		if (remoteSplits) {
			await db.splits.bulkPut(remoteSplits.map(splitFromRemote));
		}
	}

	await db.conflicts.update(conflict.id, { resolvedAt: timestamp, resolution: 'kept_theirs' });
}

/**
 * Purely local acknowledgment — each device/tab dismisses independently,
 * nothing gets synced back for this. The underlying sync_overrides row
 * this notification came from stays in Postgres forever as a historical
 * record; only this device's "have I seen it" marker changes.
 */
export async function dismissSyncNotification(notificationId: string): Promise<void> {
	await db.syncNotifications.update(notificationId, { dismissedAt: nowIso() });
}