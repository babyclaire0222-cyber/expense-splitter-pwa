-- =========================================================================
-- SETTLEMENT DEDUPLICATION
-- Closes the gap documented in the README: two devices, both offline,
-- both recording the same real-world payment (same group/payer/payee/
-- amount) end up as two separate rows once both sync, double-crediting
-- the debt. The existing client-side check (findPossibleDuplicateSettlement
-- in src/lib/db/writeHelpers.ts) can only see what THIS device has
-- already pulled down, so it can't catch a genuinely simultaneous
-- offline collision.
--
-- This function is the authoritative check, done server-side at the
-- moment of insert. pg_advisory_xact_lock serializes concurrent calls
-- for the same (group, payer, payee, amount) combination, so the second
-- caller's duplicate check can't run until the first caller's insert has
-- actually committed — closing the check-then-insert race that a naive
-- "SELECT then INSERT" would leave open.
--
-- Deliberately time-windowed (not a hard uniqueness constraint) so two
-- legitimate repeat payments between the same pair, days or weeks apart,
-- are never rejected — only near-simultaneous duplicates are caught.
--
-- See pushSettlementInsert() in src/lib/sync/syncEngine.ts for the
-- client side: settlement inserts call this RPC instead of a plain
-- .insert(), and reconcile locally (delete the phantom, adopt the
-- canonical row) if the server reports a duplicate.
-- =========================================================================
create or replace function public.record_settlement_dedup(
	p_id uuid,
	p_group_id uuid,
	p_from_member_id uuid,
	p_to_member_id uuid,
	p_amount_cents integer,
	p_settled_at timestamptz,
	p_recorded_by_member_id uuid,
	p_created_at timestamptz,
	p_dedup_window_minutes integer default 5
)
returns table (
	id uuid,
	group_id uuid,
	from_member_id uuid,
	to_member_id uuid,
	amount_cents integer,
	settled_at timestamptz,
	recorded_by_member_id uuid,
	created_at timestamptz,
	updated_at timestamptz,
	deleted_at timestamptz,
	version integer,
	is_duplicate boolean
)
language plpgsql
security invoker
as $$
declare
	v_existing public.settlements%rowtype;
begin
	if not public.is_approved_member(p_group_id) then
		raise exception 'Not an approved member of this group';
	end if;

	-- Serialize concurrent calls for this exact (group, payer, payee,
	-- amount) combination. Released automatically at transaction end.
	perform pg_advisory_xact_lock(
		hashtextextended(
			p_group_id::text || p_from_member_id::text || p_to_member_id::text || p_amount_cents::text,
			0
		)
	);

	select s.* into v_existing
	from public.settlements s
	where s.group_id = p_group_id
		and s.from_member_id = p_from_member_id
		and s.to_member_id = p_to_member_id
		and s.amount_cents = p_amount_cents
		and s.deleted_at is null
		and s.id <> p_id
		and abs(extract(epoch from (s.settled_at - p_settled_at))) <= (p_dedup_window_minutes * 60)
	order by s.created_at asc
	limit 1;

	if found then
		return query select
			v_existing.id, v_existing.group_id, v_existing.from_member_id,
			v_existing.to_member_id, v_existing.amount_cents, v_existing.settled_at,
			v_existing.recorded_by_member_id, v_existing.created_at, v_existing.updated_at,
			v_existing.deleted_at, v_existing.version, true;
		return;
	end if;

	insert into public.settlements (
		id, group_id, from_member_id, to_member_id, amount_cents,
		settled_at, recorded_by_member_id, created_at
	) values (
		p_id, p_group_id, p_from_member_id, p_to_member_id, p_amount_cents,
		p_settled_at, p_recorded_by_member_id, p_created_at
	);

	return query select
		s.id, s.group_id, s.from_member_id, s.to_member_id, s.amount_cents,
		s.settled_at, s.recorded_by_member_id, s.created_at, s.updated_at,
		s.deleted_at, s.version, false
	from public.settlements s
	where s.id = p_id;
end;
$$;

grant execute on function public.record_settlement_dedup to authenticated;
