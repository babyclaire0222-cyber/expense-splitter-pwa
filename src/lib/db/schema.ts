// src/lib/db/schema.ts
import Dexie, { type EntityTable } from 'dexie';
import type {
	Group,
	Member,
	Expense,
	Split,
	AuditLogEntry,
	SyncQueueEntry,
	Settlement,
	Conflict,
	SyncNotification
} from './types';

/**
 * ExpenseSplitterDB defines the local IndexedDB schema via Dexie.
 *
 * Indexing strategy: only fields we actually query/filter on are indexed.
 * The primary key (first field per table) is always the client-generated UUID.
 * Compound indexes (e.g. '[groupId+deletedAt]') let us efficiently query
 * "active records in this group" without a full table scan.
 */
export class ExpenseSplitterDB extends Dexie {
	groups!: EntityTable<Group, 'id'>;
	members!: EntityTable<Member, 'id'>;
	expenses!: EntityTable<Expense, 'id'>;
	splits!: EntityTable<Split, 'id'>;
	auditLog!: EntityTable<AuditLogEntry, 'id'>;
	syncQueue!: EntityTable<SyncQueueEntry, 'id'>;
	settlements!: EntityTable<Settlement, 'id'>;
	conflicts!: EntityTable<Conflict, 'id'>;
	syncNotifications!: EntityTable<SyncNotification, 'id'>;

	constructor() {
		super('ExpenseSplitterDB');

		this.version(2).stores({
			groups: 'id, joinCode, syncStatus, deletedAt, updatedAt',

			members: 'id, groupId, authUserId, status, syncStatus, deletedAt, [groupId+deletedAt]',

			expenses:
				'id, groupId, paidByMemberId, syncStatus, deletedAt, expenseDate, [groupId+deletedAt]',

			splits: 'id, expenseId, memberId, syncStatus, [expenseId+memberId]',

			auditLog: 'id, entityType, entityId, performedAt, syncStatus',

			syncQueue: 'id, tableName, recordId, operation, createdAt, attempts'
		});

		// v3: adds settlements (record-a-payment feature). Dexie requires each
		// version's .stores() call to restate every table's schema, not just
		// the new one — omitting an existing table here would drop it.
		this.version(3).stores({
			groups: 'id, joinCode, syncStatus, deletedAt, updatedAt',

			members: 'id, groupId, authUserId, status, syncStatus, deletedAt, [groupId+deletedAt]',

			expenses:
				'id, groupId, paidByMemberId, syncStatus, deletedAt, expenseDate, [groupId+deletedAt]',

			splits: 'id, expenseId, memberId, syncStatus, [expenseId+memberId]',

			auditLog: 'id, entityType, entityId, performedAt, syncStatus',

			syncQueue: 'id, tableName, recordId, operation, createdAt, attempts',

			settlements:
				'id, groupId, fromMemberId, toMemberId, syncStatus, deletedAt, [groupId+deletedAt]'
		});

		// v4: adds conflicts (offline-edit collision detection, via the new
		// `version` column added to every syncable table server-side —
		// see migration 0004_optimistic_concurrency.sql).
		this.version(4).stores({
			groups: 'id, joinCode, syncStatus, deletedAt, updatedAt',

			members: 'id, groupId, authUserId, status, syncStatus, deletedAt, [groupId+deletedAt]',

			expenses:
				'id, groupId, paidByMemberId, syncStatus, deletedAt, expenseDate, [groupId+deletedAt]',

			splits: 'id, expenseId, memberId, syncStatus, [expenseId+memberId]',

			auditLog: 'id, entityType, entityId, performedAt, syncStatus',

			syncQueue: 'id, tableName, recordId, operation, createdAt, attempts',

			settlements:
				'id, groupId, fromMemberId, toMemberId, syncStatus, deletedAt, [groupId+deletedAt]',

			conflicts: 'id, tableName, recordId, groupId, resolvedAt, [tableName+recordId]'
		});

		// v5: adds syncNotifications (passive "someone else's conflict
		// resolution changed this" indicator, distinct from an ordinary
		// pull refresh — see migration 0005_sync_overrides.sql and
		// pullRemoteChanges in syncEngine.ts).
		this.version(5).stores({
			groups: 'id, joinCode, syncStatus, deletedAt, updatedAt',

			members: 'id, groupId, authUserId, status, syncStatus, deletedAt, [groupId+deletedAt]',

			expenses:
				'id, groupId, paidByMemberId, syncStatus, deletedAt, expenseDate, [groupId+deletedAt]',

			splits: 'id, expenseId, memberId, syncStatus, [expenseId+memberId]',

			auditLog: 'id, entityType, entityId, performedAt, syncStatus',

			syncQueue: 'id, tableName, recordId, operation, createdAt, attempts',

			settlements:
				'id, groupId, fromMemberId, toMemberId, syncStatus, deletedAt, [groupId+deletedAt]',

			conflicts: 'id, tableName, recordId, groupId, resolvedAt, [tableName+recordId]',

			syncNotifications: 'id, groupId, dismissedAt'
		});
	}
}

// Singleton instance — import this everywhere you need DB access
export const db = new ExpenseSplitterDB();