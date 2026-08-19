// tests/balances.test.ts
import { describe, it, expect } from 'vitest';
import { computeGroupBalances } from '../src/lib/ledger/balances';
import type { Expense, Split } from '../src/lib/db/types';

/**
 * Minimal helper to build a valid Expense object with sensible defaults,
 * overridable per test case.
 */
function makeExpense(overrides: Partial<Expense> & { id: string }): Expense {
	return {
		groupId: 'group1',
		description: 'test expense',
		amountCents: 0,
		currency: 'USD',
		paidByMemberId: 'a',
		splitType: 'equal',
		expenseDate: '2026-01-01T00:00:00.000Z',
		createdAt: '2026-01-01T00:00:00.000Z',
		createdByMemberId: 'a',
		syncStatus: 'synced',
		updatedAt: '2026-01-01T00:00:00.000Z',
		deletedAt: null,
		reversalOfExpenseId: null,
		version: 1,
		...overrides
	};
}

function makeSplit(overrides: Partial<Split> & { id: string; expenseId: string }): Split {
	return {
		memberId: 'a',
		shareCents: 0,
		sharePercentage: null,
		syncStatus: 'synced',
		updatedAt: '2026-01-01T00:00:00.000Z',
		version: 1,
		...overrides
	};
}

describe('computeGroupBalances', () => {
	it('computes correct net balances for a simple two-person expense', () => {
		// a pays 1000, split equally between a and b (500 each)
		const expenses = [makeExpense({ id: 'e1', amountCents: 1000, paidByMemberId: 'a' })];
		const splits = new Map<string, Split[]>([
			[
				'e1',
				[
					makeSplit({ id: 's1', expenseId: 'e1', memberId: 'a', shareCents: 500 }),
					makeSplit({ id: 's2', expenseId: 'e1', memberId: 'b', shareCents: 500 })
				]
			]
		]);

		const balances = computeGroupBalances(expenses, splits);

		const a = balances.find((b) => b.memberId === 'a')!;
		const b = balances.find((b) => b.memberId === 'b')!;

		expect(a.paidCents).toBe(1000);
		expect(a.owedCents).toBe(500);
		expect(a.netCents).toBe(500); // a is owed 500

		expect(b.paidCents).toBe(0);
		expect(b.owedCents).toBe(500);
		expect(b.netCents).toBe(-500); // b owes 500
	});

	it('excludes soft-deleted expenses from balance calculations', () => {
		// e1 is active: a pays 1000, split equally.
		// e2 is soft-deleted: should NOT count toward any balance, even
		// though it has splits attached.
		const expenses = [
			makeExpense({ id: 'e1', amountCents: 1000, paidByMemberId: 'a' }),
			makeExpense({
				id: 'e2',
				amountCents: 5000,
				paidByMemberId: 'b',
				deletedAt: '2026-01-02T00:00:00.000Z' // soft-deleted
			})
		];
		const splits = new Map<string, Split[]>([
			[
				'e1',
				[
					makeSplit({ id: 's1', expenseId: 'e1', memberId: 'a', shareCents: 500 }),
					makeSplit({ id: 's2', expenseId: 'e1', memberId: 'b', shareCents: 500 })
				]
			],
			[
				'e2',
				[
					makeSplit({ id: 's3', expenseId: 'e2', memberId: 'a', shareCents: 2500 }),
					makeSplit({ id: 's4', expenseId: 'e2', memberId: 'b', shareCents: 2500 })
				]
			]
		]);

		const balances = computeGroupBalances(expenses, splits);

		const a = balances.find((b) => b.memberId === 'a')!;
		const b = balances.find((b) => b.memberId === 'b')!;

		// Only e1 should count. If soft-delete filtering were broken,
		// a.paidCents would be 1000 (correct) but b.paidCents would
		// wrongly include 5000 from the deleted expense.
		expect(a.paidCents).toBe(1000);
		expect(a.owedCents).toBe(500);
		expect(b.paidCents).toBe(0);
		expect(b.owedCents).toBe(500);
	});

	it('handles a member who paid but has no split entry (fully covered by others)', () => {
		// a pays 1000 but is not part of the split at all (e.g. treating
		// someone as a group, "generous host" scenario).
		const expenses = [makeExpense({ id: 'e1', amountCents: 1000, paidByMemberId: 'a' })];
		const splits = new Map<string, Split[]>([
			['e1', [makeSplit({ id: 's1', expenseId: 'e1', memberId: 'b', shareCents: 1000 })]]
		]);

		const balances = computeGroupBalances(expenses, splits);

		const a = balances.find((b) => b.memberId === 'a')!;
		const b = balances.find((b) => b.memberId === 'b')!;

		expect(a.paidCents).toBe(1000);
		expect(a.owedCents).toBe(0);
		expect(a.netCents).toBe(1000);

		expect(b.paidCents).toBe(0);
		expect(b.owedCents).toBe(1000);
		expect(b.netCents).toBe(-1000);
	});

	it('always produces net balances summing to exactly zero across multiple expenses', () => {
		const expenses = [
			makeExpense({ id: 'e1', amountCents: 1000, paidByMemberId: 'a' }),
			makeExpense({ id: 'e2', amountCents: 2500, paidByMemberId: 'b' }),
			makeExpense({ id: 'e3', amountCents: 777, paidByMemberId: 'c' })
		];
		const splits = new Map<string, Split[]>([
			[
				'e1',
				[
					makeSplit({ id: 's1', expenseId: 'e1', memberId: 'a', shareCents: 334 }),
					makeSplit({ id: 's2', expenseId: 'e1', memberId: 'b', shareCents: 333 }),
					makeSplit({ id: 's3', expenseId: 'e1', memberId: 'c', shareCents: 333 })
				]
			],
			[
				'e2',
				[
					makeSplit({ id: 's4', expenseId: 'e2', memberId: 'a', shareCents: 834 }),
					makeSplit({ id: 's5', expenseId: 'e2', memberId: 'b', shareCents: 833 }),
					makeSplit({ id: 's6', expenseId: 'e2', memberId: 'c', shareCents: 833 })
				]
			],
			[
				'e3',
				[
					makeSplit({ id: 's7', expenseId: 'e3', memberId: 'a', shareCents: 259 }),
					makeSplit({ id: 's8', expenseId: 'e3', memberId: 'b', shareCents: 259 }),
					makeSplit({ id: 's9', expenseId: 'e3', memberId: 'c', shareCents: 259 })
				]
			]
		]);

		const balances = computeGroupBalances(expenses, splits);
		const totalNet = balances.reduce((acc, b) => acc + b.netCents, 0);
		expect(totalNet).toBe(0);
	});

	it('returns an empty array for a group with no expenses', () => {
		const balances = computeGroupBalances([], new Map());
		expect(balances).toEqual([]);
	});

	it('throws if net balances would not sum to zero (data integrity bug simulation)', () => {
		// Manually craft an inconsistent scenario: an expense with splits
		// that don't sum to its amountCents. This should never happen if
		// splitEngine.ts is used correctly, but computeGroupBalances should
		// still catch it as a safety net rather than silently returning
		// wrong balances.
		const expenses = [makeExpense({ id: 'e1', amountCents: 1000, paidByMemberId: 'a' })];
		const splits = new Map<string, Split[]>([
			[
				'e1',
				[
					// Splits only sum to 900, not 1000 — inconsistent data.
					makeSplit({ id: 's1', expenseId: 'e1', memberId: 'a', shareCents: 450 }),
					makeSplit({ id: 's2', expenseId: 'e1', memberId: 'b', shareCents: 450 })
				]
			]
		]);

		expect(() => computeGroupBalances(expenses, splits)).toThrow(/Zero-sum ledger violation/);
	});
});