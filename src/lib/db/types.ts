// src/lib/db/types.ts

/**
 * Sync status for any record that needs to reconcile with Supabase.
 * - 'synced': matches the server, no pending action
 * - 'pending': created/modified locally, not yet pushed
 * - 'conflict': server rejected or diverged, needs manual resolution
 */
export type SyncStatus = 'synced' | 'pending' | 'conflict';

/**
 * Supported split strategies for an expense.
 */
export type SplitType = 'equal' | 'percentage' | 'custom';

/**
 * A Group is the top-level container for shared expenses.
 * currency is an ISO 4217 code (e.g. 'USD', 'EUR') — all amounts
 * within a group are denominated in this currency's smallest unit (cents).
 */
export interface Group {
	id: string; // client-generated UUID
	name: string;
	currency: string; // ISO 4217, e.g. 'USD'
	createdAt: string; // ISO 8601 timestamp
	createdBy: string; // memberId or supabase auth user id
	joinCode: string; // short code for join links, e.g. 'AB3F9K'
	syncStatus: SyncStatus;
	updatedAt: string; // ISO 8601 timestamp, bumped on every local write
	deletedAt: string | null; // soft delete, null = active
}

/**
 * A Member is a person within a group. Not every member has a Supabase
 * Auth account — someone can be added to a group by display name only
 * (e.g. "Alex", cash-only friend) before ever signing up.
 */
export interface Member {
	id: string; // client-generated UUID
	groupId: string;
	displayName: string;
	authUserId: string | null; // Supabase auth.users.id, null if not a registered user
	joinedAt: string; // ISO 8601 timestamp
	syncStatus: SyncStatus;
	updatedAt: string;
	deletedAt: string | null;
}

/**
 * An Expense represents a single shared cost. amountCents is the TOTAL
 * amount paid, always a positive integer. Never store as float/decimal.
 */
export interface Expense {
	id: string; // client-generated UUID
	groupId: string;
	description: string;
	amountCents: number; // total amount, integer cents, always positive
	currency: string; // ISO 4217, should match group.currency
	paidByMemberId: string; // who fronted the money
	splitType: SplitType;
	expenseDate: string; // ISO 8601, when the cost was incurred (user-editable)
	createdAt: string; // ISO 8601, when the record was created
	createdByMemberId: string;
	syncStatus: SyncStatus;
	updatedAt: string;
	deletedAt: string | null; // soft delete; deletion creates a reversal, see auditLog
	reversalOfExpenseId: string | null; // if this expense is a compensating reversal, points to the original
}

/**
 * A Split is one member's owed share of a single expense.
 * Sum of all shareCents for a given expenseId MUST equal that expense's amountCents.
 * This is enforced in the split engine (Step 4), not the DB layer itself.
 */
export interface Split {
	id: string; // client-generated UUID
	expenseId: string;
	memberId: string;
	shareCents: number; // this member's owed portion, integer cents
	sharePercentage: number | null; // only populated if splitType === 'percentage', e.g. 33.33
	syncStatus: SyncStatus;
	updatedAt: string;
}

/**
 * AuditLog is append-only. Every create/edit/delete of an Expense writes
 * one entry here. Edits/deletes NEVER mutate the original expense's
 * financial fields in place without a corresponding audit trail entry.
 */
export type AuditAction = 'create' | 'edit' | 'delete' | 'reversal';

export interface AuditLogEntry {
	id: string; // client-generated UUID
	entityType: 'expense' | 'group' | 'member';
	entityId: string;
	action: AuditAction;
	performedByMemberId: string;
	performedAt: string; // ISO 8601
	// Snapshot of the entity's relevant state at the time of this action,
	// stored as JSON string for flexibility across entity types.
	snapshot: string;
	syncStatus: SyncStatus;
}

/**
 * SyncQueue tracks outbound operations that need to be pushed to Supabase.
 * This is the "outbox" in the outbox pattern — built now, consumed in Step 5.
 */
export type SyncOperation = 'insert' | 'update' | 'delete';

export interface SyncQueueEntry {
	id: string; // client-generated UUID
	tableName: 'groups' | 'members' | 'expenses' | 'splits' | 'auditLog';
	recordId: string; // id of the record in its source table
	operation: SyncOperation;
	payload: string; // JSON-stringified record snapshot to push
	createdAt: string; // ISO 8601, when queued
	attempts: number; // retry count, for backoff logic in Step 5
	lastAttemptAt: string | null;
	lastError: string | null;
}