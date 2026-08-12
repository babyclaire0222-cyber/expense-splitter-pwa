-- supabase/seed.sql
-- Test/seed data for local development and manual testing.
-- IMPORTANT: replace 'YOUR_AUTH_USER_ID' below with a real UUID from
-- auth.users (Dashboard -> Authentication -> Users -> copy the UID column).
-- This script is NOT auto-applied by `supabase db push` (that only runs
-- migrations/). Run this manually in the SQL Editor, or via:
--   psql <connection-string> -f supabase/seed.sql

-- =========================================================================
-- CONFIG: set this once, it's referenced throughout via a CTE-friendly variable
-- =========================================================================
do $$
declare
	v_auth_user_id uuid := '195d7d4e-f2e4-473c-9ee8-06630214013c'; -- <-- REPLACE THIS
	v_group_id uuid := 'a0000000-0000-4000-8000-000000000001';
	v_member_creator uuid := 'b0000000-0000-4000-8000-000000000001';
	v_member_alex uuid := 'b0000000-0000-4000-8000-000000000002';
	v_member_sam uuid := 'b0000000-0000-4000-8000-000000000003';
	v_member_jo uuid := 'b0000000-0000-4000-8000-000000000004';
	v_member_pending uuid := 'b0000000-0000-4000-8000-000000000005';
	v_expense_dinner uuid := 'c0000000-0000-4000-8000-000000000001';
	v_expense_taxi uuid := 'c0000000-0000-4000-8000-000000000002';
	v_expense_hotel uuid := 'c0000000-0000-4000-8000-000000000003';
begin
	-- ===================================================================
	-- GROUP
	-- ===================================================================
	insert into public.groups (id, name, currency, join_code, created_by)
	values (v_group_id, 'Bali Trip 2026', 'USD', 'BALI2026', v_auth_user_id);

	-- ===================================================================
	-- MEMBERS
	-- 'creator' is the real auth user, auto-approved.
	-- alex/sam/jo are cash-only test members (no auth account), pre-approved
	-- so you can test balances/splits/UI immediately.
	-- 'pending' is left unapproved to test the approval-gating flow.
	-- ===================================================================
	insert into public.members (id, group_id, display_name, auth_user_id, role, status, approved_by, approved_at)
	values
		(v_member_creator, v_group_id, 'You', v_auth_user_id, 'creator', 'approved', v_auth_user_id, now()),
		(v_member_alex, v_group_id, 'Alex', null, 'member', 'approved', v_auth_user_id, now()),
		(v_member_sam, v_group_id, 'Sam', null, 'member', 'approved', v_auth_user_id, now()),
		(v_member_jo, v_group_id, 'Jo', null, 'member', 'approved', v_auth_user_id, now()),
		(v_member_pending, v_group_id, 'Pending Pat', null, 'member', 'pending', null, null);

	-- ===================================================================
	-- EXPENSE 1: Dinner, $84.00, EQUAL split across 4 approved members
	-- Paid by "You". 8400 / 4 = 2100 each, divides cleanly.
	-- ===================================================================
	insert into public.expenses
		(id, group_id, description, amount_cents, currency, paid_by_member_id, split_type, expense_date, created_by_member_id)
	values
		(v_expense_dinner, v_group_id, 'Group dinner - Warung Babi Guling', 8400, 'USD', v_member_creator, 'equal', now() - interval '2 days', v_member_creator);

	insert into public.splits (id, expense_id, member_id, share_cents, share_percentage)
	values
		(gen_random_uuid(), v_expense_dinner, v_member_creator, 2100, null),
		(gen_random_uuid(), v_expense_dinner, v_member_alex, 2100, null),
		(gen_random_uuid(), v_expense_dinner, v_member_sam, 2100, null),
		(gen_random_uuid(), v_expense_dinner, v_member_jo, 2100, null);

	-- ===================================================================
	-- EXPENSE 2: Taxi, $30.00, PERCENTAGE split (50/30/20) across 3 members
	-- Paid by Alex. 3000 * 0.5=1500, *0.3=900, *0.2=600 -> sums exactly.
	-- ===================================================================
	insert into public.expenses
		(id, group_id, description, amount_cents, currency, paid_by_member_id, split_type, expense_date, created_by_member_id)
	values
		(v_expense_taxi, v_group_id, 'Airport taxi', 3000, 'USD', v_member_alex, 'percentage', now() - interval '1 day', v_member_alex);

	insert into public.splits (id, expense_id, member_id, share_cents, share_percentage)
	values
		(gen_random_uuid(), v_expense_taxi, v_member_creator, 1500, 50.00),
		(gen_random_uuid(), v_expense_taxi, v_member_alex, 900, 30.00),
		(gen_random_uuid(), v_expense_taxi, v_member_sam, 600, 20.00);

	-- ===================================================================
	-- EXPENSE 3: Hotel, $450.00, CUSTOM split across 3 members
	-- Paid by Sam. Custom amounts must sum exactly to 45000.
	-- ===================================================================
	insert into public.expenses
		(id, group_id, description, amount_cents, currency, paid_by_member_id, split_type, expense_date, created_by_member_id)
	values
		(v_expense_hotel, v_group_id, 'Hotel - 3 nights (2 rooms, uneven split)', 45000, 'USD', v_member_sam, 'custom', now(), v_member_sam);

	insert into public.splits (id, expense_id, member_id, share_cents, share_percentage)
	values
		(gen_random_uuid(), v_expense_hotel, v_member_creator, 20000, null), -- had the bigger room
		(gen_random_uuid(), v_expense_hotel, v_member_sam, 15000, null),
		(gen_random_uuid(), v_expense_hotel, v_member_jo, 10000, null);

	-- ===================================================================
	-- AUDIT LOG: one 'create' entry per expense, snapshotting key fields
	-- ===================================================================
	insert into public.audit_log (id, entity_type, entity_id, action, performed_by_member_id, snapshot)
	values
		(gen_random_uuid(), 'expense', v_expense_dinner, 'create', v_member_creator,
			jsonb_build_object('amountCents', 8400, 'description', 'Group dinner - Warung Babi Guling', 'splitType', 'equal')),
		(gen_random_uuid(), 'expense', v_expense_taxi, 'create', v_member_alex,
			jsonb_build_object('amountCents', 3000, 'description', 'Airport taxi', 'splitType', 'percentage')),
		(gen_random_uuid(), 'expense', v_expense_hotel, 'create', v_member_sam,
			jsonb_build_object('amountCents', 45000, 'description', 'Hotel - 3 nights (2 rooms, uneven split)', 'splitType', 'custom'));

end $$;