-- Paste this in the Supabase SQL editor when you want the change.
-- Copy it from disk. Paste it after 44_request_abs_gel.sql.
-- Do not re-run 1_platform.sql. Do not edit 44. Do not paste 44 again.
-- Safe to paste again. It does not update requests. It does not set
-- rate_written_at, payment_confirmed_at, quote events, or notifications.
-- It does not change request_outcomes, treasury_queue, kam_client_reply,
-- defer, release, treasury_quote, or treasury_mark_rate_written.
-- It does not rewrite requests.kam_id.
--
-- Historical rows (source = import, or import_key like agreement:%)
-- are won or lost on the client screens. They are never open.
--   შესრულდა                  won
--   შესრულდა ნაწილობრივ       won
--   everything else, including blank, waiting text, refusals, and
--   unknown text              lost
-- legacy_status and legacy_loss_reason stay on the row.
-- A new platform row still uses private.request_kpi_class:
-- won only when rate_written_at is set, lost only on an explicit
-- decline or loss mark, otherwise open. An old app row is not lost
-- merely because request_outcomes says did_not_go_through.
--
-- A KAM may read every client. They still cannot edit, delete, reply,
-- defer, release, or mark lost on a request whose kam_id is not theirs.
-- Those checks stay in the existing functions. can_see_all is unchanged.

-- ---------------------------------------------------------------------
-- Read every client. Writes stay on the admin policy.
-- ---------------------------------------------------------------------
drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients for select to authenticated
  using (
    (select private.can_see_all())
    or (select private.is_treasury())
    or (select private.my_role()) = 'kam'
    or private.is_my_client(client_id)
  );

