-- =========================================================================
-- Splits had INSERT and SELECT policies but no UPDATE policy, so any
-- attempt to modify an existing split row was silently rejected by RLS
-- (default-deny when no policy matches). This blocked expense editing
-- entirely, since editing an expense's split allocation means updating
-- existing split rows (see updateExpenseLocal in writeHelpers.ts) rather
-- than deleting and recreating them — splits have no soft-delete column,
-- and hard-delete sync isn't implemented, so in-place updates (including
-- zeroing out a removed member's share_cents rather than deleting the
-- row) is the approach the app relies on.
-- =========================================================================
create policy "Approved members can update splits"
	on public.splits for update
	using (
		exists (
			select 1 from public.expenses e
			where e.id = expense_id and public.is_approved_member(e.group_id)
		)
	)
	with check (
		exists (
			select 1 from public.expenses e
			where e.id = expense_id and public.is_approved_member(e.group_id)
		)
	);
