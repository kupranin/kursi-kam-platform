-- Paste this in the Supabase SQL editor after 42_client_special_rates.sql
-- and 45_historical_display_class.sql.
-- Do not re-run 45. Do not re-run 47. Do not paste 48 again for this change.
-- Safe to paste again.
--
-- All-time client owner. This file does not create or replace
-- private.owners(date, date). That function stays the month window:
-- highest count, tie = latest requested_at. month_portfolio and win-back
-- keep calling it.
--
-- client_effective_owners counts every request, every source, all time,
-- by requests.kam_id on the normalized client id. The highest count wins.
-- Two or more KAMs tied for that count are unresolved. clients.assigned_kam_id,
-- when set, wins over the count, including a tie. Clearing it restores the
-- counted owner. This file does not write requests.kam_id.
--
-- It does not replace client_request_brief, client_request_history, or
-- request_display_class. It does not replace analytics_request_kpis or any
-- ABS GEL object. It does not change treasury_queue(). It does not drop or
-- reorder request_outcomes. It does not drop SECURITY DEFINER on
-- analyst_deals or request_rate_names. It does not change can_see_all.
-- It does not change transactions_read or private.is_my_client.
-- It does not grant clients_admin_update to manager, treasury, kam, or analyst.
-- audit_clients already records the old and new client row. Who can read
-- audit_log stays admin-only.

comment on column public.clients.assigned_kam_id is
  'Admin override for the client owner. When set, it wins over the all-time request count, including a tie. Clearing it restores that count. private.owners still reads this column inside the month window and is not changed here. Updating it does not write requests.kam_id.';

comment on policy clients_admin_update on public.clients is
  'Only private.is_admin() may update a client, including assigned_kam_id. Manager, treasury, kam, and analyst are not included. The audit_clients trigger stores the old and new row.';

-- ---------------------------------------------------------------------
-- All-time owner. New function. Not private.owners.
-- ---------------------------------------------------------------------
create or replace function public.client_effective_owners(p_client_ids text[])
returns table (
  client_id text,
  owner_id uuid,
  owner_name text,
  owner_state text,
  owner_source text,
  override_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me uuid := private.my_profile_id();
  v_role text := private.my_role();
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  if v_role not in ('kam', 'admin', 'manager', 'treasury') then
    raise exception 'ამ ანგარიშს კლიენტის მფლობელი არ აქვს' using errcode = '42501';
  end if;
  if p_client_ids is null or cardinality(p_client_ids) = 0 then
    return;
  end if;

  -- Keep at most 100 ids, the lowest normalized client id text first.
  return query
  with asked as (
    select distinct private.normalize_client_id(u.x) as client_id
    from unnest(coalesce(p_client_ids, '{}'::text[])) as u(x)
  ),
  valid as (
    select a.client_id
    from asked a
    where a.client_id ~ '^([0-9]{9}|[0-9]{11})$'
    order by a.client_id
    limit 100
  ),
  counts as (
    select r.client_id, r.kam_id, count(*)::bigint as n
    from public.requests r
    where r.client_id in (select v.client_id from valid v)
      and r.kam_id is not null
    group by r.client_id, r.kam_id
  ),
  tops as (
    select c.client_id, max(c.n) as top_n
    from counts c
    group by c.client_id
  ),
  leaders as (
    select c.client_id, c.kam_id
    from counts c
    join tops t on t.client_id = c.client_id and c.n = t.top_n
  ),
  winner as (
    select l.client_id, (array_agg(l.kam_id))[1] as kam_id
    from leaders l
    group by l.client_id
    having count(*) = 1
  )
  select
    v.client_id,
    case when cl.assigned_kam_id is not null then cl.assigned_kam_id else w.kam_id end,
    nullif(btrim(p.full_name), ''),
    case
      when cl.assigned_kam_id is not null and p.id is null then 'deleted'
      when cl.assigned_kam_id is not null then 'named'
      when w.kam_id is not null and p.id is null then 'deleted'
      when w.kam_id is not null then 'named'
      else 'unresolved'
    end,
    case
      when cl.assigned_kam_id is not null then 'override'
      when w.kam_id is not null then 'computed'
      else 'unresolved'
    end,
    cl.assigned_kam_id
  from valid v
  left join public.clients cl on cl.client_id = v.client_id
  left join winner w on w.client_id = v.client_id
  left join public.profiles p on p.id = case
    when cl.assigned_kam_id is not null then cl.assigned_kam_id
    else w.kam_id
  end;
end;
$$;

comment on function public.client_effective_owners(text[]) is
  'All-time client owner for up to 100 ids. Highest requests.kam_id count wins. A tie is unresolved. assigned_kam_id wins when set, including on a tie. Not private.owners and not the month window. Does not write requests.kam_id.';

revoke all on function public.client_effective_owners(text[]) from public, anon;
grant execute on function public.client_effective_owners(text[]) to authenticated;

-- ---------------------------------------------------------------------
-- Read special terms for any client a KAM can already open.
-- Same return columns as setup 42, so CREATE OR REPLACE does not hit 42P13.
-- save_client_special_rate is not replaced. A KAM still writes only
-- when private.is_my_client is already true, or when they are admin
-- or treasury, which is the existing write rule.
-- ---------------------------------------------------------------------
create or replace function public.client_special_rates(p_client_ids text[])
returns table (
  client_id        text,
  bank             text,
  provider_label   text,
  comment          text,
  sells_currency   text,
  gets_currency    text,
  rate             numeric,
  updated_at       timestamptz,
  updated_by_name  text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me  uuid := private.my_profile_id();
  v_ids text[];
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;

  -- Keep at most 100 ids, the lowest normalized client id text first.
  select coalesce(array_agg(picked.id order by picked.id), '{}'::text[])
    into v_ids
  from (
    select s.id
    from (
      select distinct private.normalize_client_id(u.x) as id
      from unnest(coalesce(p_client_ids, '{}'::text[])) as u(x)
    ) s
    where s.id ~ '^([0-9]{9}|[0-9]{11})$'
    order by s.id
    limit 100
  ) picked;

  return query
  select
    r.client_id,
    r.bank,
    r.provider_label,
    r.comment,
    r.sells_currency,
    r.gets_currency,
    r.rate,
    r.updated_at,
    p.full_name
  from public.client_special_rates r
  left join public.profiles p on p.id = r.updated_by
  where r.client_id = any (v_ids)
    and (
      private.can_see_all()
      or private.is_treasury()
      or private.my_role() = 'kam'
      or private.is_my_client(r.client_id)
    )
  order by r.client_id, array_position(array['TBC', 'BOG', 'Liberty', 'Other']::text[], r.bank);
end;
$$;

comment on function public.client_special_rates(text[]) is
  'Read-only special-rate rows for clients the caller can already open. A KAM may read any client. Admin and manager (can_see_all) and treasury may read. An analyst is not added. Does not grant a write. save_client_special_rate is unchanged.';

revoke all on function public.client_special_rates(text[]) from public, anon;
grant execute on function public.client_special_rates(text[]) to authenticated;
