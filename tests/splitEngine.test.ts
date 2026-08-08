// tests/splitEngine.test.ts
import { describe, it, expect } from 'vitest';
import {
	computeEqualSplit,
	computePercentageSplit,
	computeCustomSplit,
	SplitValidationError
} from '../src/lib/ledger/splitEngine';

describe('computeEqualSplit', () => {
	it('splits evenly when amount divides cleanly', () => {
		const result = computeEqualSplit({ amountCents: 3000, memberIds: ['a', 'b', 'c'] });
		expect(result).toEqual([
			{ memberId: 'a', shareCents: 1000, sharePercentage: null },
			{ memberId: 'b', shareCents: 1000, sharePercentage: null },
			{ memberId: 'c', shareCents: 1000, sharePercentage: null }
		]);
	});

	it('distributes remainder cents to first members deterministically', () => {
		const result = computeEqualSplit({ amountCents: 1000, memberIds: ['a', 'b', 'c'] });
		const total = result.reduce((acc, s) => acc + s.shareCents, 0);
		expect(total).toBe(1000);
		expect(result[0].shareCents).toBe(334);
		expect(result[1].shareCents).toBe(333);
		expect(result[2].shareCents).toBe(333);
	});

	it('is deterministic — same input always produces same output', () => {
		const input = { amountCents: 1001, memberIds: ['x', 'y', 'z'] };
		const result1 = computeEqualSplit(input);
		const result2 = computeEqualSplit(input);
		expect(result1).toEqual(result2);
	});

	it('throws on empty member list', () => {
		expect(() => computeEqualSplit({ amountCents: 1000, memberIds: [] })).toThrow(
			SplitValidationError
		);
	});

	it('throws on zero or negative amount', () => {
		expect(() => computeEqualSplit({ amountCents: 0, memberIds: ['a'] })).toThrow(
			SplitValidationError
		);
		expect(() => computeEqualSplit({ amountCents: -100, memberIds: ['a'] })).toThrow(
			SplitValidationError
		);
	});

	it('handles a single member (gets 100% of the amount)', () => {
		const result = computeEqualSplit({ amountCents: 500, memberIds: ['solo'] });
		expect(result).toEqual([{ memberId: 'solo', shareCents: 500, sharePercentage: null }]);
	});
});

describe('computePercentageSplit', () => {
	it('splits according to exact percentages when they divide cleanly', () => {
		const result = computePercentageSplit({
			amountCents: 10000,
			shares: [
				{ memberId: 'a', percentage: 50 },
				{ memberId: 'b', percentage: 50 }
			]
		});
		expect(result).toEqual([
			{ memberId: 'a', shareCents: 5000, sharePercentage: 50 },
			{ memberId: 'b', shareCents: 5000, sharePercentage: 50 }
		]);
	});

	it('reconciles rounding drift by adjusting the largest share', () => {
		const result = computePercentageSplit({
			amountCents: 1000,
			shares: [
				{ memberId: 'a', percentage: 33.33 },
				{ memberId: 'b', percentage: 33.33 },
				{ memberId: 'c', percentage: 33.34 }
			]
		});
		const total = result.reduce((acc, s) => acc + s.shareCents, 0);
		expect(total).toBe(1000);
		const cShare = result.find((s) => s.memberId === 'c')!;
		expect(cShare.shareCents).toBeGreaterThanOrEqual(334);
	});

	it('throws if percentages are far from summing to 100', () => {
		expect(() =>
			computePercentageSplit({
				amountCents: 1000,
				shares: [
					{ memberId: 'a', percentage: 50 },
					{ memberId: 'b', percentage: 30 }
				]
			})
		).toThrow(SplitValidationError);
	});

	it('always produces shares summing exactly to amountCents (fuzz-ish check)', () => {
		const testCases = [
			{ amountCents: 999, percentages: [33.33, 33.33, 33.34] },
			{ amountCents: 12345, percentages: [20, 20, 20, 20, 20] },
			{ amountCents: 1, percentages: [50, 50] },
			{ amountCents: 777, percentages: [10, 20, 30, 40] }
		];

		for (const tc of testCases) {
			const result = computePercentageSplit({
				amountCents: tc.amountCents,
				shares: tc.percentages.map((p, i) => ({ memberId: `m${i}`, percentage: p }))
			});
			const total = result.reduce((acc, s) => acc + s.shareCents, 0);
			expect(total).toBe(tc.amountCents);
		}
	});
});

describe('computeCustomSplit', () => {
	it('accepts exact matching shares', () => {
		const result = computeCustomSplit({
			amountCents: 1500,
			shares: [
				{ memberId: 'a', shareCents: 1000 },
				{ memberId: 'b', shareCents: 500 }
			]
		});
		expect(result).toEqual([
			{ memberId: 'a', shareCents: 1000, sharePercentage: null },
			{ memberId: 'b', shareCents: 500, sharePercentage: null }
		]);
	});

	it('throws if shares do not sum exactly to the total', () => {
		expect(() =>
			computeCustomSplit({
				amountCents: 1500,
				shares: [
					{ memberId: 'a', shareCents: 1000 },
					{ memberId: 'b', shareCents: 400 }
				]
			})
		).toThrow(SplitValidationError);
	});

	it('throws on negative shares', () => {
		expect(() =>
			computeCustomSplit({
				amountCents: 1000,
				shares: [
					{ memberId: 'a', shareCents: 1200 },
					{ memberId: 'b', shareCents: -200 }
				]
			})
		).toThrow(SplitValidationError);
	});
});