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

/** Matches Postgres members.role check constraint. */
export type MemberRole = 'creator' | 'member';

/** Matches Postgres members.status check constraint — drives approval gating. */
export type MemberStatus = 'pending' | 'approved' | 'rejected';

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
	createdBy: string; // Supabase auth user id of the creator
	joinCode: string; // short code for join links, e.g. 'AB3F9K'
	syncStatus: SyncStatus;
	updatedAt: string; // ISO 8601 timestamp, bumped on every local write
	deletedAt: string | null; // soft delete, null = active
	version: number; // server-managed, bumped on every remote update — see migration 0004
}

/**
 * A Member is a person within a group. Not every member has a Supabase
 * Auth account — someone can be added to a group by display name only
 * (e.g. "Alex", cash-only friend) before ever signing up.
 *
 * status/role/approvedBy* fields mirror the approval-gated join flow
 * built in Step 3 — a new joiner starts 'pending' until the group
 * creator approves them.
 */
export interface Member {
	id: string; // client-generated UUID
	groupId: string;
	displayName: string;
	authUserId: string | null; // Supabase auth.users.id, null if not a registered user
	role: MemberRole;
	status: MemberStatus;
	approvedByAuthUserId: string | null; // auth user id of whoever approved this member
	approvedAt: string | null; // ISO 8601, null if not yet approved
	joinedAt: string; // ISO 8601 timestamp
	syncStatus: SyncStatus;
	updatedAt: string;
	deletedAt: string | null;
	version: number; // server-managed, bumped on every remote update — see migration 0004
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
	version: number; // server-managed, bumped on every remote update — see migration 0004
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
	version: number; // server-managed, bumped on every remote update — see migration 0004
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
 * A Settlement records that a real payment happened between two members
 * OUTSIDE of a shared expense — e.g. Alice hands Bob $50 cash to square
 * up what she owed him. Unlike Split, this isn't a share of a cost; it
 * directly offsets the net balance computed from expenses.
 *
 * Settlements are treated as immutable historical facts once created —
 * there's no "edit amount" flow, only soft-delete to correct a mistaken
 * entry (e.g. recorded against the wrong pair of members).
 */
export interface Settlement {
	id: string; // client-generated UUID
	groupId: string;
	fromMemberId: string; // who paid
	toMemberId: string; // who received
	amountCents: number; // integer cents, always positive
	settledAt: string; // ISO 8601, when the payment actually happened
	recordedByMemberId: string; // who entered this record (may differ from either party)
	createdAt: string;
	syncStatus: SyncStatus;
	updatedAt: string;
	deletedAt: string | null; // soft delete, for correcting a mistaken entry
	version: number; // server-managed, bumped on every remote update — see migration 0004
}

/**
 * Records an offline-edit collision: two devices changed the same row
 * (by id) while both held a stale view of it. Detected via optimistic
 * concurrency — see syncEngine.ts's conditional push (UPDATE ... WHERE
 * version = <base>). When the WHERE clause matches 0 rows, the remote
 * version has moved on since this device last saw it, so we stop and
 * record a Conflict instead of blindly overwriting.
 *
 * tableName is one of the four tables that support in-place edits and
 * therefore genuine version collisions: groups, members, expenses,
 * settlements. Splits don't get their own Conflict rows — an edited
 * expense's splits are always changed together with the expense (see
 * updateExpenseLocal), so a conflict on the parent expense also holds
 * back that expense's queued split changes until it's resolved (see
 * pushPendingChanges). This is a deliberate scope simplification: a
 * "keep mine" resolution re-pushes the local splits via the existing
 * batched upsert without its own version check, so it's possible (if
 * rare) for a resolved expense conflict's splits to still overwrite a
 * concurrent split-only edit from someone else. True per-row optimistic
 * locking for splits would need a Postgres RPC to stay compatible with
 * the deferred check_split_sum trigger, which batches all of an
 * expense's splits into one transaction — judged not worth the added
 * complexity for this app's scale.
 */
export interface Conflict {
	id: string;
	tableName: SyncTableName;
	recordId: string;
	groupId: string; // which group this conflict belongs to, for scoping the UI per-group
	localSnapshot: string; // JSON string — this device's local record at conflict time
	remoteSnapshot: string; // JSON string — what was actually on the server at conflict time
	detectedAt: string; // ISO 8601
	resolvedAt: string | null; // null = still needs the user to pick a side
	resolution: 'kept_mine' | 'kept_theirs' | null;
}

/**
 * A local, per-device record of a "keep mine" conflict resolution that
 * happened somewhere else in the group — pulled down from Postgres's
 * `sync_overrides` table (see migration 0005) and given a passive,
 * dismissible presence in the UI. This is what lets a device distinguish
 * "my data just changed because someone resolved a conflict" from an
 * ordinary background refresh.
 *
 * Deliberately NOT synced back up — dismissal is local-only, so each
 * device/tab tracks its own "have I seen this" state independently. The
 * underlying sync_overrides row it was created from is never deleted;
 * only this local acknowledgment is device-specific.
 */
export interface SyncNotification {
	id: string; // matches the sync_overrides row it was created from
	groupId: string;
	tableName: string;
	recordId: string;
	resolvedByMemberId: string;
	summary: string;
	createdAt: string;
	dismissedAt: string | null;
}

/**
 * SyncQueue tracks outbound operations that need to be pushed to Supabase.
 * This is the "outbox" in the outbox pattern.
 */
export type SyncOperation = 'insert' | 'update' | 'delete';

/** Named alias so sync engine code can reference table names as a type, not just inline literals. */
export type SyncTableName = 'groups' | 'members' | 'expenses' | 'splits' | 'auditLog' | 'settlements';

export interface SyncQueueEntry {
	id: string; // client-generated UUID
	tableName: SyncTableName;
	recordId: string; // id of the record in its source table
	operation: SyncOperation;
	payload: string; // JSON-stringified record snapshot to push
	createdAt: string; // ISO 8601, when queued
	attempts: number; // retry count, for backoff logic
	lastAttemptAt: string | null;
	lastError: string | null;
}