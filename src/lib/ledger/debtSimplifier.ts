// src/lib/ledger/debtSimplifier.ts
import type { MemberBalance } from './balances';

/**
 * A single suggested payment to settle debts: fromMemberId pays
 * toMemberId amountCents.
 */
export interface SettlementTransfer {
	fromMemberId: string;
	toMemberId: string;
	amountCents: number;
}

/**
 * GREEDY DEBT SIMPLIFICATION
 *
 * Given each member's net balance, produces the minimum-ish set of
 * transfers to settle all debts, using a greedy heuristic:
 *
 * 1. Split members into creditors (netCents > 0, owed money) and
 *    debtors (netCents < 0, owe money).
 * 2. Repeatedly take the debtor who owes the MOST and the creditor who
 *    is owed the MOST. Settle min(|debtorAmount|, creditorAmount)
 *    between them.
 * 3. Whichever side hits zero first drops out; the other carries their
 *    remaining balance into the next round.
 * 4. Repeat until all balances are zero.
 */
export function simplifyDebts(balances: MemberBalance[]): SettlementTransfer[] {
	const creditors = balances
		.filter((b) => b.netCents > 0)
		.map((b) => ({ memberId: b.memberId, amountCents: b.netCents }));

	const debtors = balances
		.filter((b) => b.netCents < 0)
		.map((b) => ({ memberId: b.memberId, amountCents: -b.netCents }));

	const totalCredit = creditors.reduce((acc, c) => acc + c.amountCents, 0);
	const totalDebt = debtors.reduce((acc, d) => acc + d.amountCents, 0);
	if (totalCredit !== totalDebt) {
		throw new Error(
			`Debt simplification input is not zero-sum: total credit ${totalCredit} != total debt ${totalDebt}.`
		);
	}

	const transfers: SettlementTransfer[] = [];

	while (creditors.length > 0 && debtors.length > 0) {
		creditors.sort((a, b) => b.amountCents - a.amountCents);
		debtors.sort((a, b) => b.amountCents - a.amountCents);

		const topCreditor = creditors[0];
		const topDebtor = debtors[0];

		const settleAmount = Math.min(topCreditor.amountCents, topDebtor.amountCents);

		if (settleAmount > 0) {
			transfers.push({
				fromMemberId: topDebtor.memberId,
				toMemberId: topCreditor.memberId,
				amountCents: settleAmount
			});
		}

		topCreditor.amountCents -= settleAmount;
		topDebtor.amountCents -= settleAmount;

		if (topCreditor.amountCents === 0) creditors.shift();
		if (topDebtor.amountCents === 0) debtors.shift();
	}

	return transfers;
}