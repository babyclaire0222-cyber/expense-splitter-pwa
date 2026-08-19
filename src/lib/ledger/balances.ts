// src/lib/ledger/balances.ts
import type { Expense, Split, Settlement } from '$lib/db/types';

/**
 * Net balance for a single member within a group.
 * Positive netCents = this member is OWED money overall.
 * Negative netCents = this member OWES money overall.
 * paidCents / owedCents are the raw components, kept for display purposes
 * (e.g. "You paid $120, your share was $40, you're owed $80") — these
 * reflect EXPENSES only. A settlement isn't a paid/owed expense share, so
 * it adjusts netCents directly rather than these two fields.
 */
export interface MemberBalance {
	memberId: string;
	paidCents: number; // sum of amountCents for expenses this member paid
	owedCents: number; // sum of shareCents across all splits this member is part of
	netCents: number; // paidCents - owedCents, then adjusted by settlements
}

/**
 * Computes net balances for every member in a group, given that group's
 * active (non-deleted) expenses and their associated splits, optionally
 * adjusted by recorded settlements (real payments made outside of any
 * expense — see recordSettlementLocal in writeHelpers.ts).
 *
 * INVARIANT: the sum of all netCents in the returned array MUST equal 0.
 * This holds for the expense/split portion because every split's
 * shareCents are drawn from the same expense's amountCents (see
 * splitEngine.ts assertSumMatches), and every expense's amountCents is
 * fully attributed to its payer's paidCents. It continues to hold after
 * settlements because each settlement moves the same amountCents from
 * one member's balance to another's (fromMemberId +amountCents,
 * toMemberId -amountCents) — a settlement can shift the total between
 * members but never changes it. We assert this invariant explicitly
 * below as a safety net.
 */
export function computeGroupBalances(
	expenses: Expense[],
	splitsByExpenseId: Map<string, Split[]>,
	settlements: Settlement[] = []
): MemberBalance[] {
	const balanceMap = new Map<string, MemberBalance>();

	function getOrCreate(memberId: string): MemberBalance {
		let bal = balanceMap.get(memberId);
		if (!bal) {
			bal = { memberId, paidCents: 0, owedCents: 0, netCents: 0 };
			balanceMap.set(memberId, bal);
		}
		return bal;
	}

	// Only consider active (non-deleted) expenses. Deleted expenses are
	// handled via compensating reversal expenses (see Immutability rule),
	// so a soft-deleted expense's original splits should never be counted.
	const activeExpenses = expenses.filter((e) => e.deletedAt === null);

	for (const expense of activeExpenses) {
		const payerBalance = getOrCreate(expense.paidByMemberId);
		payerBalance.paidCents += expense.amountCents;

		const splits = splitsByExpenseId.get(expense.id) ?? [];
		for (const split of splits) {
			const memberBalance = getOrCreate(split.memberId);
			memberBalance.owedCents += split.shareCents;
		}
	}

	const balances = Array.from(balanceMap.values()).map((bal) => ({
		...bal,
		netCents: bal.paidCents - bal.owedCents
	}));

	// IMPORTANT: from here on we mutate entries in `balances` itself (via
	// this second map, keyed to the same objects), not `balanceMap` — the
	// .map() above created copies, so adjusting the original balanceMap
	// objects would silently not show up in what this function returns.
	const balanceByMemberId = new Map(balances.map((b) => [b.memberId, b]));

	function getOrCreateFinal(memberId: string): MemberBalance {
		let bal = balanceByMemberId.get(memberId);
		if (!bal) {
			bal = { memberId, paidCents: 0, owedCents: 0, netCents: 0 };
			balanceByMemberId.set(memberId, bal);
			balances.push(bal);
		}
		return bal;
	}

	const activeSettlements = settlements.filter((s) => s.deletedAt === null);
	for (const settlement of activeSettlements) {
		const payer = getOrCreateFinal(settlement.fromMemberId);
		const recipient = getOrCreateFinal(settlement.toMemberId);

		payer.netCents += settlement.amountCents;
		recipient.netCents -= settlement.amountCents;
	}

	// Safety net: zero-sum ledger invariant.
	const totalNet = balances.reduce((acc, b) => acc + b.netCents, 0);
	if (totalNet !== 0) {
		throw new Error(
			`Zero-sum ledger violation: net balances sum to ${totalNet} cents, expected 0. ` +
				`This indicates a bug in expense/split data integrity.`
		);
	}

	return balances;
}