-- ---------------------------------------------------------------------
-- One class for the client summary, the history table, search filters
-- on historical rows, and the month win count.
-- ---------------------------------------------------------------------
create or replace function private.request_display_class(
  p_source text,
  p_import_key text,
  p_legacy_status text,
  p_rate_written_at timestamptz,
  p_payment_confirmed_at timestamptz,
  p_marked_lost_at timestamptz,
  p_loss_reason text,
  p_client_reply text,
  p_quote_status text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_source = 'import' or coalesce(p_import_key, '') like 'agreement:%' then
      case
        when btrim(coalesce(p_legacy_status, '')) in ('შესრულდა', 'შესრულდა ნაწილობრივ') then 'won'
        else 'lost'
      end
    else private.request_kpi_class(
      p_rate_written_at,
      p_payment_confirmed_at,
      p_marked_lost_at,
      p_loss_reason,
      p_client_reply,
      p_quote_status,
      p_import_key,
      p_legacy_status
    )
  end
$$;

comment on function private.request_display_class(text, text, text, timestamptz, timestamptz, timestamptz, text, text, text) is
  'Client display class. Import and agreement rows are won or lost from legacy_status and are never open. App rows use request_kpi_class. Does not write a timestamp.';

revoke all on function private.request_display_class(text, text, text, timestamptz, timestamptz, timestamptz, text, text, text) from public, anon, authenticated;

create or replace function public.classify_request(
  p_source text,
  p_import_key text,
  p_legacy_status text,
  p_rate_written_at timestamptz,
  p_payment_confirmed_at timestamptz,
  p_marked_lost_at timestamptz,
  p_loss_reason text,
  p_client_reply text,
  p_quote_status text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.request_display_class(
    p_source,
    p_import_key,
    p_legacy_status,
    p_rate_written_at,
    p_payment_confirmed_at,
    p_marked_lost_at,
    p_loss_reason,
    p_client_reply,
    p_quote_status
  )
$$;

comment on function public.classify_request(text, text, text, timestamptz, timestamptz, timestamptz, text, text, text) is
  'Same display class as private.request_display_class, for the search view. Does not read a row by itself and does not write.';

revoke all on function public.classify_request(text, text, text, timestamptz, timestamptz, timestamptz, text, text, text) from public, anon;
grant execute on function public.classify_request(text, text, text, timestamptz, timestamptz, timestamptz, text, text, text) to authenticated;

-- Search rows. security invoker, so requests_read still hides another
-- KAM's requests. display_class is the historical filter. The outcomes
-- view underneath is not replaced.
drop view if exists public.request_search_rows;
create view public.request_search_rows
with (security_invoker = true) as
select
  o.*,
  r.import_key,
  r.legacy_status,
  r.marked_lost_at,
  public.classify_request(
    r.source,
    r.import_key,
    r.legacy_status,
    r.rate_written_at,
    r.payment_confirmed_at,
    r.marked_lost_at,
    r.loss_reason,
    r.client_reply,
    r.quote_status
  ) as display_class
from public.request_outcomes o
join public.requests r on r.id = o.id;

comment on view public.request_search_rows is
  'request_outcomes plus the display class. A KAM still sees only kam_id = self. Historical won and lost follow legacy_status.';

revoke all on public.request_search_rows from anon;
grant select on public.request_search_rows to authenticated;

-- ---------------------------------------------------------------------
-- Client summary. Same JSON shape as 44. Counts use the display class.
-- ---------------------------------------------------------------------
create or replace function public.client_request_brief(p_client_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.my_profile_id();
  v_role text := private.my_role();
  v_id text := private.normalize_client_id(p_client_id);
  v_name text;
  v_assigned uuid;
  v_assigned_name text;
  v_assigned_found boolean;
  v_total bigint;
  v_won bigint;
  v_lost bigint;
  v_open bigint;
  v_last date;
  v_days int;
  v_loss_warning text := 'none';
  v_reasons jsonb := '[]'::jsonb;
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  if v_role not in ('kam', 'admin', 'manager') then
    raise exception 'ამ ანგარიშს კლიენტის შეჯამება არ აქვს' using errcode = '42501';
  end if;
  if v_id !~ '^([0-9]{9}|[0-9]{11})$' then
    return jsonb_build_object('status', 'invalid_id', 'client_id', v_id);
  end if;

  select c.name, c.assigned_kam_id
    into v_name, v_assigned
  from public.clients c
  where c.client_id = v_id;

  if v_assigned is not null then
    select nullif(btrim(p.full_name), ''), true
      into v_assigned_name, v_assigned_found
    from public.profiles p
    where p.id = v_assigned;
  end if;

  with classified as (
    select
      r.id,
      r.requested_at,
      r.request_date,
      private.request_display_class(
        r.source, r.import_key, r.legacy_status,
        r.rate_written_at, r.payment_confirmed_at, r.marked_lost_at, r.loss_reason,
        r.client_reply, r.quote_status
      ) as klass,
      case
        when private.request_display_class(
          r.source, r.import_key, r.legacy_status,
          r.rate_written_at, r.payment_confirmed_at, r.marked_lost_at, r.loss_reason,
          r.client_reply, r.quote_status
        ) = 'lost'
        then nullif(concat_ws(
          '. ',
          private.request_loss_text(
            r.loss_reason, lr.label_ka, r.legacy_loss_reason, r.loss_reason_note,
            r.client_decline_reason, r.decline_reason, r.legacy_status, r.import_key
          ),
          case
            when r.source = 'import' or coalesce(r.import_key, '') like 'agreement:%'
            then nullif(btrim(coalesce(r.legacy_status, '')), '')
          end
        ), '')
      end as reason
    from public.requests r
    left join public.loss_reasons lr on lr.code = r.loss_reason
    where r.client_id = v_id
  ),
  counts as (
    select
      count(*)::bigint as total,
      count(*) filter (where klass = 'won')::bigint as won,
      count(*) filter (where klass = 'lost')::bigint as lost,
      count(*) filter (where klass = 'open')::bigint as open_n,
      max(request_date) as last_date
    from classified
  ),
  done as (
    select
      x.klass,
      coalesce(x.reason, '') as reason,
      row_number() over (order by x.requested_at desc, x.id desc) as rn
    from (
      select klass, reason, requested_at, id
      from classified
      where klass in ('won', 'lost')
      order by requested_at desc, id desc
      limit 3
    ) x
  )
  select
    c.total, c.won, c.lost, c.open_n, c.last_date,
    case
      when (select count(*) from done) = 3 and not exists (select 1 from done d where d.klass <> 'lost') then 'last_three'
      when (select d.klass from done d where d.rn = 1) = 'lost' then 'last_lost'
      else 'none'
    end,
    case
      when (select count(*) from done) = 3 and not exists (select 1 from done d where d.klass <> 'lost')
        then coalesce((select jsonb_agg(d.reason order by d.rn) from done d), '[]'::jsonb)
      when (select d.klass from done d where d.rn = 1) = 'lost'
        then jsonb_build_array(coalesce((select d.reason from done d where d.rn = 1), ''))
      else '[]'::jsonb
    end
  into v_total, v_won, v_lost, v_open, v_last, v_loss_warning, v_reasons
  from counts c;

  if coalesce(v_total, 0) = 0 then
    return jsonb_build_object(
      'status', 'new_client',
      'client_id', v_id,
      'client_name', v_name,
      'assigned_kam_name', v_assigned_name,
      'assigned_kam_state', case
        when v_assigned is null then 'none'
        when v_assigned_found then 'named'
        else 'deleted'
      end
    );
  end if;

  v_days := (private.tbilisi_today() - v_last);

  return jsonb_build_object(
    'status', 'ok',
    'client_id', v_id,
    'client_name', v_name,
    'assigned_kam_name', v_assigned_name,
    'assigned_kam_state', case
      when v_assigned is null then 'none'
      when v_assigned_found then 'named'
      else 'deleted'
    end,
    'total', v_total,
    'won', v_won,
    'lost', v_lost,
    'open', v_open,
    'last_request_date', v_last,
    'loss_warning', v_loss_warning,
    'loss_reasons', v_reasons,
    'inactive_days', v_days,
    'inactive', v_days > 30
  );
end;
$$;

comment on function public.client_request_brief(text) is
  'Request summary for one client. Counts use the display class, so an imported row is won or lost and never open. assigned_kam_name is the client owner, not the KAM who logged a request. A KAM may read any client. Does not assign a KAM and does not write a request.';

revoke all on function public.client_request_brief(text) from public, anon;
grant execute on function public.client_request_brief(text) to authenticated;

-- Drop every older history signature, including (text, bigint), so
-- PostgREST cannot keep the old outcome labels.
do $drop_client_request_history$
declare
  fn record;
begin
  for fn in
    select pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'client_request_history'
  loop
    execute format('drop function public.client_request_history(%s)', fn.args);
  end loop;
end
$drop_client_request_history$;

create function public.client_request_history(
  p_client_id text,
  p_offset int default 0,
  p_limit int default 20
)
returns table (
  id bigint,
  request_date date,
  requested_at timestamptz,
  sells_currency text,
  gets_currency text,
  amount numeric,
  received_amount numeric,
  rate numeric,
  bank text,
  request_abs_gel numeric,
  valuation_status text,
  kpi_class text,
  loss_reason text,
  legacy_status text,
  kam_name text,
  owner_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.my_profile_id();
  v_role text := private.my_role();
  v_id text := private.normalize_client_id(p_client_id);
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 21);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  if v_role not in ('kam', 'admin', 'manager', 'treasury') then
    raise exception 'ამ ანგარიშს კლიენტის შეჯამება არ აქვს' using errcode = '42501';
  end if;
  if v_id !~ '^([0-9]{9}|[0-9]{11})$' then
    return;
  end if;

  return query
  select
    r.id,
    r.request_date,
    r.requested_at,
    r.sells_currency,
    r.gets_currency,
    r.amount,
    r.gets_amount,
    case
      when r.client_reply = 'approved' and r.approved_rate > 0 then r.approved_rate
      when r.rate > 0 then r.rate
      else null
    end,
    case
      when r.banks is not null and cardinality(r.banks) > 0 then (
        select string_agg(x, ', ' order by array_position(array['TBC', 'BOG', 'Liberty']::text[], x))
        from (
          select distinct btrim(u.x) as x
          from unnest(r.banks) as u(x)
        ) s
        where x in ('TBC', 'BOG', 'Liberty')
      )
      else r.bank
    end,
    v.request_abs_gel,
    v.valuation_status,
    private.request_display_class(
      r.source, r.import_key, r.legacy_status,
      r.rate_written_at, r.payment_confirmed_at, r.marked_lost_at, r.loss_reason,
      r.client_reply, r.quote_status
    ),
    case
      when private.request_display_class(
        r.source, r.import_key, r.legacy_status,
        r.rate_written_at, r.payment_confirmed_at, r.marked_lost_at, r.loss_reason,
        r.client_reply, r.quote_status
      ) = 'lost'
      then nullif(concat_ws(
        '. ',
        private.request_loss_text(
          r.loss_reason, lr.label_ka, r.legacy_loss_reason, r.loss_reason_note,
          r.client_decline_reason, r.decline_reason, r.legacy_status, r.import_key
        ),
        case
          when r.source = 'import' or coalesce(r.import_key, '') like 'agreement:%'
          then nullif(btrim(coalesce(r.legacy_status, '')), '')
        end
      ), '')
    end,
    r.legacy_status,
    nullif(btrim(p.full_name), ''),
    nullif(btrim(op.full_name), '')
  from public.requests r
  left join public.profiles p on p.id = r.kam_id
  left join public.clients c on c.client_id = r.client_id
  left join public.profiles op on op.id = c.assigned_kam_id
  left join public.loss_reasons lr on lr.code = r.loss_reason
  cross join lateral private.request_abs_valuation(
      r.sells_currency, r.gets_currency, r.gets_amount, r.rate, r.quote_status, r.quoted_at, r.requested_at
    ) v
  where r.client_id = v_id
  order by r.requested_at desc, r.id desc
  offset v_offset
  limit v_limit;
end;
$$;

comment on function public.client_request_history(text, int, int) is
  'One page of a client''s requests, newest first. kpi_class is the display class, so the pill matches the summary. kam_name is the KAM who logged the request. owner_name is the client owner. legacy_status is the stored file text and is not rewritten. A KAM may read any client. At most 21 rows.';

revoke all on function public.client_request_history(text, int, int) from public, anon;
grant execute on function public.client_request_history(text, int, int) to authenticated;

-- Client owner for the rows a KAM is allowed to read. Does not list requests.
create or replace function public.client_owner_names(p_client_ids text[])
returns table (
  client_id text,
  owner_name text,
  owner_state text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
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

  return query
  select
    c.client_id,
    nullif(btrim(p.full_name), ''),
    case
      when c.assigned_kam_id is null then 'none'
      when p.id is null then 'deleted'
      else 'named'
    end
  from public.clients c
  left join public.profiles p on p.id = c.assigned_kam_id
  where c.client_id = any (p_client_ids[1:200]);
end;
$$;

comment on function public.client_owner_names(text[]) is
  'Owner display name from clients.assigned_kam_id for up to 200 ids. A KAM may read any client. Does not change assigned_kam_id and does not change a request.';

revoke all on function public.client_owner_names(text[]) from public, anon;
grant execute on function public.client_owner_names(text[]) to authenticated;

-- A searched client shows that client's latest request, including one
-- logged by another KAM. The empty list stays this KAM's own clients.
-- The row returned is a label, not a request the caller can edit.
create or replace function public.search_my_clients(p_query text default '', p_limit int default 8)
returns table (
  client_id            text,
  name                 text,
  kind                 text,
  last_request_date    date,
  last_sells_currency  text,
  last_gets_currency   text,
  banks                text[]
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me     uuid := private.my_profile_id();
  v_all    boolean := private.can_see_all();
  v_q      text := trim(coalesce(p_query, ''));
  v_digits boolean;
  v_like   text;
  v_limit  int := least(greatest(coalesce(p_limit, 8), 1), 20);
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;

  v_digits := v_q ~ '^[0-9 ]+$';
  if v_digits then
    v_q := replace(v_q, ' ', '');
  end if;
  v_like := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');

  return query
  with pool as (
    select c.client_id, c.name, c.kind, c.banks
    from public.clients c
    where (v_q = '' and (
            v_all
         or c.assigned_kam_id = v_me
         or exists (select 1 from public.requests r where r.client_id = c.client_id and r.kam_id = v_me)
          ))
       or v_q <> ''
  ),
  last_req as (
    select distinct on (r.client_id)
           r.client_id, r.request_date, r.sells_currency, r.gets_currency, r.requested_at
    from public.requests r
    where r.client_id in (select pool.client_id from pool)
    order by r.client_id, r.requested_at desc
  )
  select p.client_id, p.name, p.kind, lr.request_date, lr.sells_currency, lr.gets_currency, p.banks
  from pool p
  left join last_req lr on lr.client_id = p.client_id
  where v_q = ''
     or (v_digits and (p.client_id like v_like || '%' or p.client_id like '0' || v_like || '%'))
     or (not v_digits and p.name ilike '%' || v_like || '%')
  order by lr.requested_at desc nulls last, p.name
  limit v_limit;
end;
$$;

comment on function public.search_my_clients(text, int) is
  'Client identity search. A typed id or name may match any client. An empty query stays this KAM''s own clients. The last direction is a read and does not grant an edit.';

revoke all on function public.search_my_clients(text, int) from public, anon;
grant execute on function public.search_my_clients(text, int) to authenticated;

-- The blocked flag is part of the client a KAM may now read.
create or replace function public.client_blocked_ids(p_ids text[])
returns table (client_id text, blocked boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.client_id, c.blocked
  from public.clients c
  where c.client_id = any (coalesce(p_ids, '{}'::text[]))
    and c.blocked
    and (
      private.my_role() in ('admin', 'manager', 'treasury', 'analyst', 'kam')
      or private.is_my_client(c.client_id)
    );
$$;

comment on function public.client_blocked_ids(text[]) is
  'Blocked clients among the ids the screen already loaded. A KAM may read the flag on any client. Only treasury or an admin can change it.';

revoke all on function public.client_blocked_ids(text[]) from public, anon;
grant execute on function public.client_blocked_ids(text[]) to authenticated;

-- Month win count. Same return columns. Judged and won follow the
-- display class. requests.kam_id is still the person who logged the row.
create or replace function public.kam_month_summary(p_month date)
returns table (
  kam_id                   uuid,
  kam_name                 text,
  clients                  bigint,
  turnover                 numeric,
  turnover_not_successful  numeric,
  income                   numeric,
  income_per_1m_turnover   numeric,
  requests_judged          bigint,
  requests_won             bigint,
  win_rate_pct             numeric
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to   date := (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date;
  v_me   uuid := private.my_profile_id();
  v_all  boolean := private.can_see_all();
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;

  return query
  with port as (
    select mp.owner_id as kid,
           count(*) as n_clients,
           sum(mp.turnover) as t,
           sum(mp.turnover_not_successful) as tns,
           sum(mp.income) as inc
    from public.month_portfolio(p_month) mp
    group by mp.owner_id
  ),
  req as (
    select r.kam_id as kid,
           count(*) filter (where d.klass in ('won', 'lost')) as judged,
           count(*) filter (where d.klass = 'won') as won
    from public.requests r
    cross join lateral (
      select private.request_display_class(
        r.source, r.import_key, r.legacy_status,
        r.rate_written_at, r.payment_confirmed_at, r.marked_lost_at, r.loss_reason,
        r.client_reply, r.quote_status
      ) as klass
    ) d
    where r.request_date >= v_from and r.request_date <= v_to
    group by r.kam_id
  ),
  ids as (
    select port.kid from port
    union
    select req.kid from req
  )
  select ids.kid,
         p.full_name,
         coalesce(port.n_clients, 0)::bigint,
         coalesce(port.t, 0),
         coalesce(port.tns, 0),
         coalesce(port.inc, 0),
         case when coalesce(port.t, 0) > 0 then round(port.inc / port.t * 1000000, 0) end,
         coalesce(req.judged, 0)::bigint,
         coalesce(req.won, 0)::bigint,
         case when coalesce(req.judged, 0) > 0 then round(req.won::numeric / req.judged * 100, 1) end
  from ids
  join public.profiles p on p.id = ids.kid
  left join port on port.kid = ids.kid
  left join req  on req.kid  = ids.kid
  where v_all or ids.kid = v_me
  order by coalesce(port.t, 0) desc;
end;
$$;

comment on function public.kam_month_summary(date) is
  'Month scorecard. Portfolio money still follows the client owner. Request won and judged follow the display class and the KAM who logged the request. Does not change kam_id.';

revoke all on function public.kam_month_summary(date) from public, anon;
grant execute on function public.kam_month_summary(date) to authenticated;
