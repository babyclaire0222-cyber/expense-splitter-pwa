-- supabase/migrations/0001_init.sql

-- =========================================================================
-- EXTENSIONS
-- =========================================================================
create extension if not exists "pgcrypto";

-- =========================================================================
-- GROUPS
-- =========================================================================
create table public.groups (
	id uuid primary key,                          -- client-generated UUID, NOT gen_random_uuid()
	name text not null,
	currency text not null default 'USD',
	join_code text not null unique,
	created_by uuid not null references auth.users(id),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	deleted_at timestamptz
);

create index idx_groups_join_code on public.groups (join_code);
create index idx_groups_created_by on public.groups (created_by);

-- =========================================================================
-- MEMBERS
-- status: 'pending' until the group creator (or an admin) approves.
-- role: 'creator' is auto-approved at group-creation time.
-- =========================================================================
create table public.members (
	id uuid primary key,                          -- client-generated UUID
	group_id uuid not null references public.groups(id) on delete cascade,
	display_name text not null,
	auth_user_id uuid references auth.users(id),  -- null if added as a cash-only/unregistered member
	role text not null default 'member' check (role in ('creator', 'member')),
	status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
	approved_by uuid references auth.users(id),
	approved_at timestamptz,
	joined_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	deleted_at timestamptz
);

create index idx_members_group_id on public.members (group_id);
create index idx_members_auth_user_id on public.members (auth_user_id);
create unique index idx_members_group_authuser on public.members (group_id, auth_user_id)
	where auth_user_id is not null; -- one membership row per (group, user)

-- =========================================================================
-- EXPENSES
-- amount_cents is ALWAYS a positive integer. Never numeric/decimal.
-- =========================================================================
create table public.expenses (
	id uuid primary key,                          -- client-generated UUID
	group_id uuid not null references public.groups(id) on delete cascade,
	description text not null,
	amount_cents integer not null check (amount_cents > 0),
	currency text not null,
	paid_by_member_id uuid not null references public.members(id),
	split_type text not null check (split_type in ('equal', 'percentage', 'custom')),
	expense_date timestamptz not null,
	created_by_member_id uuid not null references public.members(id),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	deleted_at timestamptz,
	reversal_of_expense_id uuid references public.expenses(id)
);

create index idx_expenses_group_id on public.expenses (group_id);
create index idx_expenses_paid_by on public.expenses (paid_by_member_id);
create index idx_expenses_group_deleted on public.expenses (group_id, deleted_at);

-- =========================================================================
-- SPLITS
-- Sum of share_cents per expense_id MUST equal that expense's amount_cents.
-- Enforced in application code (Step 4), not a DB constraint, since Postgres
-- can't easily cross-row-sum-validate on insert without a trigger; we add
-- a trigger below as a safety net.
-- =========================================================================
create table public.splits (
	id uuid primary key,                          -- client-generated UUID
	expense_id uuid not null references public.expenses(id) on delete cascade,
	member_id uuid not null references public.members(id),
	share_cents integer not null check (share_cents >= 0),
	share_percentage numeric(5,2),                -- only used when split_type = 'percentage'
	updated_at timestamptz not null default now(),
	unique (expense_id, member_id)
);

create index idx_splits_expense_id on public.splits (expense_id);
create index idx_splits_member_id on public.splits (member_id);

-- Safety-net trigger: reject a split INSERT/UPDATE if the total for its
-- expense would no longer equal the expense's amount_cents. Runs AFTER
-- the row is written, checking the aggregate — this catches bugs in the
-- application-layer split engine (Step 4) before bad data reaches Postgres.
create or replace function public.check_split_sum() returns trigger as $$
declare
	v_expense_total integer;
	v_split_total integer;
begin
	select amount_cents into v_expense_total from public.expenses where id = new.expense_id;
	select coalesce(sum(share_cents), 0) into v_split_total from public.splits where expense_id = new.expense_id;

	if v_split_total <> v_expense_total then
		raise exception 'Split sum (%) does not match expense amount (%) for expense_id %',
			v_split_total, v_expense_total, new.expense_id;
	end if;
	return new;
end;
$$ language plpgsql;

create constraint trigger trg_check_split_sum
	after insert or update on public.splits
	deferrable initially deferred          -- deferred so multi-row split inserts in one transaction pass
	for each row execute function public.check_split_sum();

-- =========================================================================
-- AUDIT LOG — append-only. No UPDATE/DELETE grants (enforced via RLS below).
-- =========================================================================
create table public.audit_log (
	id uuid primary key,                          -- client-generated UUID
	entity_type text not null check (entity_type in ('expense', 'group', 'member')),
	entity_id uuid not null,
	action text not null check (action in ('create', 'edit', 'delete', 'reversal')),
	performed_by_member_id uuid not null references public.members(id),
	performed_at timestamptz not null default now(),
	snapshot jsonb not null
);

create index idx_audit_entity on public.audit_log (entity_type, entity_id);

