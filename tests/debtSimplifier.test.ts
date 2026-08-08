// tests/debtSimplifier.test.ts
import { describe, it, expect } from 'vitest';
import { simplifyDebts, type SettlementTransfer } from '../src/lib/ledger/debtSimplifier';
import type { MemberBalance } from '../src/lib/ledger/balances';

function makeBalance(memberId: string, netCents: number): MemberBalance {
	return { memberId, paidCents: 0, owedCents: 0, netCents };
}

function totalTransferred(transfers: SettlementTransfer[]): number {
	return transfers.reduce((acc, t) => acc + t.amountCents, 0);
}

describe('simplifyDebts', () => {
	it('produces a single transfer for a simple two-person debt', () => {
		const balances = [makeBalance('a', 1000), makeBalance('b', -1000)];
		const transfers = simplifyDebts(balances);
		expect(transfers).toEqual([{ fromMemberId: 'b', toMemberId: 'a', amountCents: 1000 }]);
	});

	it('returns no transfers when everyone is already settled', () => {
		const balances = [makeBalance('a', 0), makeBalance('b', 0)];
		expect(simplifyDebts(balances)).toEqual([]);
	});

	it('minimizes transfer count vs naive pairwise settlement (3 members)', () => {
		const balances = [makeBalance('a', 300), makeBalance('b', -100), makeBalance('c', -200)];
		const transfers = simplifyDebts(balances);
		expect(transfers.length).toBe(2);
		expect(totalTransferred(transfers)).toBe(300);
	});

	it('handles multiple creditors and debtors, always settling to zero net', () => {
		const balances = [
			makeBalance('a', 500),
			makeBalance('b', 300),
			makeBalance('c', -400),
			makeBalance('d', -400)
		];
		const transfers = simplifyDebts(balances);

		const netFromTransfers = new Map<string, number>();
		for (const b of balances) netFromTransfers.set(b.memberId, 0);
		for (const t of transfers) {
			netFromTransfers.set(
				t.fromMemberId,
				(netFromTransfers.get(t.fromMemberId) ?? 0) - t.amountCents
			);
			netFromTransfers.set(
				t.toMemberId,
				(netFromTransfers.get(t.toMemberId) ?? 0) + t.amountCents
			);
		}
		for (const b of balances) {
			expect(netFromTransfers.get(b.memberId)).toBe(b.netCents);
		}
	});

	it('never produces a transfer with zero or negative amount', () => {
		const balances = [makeBalance('a', 1000), makeBalance('b', -400), makeBalance('c', -600)];
		const transfers = simplifyDebts(balances);
		for (const t of transfers) {
			expect(t.amountCents).toBeGreaterThan(0);
		}
	});

	it('throws if input balances are not zero-sum', () => {
		const balances = [makeBalance('a', 1000), makeBalance('b', -900)];
		expect(() => simplifyDebts(balances)).toThrow(/not zero-sum/);
	});

	it('handles a larger randomized-ish group and always fully settles', () => {
		const balances = [
			makeBalance('a', 1234),
			makeBalance('b', 2000),
			makeBalance('c', -500),
			makeBalance('d', -1734),
			makeBalance('e', -1000)
		];
		const transfers = simplifyDebts(balances);

		const netFromTransfers = new Map<string, number>();
		for (const b of balances) netFromTransfers.set(b.memberId, 0);
		for (const t of transfers) {
			netFromTransfers.set(
				t.fromMemberId,
				(netFromTransfers.get(t.fromMemberId) ?? 0) - t.amountCents
			);
			netFromTransfers.set(
				t.toMemberId,
				(netFromTransfers.get(t.toMemberId) ?? 0) + t.amountCents
			);
		}
		for (const b of balances) {
			expect(netFromTransfers.get(b.memberId)).toBe(b.netCents);
		}
	});
});