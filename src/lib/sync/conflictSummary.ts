// src/lib/sync/conflictSummary.ts
// Shared diff/summary logic for conflict display and resolution
// notifications, so the conflicts page and resolveConflictKeepMine
// describe the same change the same way instead of drifting apart.

export interface FieldDiff {
	label: string;
	before: string;
	after: string;
	differs: boolean;
}

// Which fields to show per table, and how to format them. Keeps diffs
// readable instead of dumping raw JSON at the user.
const FIELD_CONFIG: Record<string, { label: string; key: string; format?: (v: any) => string }[]> =
	{
		groups: [
			{ label: 'Name', key: 'name' },
			{ label: 'Currency', key: 'currency' }
		],
		members: [
			{ label: 'Display name', key: 'display_name' },
			{ label: 'Status', key: 'status' },
			{ label: 'Role', key: 'role' }
		],
		expenses: [
			{ label: 'Description', key: 'description' },
			{
				label: 'Amount',
				key: 'amount_cents',
				format: (v) => (typeof v === 'number' ? `$${(v / 100).toFixed(2)}` : String(v))
			},
			{ label: 'Split type', key: 'split_type' }
		],
		settlements: [
			{
				label: 'Amount',
				key: 'amount_cents',
				format: (v) => (typeof v === 'number' ? `$${(v / 100).toFixed(2)}` : String(v))
			},
			{ label: 'Settled at', key: 'settled_at' }
		]
	};

// localSnapshot is stored in Dexie's camelCase; remoteSnapshot is raw
// Postgres snake_case. Normalize both to snake_case keys so callers can
// diff them directly regardless of which side a record came from.
export function toSnakeCaseView(record: any): Record<string, any> {
	if (!record) return {};
	const out: Record<string, any> = {};
	for (const [key, value] of Object.entries(record)) {
		const snake = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
		out[snake] = value;
	}
	return out;
}

export function diffFields(tableName: string, before: any, after: any): FieldDiff[] {
	const beforeView = toSnakeCaseView(before);
	const afterView = toSnakeCaseView(after);
	const fieldConfig = FIELD_CONFIG[tableName] ?? [];

	return fieldConfig.map((f) => {
		const beforeStr = f.format ? f.format(beforeView[f.key]) : String(beforeView[f.key] ?? '—');
		const afterStr = f.format ? f.format(afterView[f.key]) : String(afterView[f.key] ?? '—');
		return { label: f.label, before: beforeStr, after: afterStr, differs: beforeStr !== afterStr };
	});
}

export function entityLabelFor(tableName: string, record: any): string {
	const view = toSnakeCaseView(record);
	return tableName === 'expenses'
		? `Expense "${view.description ?? 'Unknown'}"`
		: tableName === 'settlements'
			? 'Settlement payment'
			: tableName === 'members'
				? `Member ${view.display_name ?? 'Unknown'}`
				: `Group "${view.name ?? 'Unknown'}"`;
}

/**
 * A one-line, human-readable description of what changed — used both by
 * the sync-override notification banner (see pullRemoteChanges /
 * resolveConflictKeepMine) and could be reused anywhere else a plain-
 * English summary of a conflict is useful.
 */
export function summarizeDiff(tableName: string, before: any, after: any): string {
	const label = entityLabelFor(tableName, after ?? before);
	const diffs = diffFields(tableName, before, after).filter((d) => d.differs);

	if (diffs.length === 0) {
		return `${label}: updated`;
	}

	const changes = diffs.map((d) => `${d.label} changed from ${d.before} to ${d.after}`).join('; ');
	return `${label}: ${changes}`;
}