-- =========================================================================
-- HELPER: is the current auth user an APPROVED member of a given group?
-- SECURITY DEFINER so RLS policies can call it without recursive RLS checks.
-- =========================================================================
create or replace function public.is_approved_member(p_group_id uuid) returns boolean as $$
	select exists (
		select 1 from public.members
		where group_id = p_group_id
		and auth_user_id = auth.uid()
		and status = 'approved'
		and deleted_at is null
	);
$$ language sql security definer stable;

-- =========================================================================
-- HELPER: is the current auth user the creator/admin of a given group?
-- =========================================================================
create or replace function public.is_group_creator(p_group_id uuid) returns boolean as $$
	select exists (
		select 1 from public.members
		where group_id = p_group_id
		and auth_user_id = auth.uid()
		and role = 'creator'
		and status = 'approved'
		and deleted_at is null
	);
$$ language sql security definer stable;

-- =========================================================================
-- JOIN-BY-CODE: the only way a client creates a pending membership row.
-- SECURITY DEFINER so the client never needs SELECT access to groups.join_code.
-- =========================================================================
create or replace function public.join_group_by_code(
	p_code text,
	p_member_id uuid,       -- client-generated UUID for the new membership row
	p_display_name text
) returns uuid as $$
declare
	v_group_id uuid;
begin
	select id into v_group_id from public.groups where join_code = p_code and deleted_at is null;

	if v_group_id is null then
		raise exception 'Invalid join code';
	end if;

	insert into public.members (id, group_id, display_name, auth_user_id, role, status)
	values (p_member_id, v_group_id, p_display_name, auth.uid(), 'member', 'pending')
	on conflict (group_id, auth_user_id) where auth_user_id is not null
	do nothing; -- idempotent: re-clicking a join link doesn't error

	return v_group_id;
end;
$$ language plpgsql security definer;

-- =========================================================================
-- ROW LEVEL SECURITY
-- =========================================================================
alter table public.groups enable row level security;
alter table public.members enable row level security;
alter table public.expenses enable row level security;
alter table public.splits enable row level security;
alter table public.audit_log enable row level security;

-- GROUPS: only approved members can read; only the creator (via the
-- group-creation flow, service-role insert) can insert directly.
-- Regular clients never INSERT into groups directly with a bare policy —
-- group creation is handled in Step 3's client code via a single transaction
-- that also inserts the creator's own approved membership row.
create policy "Approved members can view their group"
	on public.groups for select
	using (public.is_approved_member(id));

create policy "Any authenticated user can create a group"
	on public.groups for insert
	with check (auth.uid() = created_by);

create policy "Group creator can update group"
	on public.groups for update
	using (public.is_group_creator(id));

-- MEMBERS: a user can always see their OWN membership row (so a pending
-- user can see their own pending status). Approved members can see all
-- OTHER approved members in their group. Creators can see pending rows
-- too, so they have something to approve.
create policy "Users can view their own membership row"
	on public.members for select
	using (auth_user_id = auth.uid());

create policy "Approved members can view other approved members"
	on public.members for select
	using (
		status = 'approved'
		and public.is_approved_member(group_id)
	);

create policy "Creator can view pending members to approve them"
	on public.members for select
	using (public.is_group_creator(group_id));

create policy "Creator can approve or reject pending members"
	on public.members for update
	using (public.is_group_creator(group_id));

-- Direct INSERT into members is intentionally NOT allowed for regular
-- clients — creation happens via join_group_by_code() (pending members)
-- or as part of the group-creation transaction (creator's own row).

-- EXPENSES: only approved members can read or write.
create policy "Approved members can view group expenses"
	on public.expenses for select
	using (public.is_approved_member(group_id));

create policy "Approved members can create expenses"
	on public.expenses for insert
	with check (public.is_approved_member(group_id));

create policy "Approved members can update expenses"
	on public.expenses for update
	using (public.is_approved_member(group_id));

-- SPLITS: gated through the parent expense's group.
create policy "Approved members can view splits"
	on public.splits for select
	using (
		exists (
			select 1 from public.expenses e
			where e.id = expense_id and public.is_approved_member(e.group_id)
		)
	);

create policy "Approved members can create splits"
	on public.splits for insert
	with check (
		exists (
			select 1 from public.expenses e
			where e.id = expense_id and public.is_approved_member(e.group_id)
		)
	);

-- AUDIT LOG: insert + select only. No update/delete policy exists at all,
-- which means those operations are rejected outright — this is what makes
-- "immutable" enforced at the database level.
create policy "Approved members can view audit log for their groups"
	on public.audit_log for select
	using (
		exists (
			select 1 from public.members m
			where m.id = performed_by_member_id and public.is_approved_member(m.group_id)
		)
	);

create policy "Approved members can insert audit log entries"
	on public.audit_log for insert
	with check (
		exists (
			select 1 from public.members m
			where m.id = performed_by_member_id and public.is_approved_member(m.group_id)
		)
	);