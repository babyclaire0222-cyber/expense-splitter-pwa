-- =============================================================================
-- Group Expenses Migration & Seed Script
-- Includes pre-population of parent tables (groups, members) to resolve:
-- ERROR: 23503 foreign key constraint "expenses_group_id_fkey"
-- =============================================================================

BEGIN;

-- 1. Ensure Groups table entry exists
INSERT INTO public.groups (id, name, created_at, updated_at)
VALUES (
    '11111111-1111-4111-8111-111111111111'::uuid, 
    'Annual Group Weekend Getaway', 
    NOW(), 
    NOW()
)
ON CONFLICT (id) DO NOTHING;

-- 2. Ensure Member table entries exist
INSERT INTO public.members (id, group_id, name, created_at, updated_at)
VALUES 
    ('a1111111-1111-4111-8111-111111111111'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Alice', NOW(), NOW()),
    ('b2222222-2222-4222-8222-222222222222'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Bob', NOW(), NOW()),
    ('c3333333-3333-4333-8333-333333333333'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Charlie', NOW(), NOW()),
    ('d4444444-4444-4444-8444-444444444444'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Diana', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- 3. Insert Expenses
INSERT INTO public.expenses (
    id,
    group_id,
    description,
    amount_cents,
    currency,
    paid_by_member_id,
    split_type,
    expense_date,
    created_by_member_id,
    created_at,
    updated_at,
    deleted_at,
    reversal_of_expense_id
)
VALUES
    ('exp-00000001-0000-4000-8000-000000000001'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Airbnb Luxury Villa Reservation (3 Nights)', 120000, 'USD', 'a1111111-1111-4111-8111-111111111111'::uuid, 'equal', '2026-08-01T10:00:00Z'::timestamptz, 'a1111111-1111-4111-8111-111111111111'::uuid, '2026-08-01T10:15:00Z'::timestamptz, '2026-08-01T10:15:00Z'::timestamptz, NULL, NULL),
    ('exp-00000002-0000-4000-8000-000000000002'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Van Rental & Fuel Pre-payment', 35000, 'USD', 'b2222222-2222-4222-8222-222222222222'::uuid, 'equal', '2026-08-01T14:30:00Z'::timestamptz, 'b2222222-2222-4222-8222-222222222222'::uuid, '2026-08-01T14:45:00Z'::timestamptz, '2026-08-01T14:45:00Z'::timestamptz, NULL, NULL),
    ('exp-00000003-0000-4000-8000-000000000003'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Group Welcome Dinner at Oceanview Bistro', 36000, 'USD', 'c3333333-3333-4333-8333-333333333333'::uuid, 'custom', '2026-08-02T19:00:00Z'::timestamptz, 'c3333333-3333-4333-8333-333333333333'::uuid, '2026-08-02T19:20:00Z'::timestamptz, '2026-08-02T19:20:00Z'::timestamptz, NULL, NULL),
    ('exp-00000004-0000-4000-8000-000000000004'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Guided Kayak & Snorkeling Tour', 52000, 'USD', 'a1111111-1111-4111-8111-111111111111'::uuid, 'equal', '2026-08-02T10:15:00Z'::timestamptz, 'a1111111-1111-4111-8111-111111111111'::uuid, '2026-08-02T10:30:00Z'::timestamptz, '2026-08-02T10:30:00Z'::timestamptz, NULL, NULL),
    ('exp-00000005-0000-4000-8000-000000000005'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'BBQ Supplies & Beverages', 22050, 'USD', 'd4444444-4444-4444-8444-444444444444'::uuid, 'percentage', '2026-08-03T11:00:00Z'::timestamptz, 'd4444444-4444-4444-8444-444444444444'::uuid, '2026-08-03T11:15:00Z'::timestamptz, '2026-08-03T11:15:00Z'::timestamptz, NULL, NULL),
    ('exp-00000006-0000-4000-8000-000000000006'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Lakeside Lunch & Refreshments', 22400, 'USD', 'b2222222-2222-4222-8222-222222222222'::uuid, 'equal', '2026-08-03T13:00:00Z'::timestamptz, 'b2222222-2222-4222-8222-222222222222'::uuid, '2026-08-03T13:10:00Z'::timestamptz, '2026-08-03T13:10:00Z'::timestamptz, NULL, NULL),
    ('exp-00000007-0000-4000-8000-000000000007'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Sunset Catamaran Cruise', 68000, 'USD', 'c3333333-3333-4333-8333-333333333333'::uuid, 'equal', '2026-08-03T17:30:00Z'::timestamptz, 'c3333333-3333-4333-8333-333333333333'::uuid, '2026-08-03T17:45:00Z'::timestamptz, '2026-08-03T17:45:00Z'::timestamptz, NULL, NULL),
    ('exp-00000008-0000-4000-8000-000000000008'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Highway Tolls & Parking Passes', 4200, 'USD', 'd4444444-4444-4444-8444-444444444444'::uuid, 'equal', '2026-08-04T09:00:00Z'::timestamptz, 'd4444444-4444-4444-8444-444444444444'::uuid, '2026-08-04T09:05:00Z'::timestamptz, '2026-08-04T09:05:00Z'::timestamptz, NULL, NULL),
    ('exp-00000009-0000-4000-8000-000000000009'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Farewell Brunch', 26000, 'USD', 'a1111111-1111-4111-8111-111111111111'::uuid, 'custom', '2026-08-04T11:30:00Z'::timestamptz, 'a1111111-1111-4111-8111-111111111111'::uuid, '2026-08-04T11:40:00Z'::timestamptz, '2026-08-04T11:40:00Z'::timestamptz, NULL, NULL),
    ('exp-00000010-0000-4000-8000-000000000010'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Group Board Games & Ice', 3500, 'USD', 'b2222222-2222-4222-8222-222222222222'::uuid, 'equal', '2026-08-04T15:00:00Z'::timestamptz, 'b2222222-2222-4222-8222-222222222222'::uuid, '2026-08-04T15:10:00Z'::timestamptz, '2026-08-04T15:10:00Z'::timestamptz, NULL, NULL),
    ('exp-00000011-0000-4000-8000-000000000011'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'Reversal of Welcome Dinner', 36000, 'USD', 'c3333333-3333-4333-8333-333333333333'::uuid, 'custom', '2026-08-02T22:00:00Z'::timestamptz, 'c3333333-3333-4333-8333-333333333333'::uuid, '2026-08-02T22:00:00Z'::timestamptz, '2026-08-02T22:00:00Z'::timestamptz, NULL, 'exp-00000003-0000-4000-8000-000000000003'::uuid)
ON CONFLICT (id) DO UPDATE SET
    description = EXCLUDED.description,
    amount_cents = EXCLUDED.amount_cents,
    currency = EXCLUDED.currency,
    paid_by_member_id = EXCLUDED.paid_by_member_id,
    split_type = EXCLUDED.split_type,
    expense_date = EXCLUDED.expense_date,
    updated_at = NOW();

COMMIT;
