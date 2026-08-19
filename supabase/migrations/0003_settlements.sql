-- =========================================================================
-- SETTLEMENTS
-- Records a real payment made between two members OUTSIDE of any shared
-- expense (e.g. handing someone cash to square up what they owed). This
-- is what makes the "Settle up" page's suggested transfers actually
-- recordable — previously that page only ever displayed calculated
-- suggestions with no way to mark one as paid.
--
-- Treated as an immutable historical fact once created: no "edit amount"
-- flow, only soft-delete (deleted_at) to correct a mistaken entry.
-- =========================================================================
create table public.settlements (
	id uuid primary key,
	group_id uuid not null references public.groups(id) on delete cascade,
	from_member_id uuid not null references public.members(id),
	to_member_id uuid not null references public.members(id),
	amount_cents integer not null check (amount_cents > 0),
	settled_at timestamptz not null default now(),
	recorded_by_member_id uuid not null references public.members(id),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	deleted_at timestamptz
);

create index idx_settlements_group_id on public.settlements (group_id);
create index idx_settlements_group_deleted on public.settlements (group_id, deleted_at);

alter table public.settlements enable row level security;

create policy "Approved members can view group settlements"
	on public.settlements for select
	using (public.is_approved_member(group_id));

create policy "Approved members can create settlements"
	on public.settlements for insert
	with check (public.is_approved_member(group_id));

create policy "Approved members can update settlements"
	on public.settlements for update
	using (public.is_approved_member(group_id));