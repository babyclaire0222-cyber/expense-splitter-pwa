// src/lib/db/schema.ts
import Dexie, { type EntityTable } from 'dexie';
import type { Group, Member, Expense, Split, AuditLogEntry, SyncQueueEntry } from './types';

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

	constructor() {
		super('ExpenseSplitterDB');

		this.version(1).stores({
			groups: 'id, joinCode, syncStatus, deletedAt, updatedAt',

			members: 'id, groupId, authUserId, syncStatus, deletedAt, [groupId+deletedAt]',

			expenses:
				'id, groupId, paidByMemberId, syncStatus, deletedAt, expenseDate, [groupId+deletedAt]',

			splits: 'id, expenseId, memberId, syncStatus, [expenseId+memberId]',

			auditLog: 'id, entityType, entityId, performedAt, syncStatus',

			syncQueue: 'id, tableName, recordId, operation, createdAt, attempts'
		});
	}
}

// Singleton instance — import this everywhere you need DB access
export const db = new ExpenseSplitterDB();