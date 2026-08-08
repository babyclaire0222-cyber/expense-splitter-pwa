// src/lib/ledger/splitEngine.ts
import type { Split, SplitType } from '$lib/db/types';

/**
 * Input shape for computing a split. memberIds order matters for equal-split
 * remainder distribution — it must be deterministic given the same input.
 */
export interface EqualSplitInput {
	amountCents: number;
	memberIds: string[];
}

export interface PercentageSplitInput {
	amountCents: number;
	// Each entry: { memberId, percentage } — percentages should sum to ~100,
	// but we tolerate small floating input error (e.g. 33.33 * 3 = 99.99).
	shares: { memberId: string; percentage: number }[];
}

export interface CustomSplitInput {
	amountCents: number;
	// Each entry: { memberId, shareCents } — MUST sum exactly to amountCents.
	shares: { memberId: string; shareCents: number }[];
}

/**
 * Result of a split computation: memberId -> shareCents, plus optional
 * sharePercentage for percentage-type splits (stored for display/audit).
 */
export interface ComputedShare {
	memberId: string;
	shareCents: number;
	sharePercentage: number | null;
}

export class SplitValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SplitValidationError';
	}
}

/**
 * Asserts that a set of computed shares sums exactly to the expense total.
 * This is our zero-sum-per-expense invariant — called at the end of every
 * split function before returning, as a defense-in-depth check.
 */
function assertSumMatches(shares: ComputedShare[], amountCents: number): void {
	const sum = shares.reduce((acc, s) => acc + s.shareCents, 0);
	if (sum !== amountCents) {
		throw new SplitValidationError(
			`Computed split shares sum to ${sum} cents but expense total is ${amountCents} cents. ` +
				`This is a bug in the split engine — shares must always sum exactly to the total.`
		);
	}
}

/**
 * EQUAL SPLIT
 * Divides amountCents evenly across memberIds. Since cents are integers,
 * the division may not be even — the remainder (1 to N-1 cents) is
 * distributed one cent at a time to the FIRST members in the array,
 * in order. This is deterministic: the same memberIds array in the same
 * order always produces the same result.
 */
export function computeEqualSplit(input: EqualSplitInput): ComputedShare[] {
	const { amountCents, memberIds } = input;

	if (memberIds.length === 0) {
		throw new SplitValidationError('Cannot split an expense with zero members.');
	}
	if (amountCents <= 0) {
		throw new SplitValidationError('Expense amount must be a positive integer number of cents.');
	}

	const baseShare = Math.floor(amountCents / memberIds.length);
	const remainder = amountCents - baseShare * memberIds.length;

	const shares: ComputedShare[] = memberIds.map((memberId, index) => ({
		memberId,
		// First `remainder` members get one extra cent each.
		shareCents: baseShare + (index < remainder ? 1 : 0),
		sharePercentage: null
	}));

	assertSumMatches(shares, amountCents);
	return shares;
}

/**
 * PERCENTAGE SPLIT
 * Each member's raw share = round(amountCents * percentage / 100).
 * Rounding can cause the sum to drift from amountCents by a few cents
 * in either direction. We reconcile by adjusting the LARGEST share
 * (by percentage) up or down to absorb the drift — this minimizes the
 * relative distortion to any single member's stated percentage.
 */
export function computePercentageSplit(input: PercentageSplitInput): ComputedShare[] {
	const { amountCents, shares: rawShares } = input;

	if (rawShares.length === 0) {
		throw new SplitValidationError('Cannot split an expense with zero members.');
	}
	if (amountCents <= 0) {
		throw new SplitValidationError('Expense amount must be a positive integer number of cents.');
	}

	const totalPercentage = rawShares.reduce((acc, s) => acc + s.percentage, 0);
	// Allow small floating-point tolerance (e.g. 33.33 * 3 = 99.99, or 33.34*3=100.02)
	if (Math.abs(totalPercentage - 100) > 1) {
		throw new SplitValidationError(
			`Percentages must sum to approximately 100 (got ${totalPercentage}).`
		);
	}

	const computed: ComputedShare[] = rawShares.map((s) => ({
		memberId: s.memberId,
		shareCents: Math.round((amountCents * s.percentage) / 100),
		sharePercentage: s.percentage
	}));

	const sum = computed.reduce((acc, s) => acc + s.shareCents, 0);
	const drift = amountCents - sum; // positive = we owe cents, negative = we have extra cents

	if (drift !== 0) {
		// Find the largest share by percentage and adjust it to absorb the drift.
		let largestIndex = 0;
		for (let i = 1; i < computed.length; i++) {
			if ((computed[i].sharePercentage ?? 0) > (computed[largestIndex].sharePercentage ?? 0)) {
				largestIndex = i;
			}
		}
		computed[largestIndex].shareCents += drift;
	}

	assertSumMatches(computed, amountCents);
	return computed;
}

/**
 * CUSTOM SPLIT
 * User specifies exact cents per member. No reconciliation is performed —
 * if the shares don't sum exactly to amountCents, we reject the input
 * outright. Custom split means the user is asserting exact amounts, so
 * silently adjusting a value here would be worse than an explicit error.
 */
export function computeCustomSplit(input: CustomSplitInput): ComputedShare[] {
	const { amountCents, shares: rawShares } = input;

	if (rawShares.length === 0) {
		throw new SplitValidationError('Cannot split an expense with zero members.');
	}
	if (amountCents <= 0) {
		throw new SplitValidationError('Expense amount must be a positive integer number of cents.');
	}
	if (rawShares.some((s) => s.shareCents < 0)) {
		throw new SplitValidationError('Custom split shares cannot be negative.');
	}

	const sum = rawShares.reduce((acc, s) => acc + s.shareCents, 0);
	if (sum !== amountCents) {
		throw new SplitValidationError(
			`Custom split shares sum to ${sum} cents but expense total is ${amountCents} cents. ` +
				`Adjust the amounts so they sum exactly.`
		);
	}

	const shares: ComputedShare[] = rawShares.map((s) => ({
		memberId: s.memberId,
		shareCents: s.shareCents,
		sharePercentage: null
	}));

	assertSumMatches(shares, amountCents);
	return shares;
}

/**
 * Dispatches to the correct split function based on splitType. Useful for
 * generic call sites (e.g. the expense form) that don't know the split
 * type at compile time.
 */
export function computeSplit(
	splitType: SplitType,
	input: EqualSplitInput | PercentageSplitInput | CustomSplitInput
): ComputedShare[] {
	switch (splitType) {
		case 'equal':
			return computeEqualSplit(input as EqualSplitInput);
		case 'percentage':
			return computePercentageSplit(input as PercentageSplitInput);
		case 'custom':
			return computeCustomSplit(input as CustomSplitInput);
		default:
			throw new SplitValidationError(`Unknown split type: ${splitType}`);
	}
}

/**
 * Converts ComputedShare[] into full Split records ready for Dexie insertion.
 * Called by the expense-creation flow (built in a later step).
 */
export function computedSharesToSplits(
	expenseId: string,
	computedShares: ComputedShare[],
	generateId: () => string,
	nowIso: string
): Split[] {
	return computedShares.map((cs) => ({
		id: generateId(),
		expenseId,
		memberId: cs.memberId,
		shareCents: cs.shareCents,
		sharePercentage: cs.sharePercentage,
		syncStatus: 'pending' as const,
		updatedAt: nowIso
	}));
}