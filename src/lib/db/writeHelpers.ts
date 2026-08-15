// src/lib/db/writeHelpers.ts
import { db } from './schema';
import { enqueueSyncEntry } from '$lib/sync/syncQueue';
import { pushPendingChanges } from '$lib/sync/syncEngine';
import type { Expense, Split, Group, Member } from './types';

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
		deletedAt: null
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
		deletedAt: null
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