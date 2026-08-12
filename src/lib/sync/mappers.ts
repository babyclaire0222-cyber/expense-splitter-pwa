// src/lib/sync/mappers.ts
// Converts between Dexie's camelCase local records and Supabase's
// snake_case remote rows. Kept centralized here so every place that
// pushes or pulls uses the exact same field mapping.
import type { Group, Member, Expense, Split, AuditLogEntry } from '$lib/db/types';

export function groupToRemote(g: Group) {
	return {
		id: g.id,
		name: g.name,
		currency: g.currency,
		join_code: g.joinCode,
		created_by: g.createdBy,
		created_at: g.createdAt,
		updated_at: g.updatedAt,
		deleted_at: g.deletedAt
	};
}

export function groupFromRemote(row: any): Group {
	return {
		id: row.id,
		name: row.name,
		currency: row.currency,
		joinCode: row.join_code,
		createdBy: row.created_by,
		createdAt: row.created_at,
		syncStatus: 'synced',
		updatedAt: row.updated_at,
		deletedAt: row.deleted_at
	};
}

export function memberToRemote(m: Member) {
	return {
		id: m.id,
		group_id: m.groupId,
		display_name: m.displayName,
		auth_user_id: m.authUserId,
		role: m.role,
		status: m.status,
		approved_by: m.approvedByAuthUserId,
		approved_at: m.approvedAt,
		joined_at: m.joinedAt,
		updated_at: m.updatedAt,
		deleted_at: m.deletedAt
	};
}

export function memberFromRemote(row: any): Member {
	return {
		id: row.id,
		groupId: row.group_id,
		displayName: row.display_name,
		authUserId: row.auth_user_id,
		role: row.role,
		status: row.status,
		approvedByAuthUserId: row.approved_by,
		approvedAt: row.approved_at,
		joinedAt: row.joined_at,
		syncStatus: 'synced',
		updatedAt: row.updated_at,
		deletedAt: row.deleted_at
	};
}

export function expenseToRemote(e: Expense) {
	return {
		id: e.id,
		group_id: e.groupId,
		description: e.description,
		amount_cents: e.amountCents,
		currency: e.currency,
		paid_by_member_id: e.paidByMemberId,
		split_type: e.splitType,
		expense_date: e.expenseDate,
		created_by_member_id: e.createdByMemberId,
		created_at: e.createdAt,
		updated_at: e.updatedAt,
		deleted_at: e.deletedAt,
		reversal_of_expense_id: e.reversalOfExpenseId
	};
}

export function expenseFromRemote(row: any): Expense {
	return {
		id: row.id,
		groupId: row.group_id,
		description: row.description,
		amountCents: row.amount_cents,
		currency: row.currency,
		paidByMemberId: row.paid_by_member_id,
		splitType: row.split_type,
		expenseDate: row.expense_date,
		createdByMemberId: row.created_by_member_id,
		createdAt: row.created_at,
		syncStatus: 'synced',
		updatedAt: row.updated_at,
		deletedAt: row.deleted_at,
		reversalOfExpenseId: row.reversal_of_expense_id
	};
}

export function splitToRemote(s: Split) {
	return {
		id: s.id,
		expense_id: s.expenseId,
		member_id: s.memberId,
		share_cents: s.shareCents,
		share_percentage: s.sharePercentage,
		updated_at: s.updatedAt
	};
}

export function splitFromRemote(row: any): Split {
	return {
		id: row.id,
		expenseId: row.expense_id,
		memberId: row.member_id,
		shareCents: row.share_cents,
		sharePercentage: row.share_percentage,
		syncStatus: 'synced',
		updatedAt: row.updated_at
	};
}

export function auditLogToRemote(a: AuditLogEntry) {
	return {
		id: a.id,
		entity_type: a.entityType,
		entity_id: a.entityId,
		action: a.action,
		performed_by_member_id: a.performedByMemberId,
		performed_at: a.performedAt,
		snapshot: JSON.parse(a.snapshot) // string -> jsonb object
	};
}

export function auditLogFromRemote(row: any): AuditLogEntry {
	return {
		id: row.id,
		entityType: row.entity_type,
		entityId: row.entity_id,
		action: row.action,
		performedByMemberId: row.performed_by_member_id,
		performedAt: row.performed_at,
		snapshot: JSON.stringify(row.snapshot), // jsonb object -> string
		syncStatus: 'synced'
	};
}