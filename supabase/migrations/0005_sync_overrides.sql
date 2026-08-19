-- =========================================================================
-- SYNC OVERRIDES
-- Records a "keep mine" conflict resolution as an event other devices
-- can learn about on their next pull, distinct from an ordinary data
-- refresh. Not part of the normal sync-queue/outbox flow — written
-- directly (best-effort) at resolution time, since resolving a conflict
-- already requires being online. See resolveConflictKeepMine in
-- src/lib/db/writeHelpers.ts and pullRemoteChanges in
-- src/lib/sync/syncEngine.ts.
-- =========================================================================
create table public.sync_overrides (
	id uuid primary key,
	group_id uuid not null references public.groups(id) on delete cascade,
	table_name text not null,
	record_id uuid not null,
	resolved_by_member_id uuid not null references public.members(id),
	summary text not null,
	created_at timestamptz not null default now()
);

create index idx_sync_overrides_group_id on public.sync_overrides (group_id);

alter table public.sync_overrides enable row level security;

create policy "Approved members can view group sync overrides"
	on public.sync_overrides for select
	using (public.is_approved_member(group_id));

create policy "Approved members can create sync overrides"
	on public.sync_overrides for insert
	with check (public.is_approved_member(group_id));
