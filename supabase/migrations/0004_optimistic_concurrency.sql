-- =========================================================================
-- OPTIMISTIC CONCURRENCY CONTROL
-- Adds a `version` column to every syncable table, auto-incremented
-- server-side on each update via trigger. This is what makes conflict
-- detection possible: push operations become conditional
-- (UPDATE ... WHERE id = X AND version = <base>) instead of blind
-- upserts, so a device that's been offline can never silently overwrite
-- a change it never saw. See src/lib/sync/syncEngine.ts's
-- pushConflictableEntry() for how this gets used, and the Conflict type
-- in src/lib/db/types.ts for the full design rationale.
-- =========================================================================
alter table public.groups add column version integer not null default 1;
alter table public.members add column version integer not null default 1;
alter table public.expenses add column version integer not null default 1;
alter table public.splits add column version integer not null default 1;
alter table public.settlements add column version integer not null default 1;

create or replace function public.bump_version()
returns trigger
language plpgsql
as $$
begin
	new.version = old.version + 1;
	return new;
end;
$$;

create trigger groups_bump_version before update on public.groups
	for each row execute function public.bump_version();
create trigger members_bump_version before update on public.members
	for each row execute function public.bump_version();
create trigger expenses_bump_version before update on public.expenses
	for each row execute function public.bump_version();
create trigger splits_bump_version before update on public.splits
	for each row execute function public.bump_version();
create trigger settlements_bump_version before update on public.settlements
	for each row execute function public.bump_version();
