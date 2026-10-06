-- =====================================================================
-- KAM platform, migration 3 of 6: counting rules and app functions
--
-- The definitions live here, once, so every screen and every export
-- gives the same number:
--   turnover  = abs_gel + cross_gel, every payment status
--               (the not-successful part is reported separately)
--   income    = total_income, every payment status, nothing added on top
--   went through = a SUCCESS transaction from the same client on the
--               same Tbilisi date as the request
--   owner     = the KAM with the most requests for the client in the
--               window (ties go to the latest), unless assigned_kam_id is set
--   portfolio = clients with a request from the 1st of the month up to
--               month end + rules.month_grace_days
-- =====================================================================

-- ---------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------
create or replace function private.tbilisi_today()
returns date
language sql stable set search_path = ''
as $$ select (now() at time zone 'Asia/Tbilisi')::date $$;

-- Restores IDs that lost formatting on the way: strips spaces and a
-- trailing ".0", and puts back the leading zero of a 10-digit personal ID.
create or replace function private.normalize_client_id(p_raw text)
returns text
language sql immutable set search_path = ''
as $$
  select case when v ~ '^[0-9]{10}$' then '0' || v else v end
  from (select regexp_replace(regexp_replace(coalesce(p_raw, ''), '\s', '', 'g'), '\.0+$', '') as v) s
$$;

-- When transactions were last synced successfully
create or replace function public.data_freshness()
returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select max(s.finished_at)
  from private.sync_runs s
  where s.ok and s.kind in ('hourly', 'nightly')
$$;

create or replace function private.freshness_date()
returns date
language sql stable security definer set search_path = ''
as $$ select (public.data_freshness() at time zone 'Asia/Tbilisi')::date $$;

-- ---------------------------------------------------------------------
-- Request outcomes. Respects row-level security of the caller.
--   went_through        a same-day SUCCESS transaction exists
--   waiting             no such transaction yet, and the day is not
--                       fully synced (normally: today)
--   did_not_go_through  the day is over and synced, nothing went through
-- ---------------------------------------------------------------------
create or replace view public.request_outcomes
with (security_invoker = true)
as
select
  r.id,
  r.kam_id,
  p.full_name  as kam_name,
  r.client_id,
  c.name       as client_name,
  c.kind       as client_kind,
  r.requested_at,
  r.request_date,
  r.sells_currency,
  r.gets_currency,
  r.amount,
  r.rate,
  r.note,
  r.loss_reason,
  r.loss_reason_at,
  r.source,
  w.went_through,
  case
    when w.went_through then 'went_through'
    when r.request_date >= coalesce(private.freshness_date(), r.request_date) then 'waiting'
    else 'did_not_go_through'
  end as outcome
from public.requests r
join public.clients c on c.client_id = r.client_id
left join public.profiles p on p.id = r.kam_id
cross join lateral (
  select exists (
    select 1
    from public.transactions t
    where t.client_id = r.client_id
      and t.tx_date = r.request_date
      and t.payment_status = 'SUCCESS'
  ) as went_through
) w;

revoke all on public.request_outcomes from anon;
grant select on public.request_outcomes to authenticated;

-- ---------------------------------------------------------------------
-- Ownership: one owner per client for a date window (internal)
-- ---------------------------------------------------------------------
create or replace function private.owners(p_from date, p_to date)
returns table (client_id text, owner_id uuid, requests_in_window bigint)
language sql stable security definer set search_path = ''
as $$
  with counts as (
    select r.client_id, r.kam_id, count(*) as n, max(r.requested_at) as last_at
    from public.requests r
    where r.request_date >= p_from and r.request_date <= p_to
    group by r.client_id, r.kam_id
  ),
  ranked as (
    select k.client_id, k.kam_id,
           row_number() over (partition by k.client_id order by k.n desc, k.last_at desc) as rn,
           sum(k.n) over (partition by k.client_id) as total_n
    from counts k
  )
  select rk.client_id, coalesce(cl.assigned_kam_id, rk.kam_id), rk.total_n::bigint
  from ranked rk
  join public.clients cl on cl.client_id = rk.client_id
  where rk.rn = 1
$$;

-- ---------------------------------------------------------------------
-- Portfolio of a month: one row per client with its owner and its
-- calendar-month turnover and income. KAMs get their own clients only.
-- ---------------------------------------------------------------------
create or replace function public.month_portfolio(p_month date)
returns table (
  client_id                text,
  client_name              text,
  client_kind              text,
  owner_id                 uuid,
  owner_name               text,
  requests_in_window       bigint,
  turnover                 numeric,
  turnover_not_successful  numeric,
  income                   numeric,
  transactions             bigint
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_from  date := date_trunc('month', p_month)::date;
  v_to    date := (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date;
  v_grace int;
  v_me    uuid := private.my_profile_id();
  v_all   boolean := private.can_see_all();
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  select coalesce(r.month_grace_days, 0) into v_grace from public.rules r;

  return query
  with o as (
    select * from private.owners(v_from, v_to + v_grace)
  ),
  tx as (
    select t.client_id,
           sum(t.abs_gel + t.cross_gel) as turnover,
           coalesce(sum(t.abs_gel + t.cross_gel) filter (where t.payment_status <> 'SUCCESS'), 0) as turnover_ns,
           sum(t.total_income) as income,
           count(*) as n
    from public.transactions t
    where t.tx_date >= v_from and t.tx_date <= v_to
      and t.client_id in (select o.client_id from o)
    group by t.client_id
  )
  select o.client_id, c.name, c.kind, o.owner_id, p.full_name, o.requests_in_window,
         coalesce(tx.turnover, 0), coalesce(tx.turnover_ns, 0), coalesce(tx.income, 0), coalesce(tx.n, 0)::bigint
  from o
  join public.clients c  on c.client_id = o.client_id
  join public.profiles p on p.id = o.owner_id
  left join tx on tx.client_id = o.client_id
  where v_all or o.owner_id = v_me
  order by coalesce(tx.turnover, 0) desc;
end;
$$;

-- ---------------------------------------------------------------------
-- Scorecard of a month, one row per KAM. Portfolio figures follow the
-- owner; request figures follow the KAM who logged the request.
-- ---------------------------------------------------------------------
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
    select o.kam_id as kid,
           count(*) filter (where o.outcome <> 'waiting') as judged,
           count(*) filter (where o.outcome = 'went_through') as won
    from public.request_outcomes o
    where o.request_date >= v_from and o.request_date <= v_to
    group by o.kam_id
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

-- ---------------------------------------------------------------------
-- Win-back list: clients who asked for a rate within the window and
-- have not had a successful transaction since their last request.
-- A client drops off the list on its own once a transaction arrives.
-- ---------------------------------------------------------------------
create or replace function public.winback_list()
returns table (
  client_id           text,
  client_name         text,
  client_kind         text,
  owner_id            uuid,
  owner_name          text,
  tier                text,
  last_request        date,
  last_deal           date,
  prior_turnover_gel  numeric,
  max_request_gel     numeric,
  last_reason         text,
  step                text,
  step_at             timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me    uuid := private.my_profile_id();
  v_all   boolean := private.can_see_all();
  v_today date := private.tbilisi_today();
  v_fresh date;
  v_rules public.rules%rowtype;
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  v_fresh := coalesce(private.freshness_date(), v_today);
  select * into v_rules from public.rules limit 1;

  return query
  with o as (
    select * from private.owners(v_today - v_rules.winback_window_days, v_today)
  ),
  last_req as (
    select r.client_id, max(r.request_date) as last_request
    from public.requests r
    where r.client_id in (select o.client_id from o)
    group by r.client_id
  ),
  last_ok as (
    select t.client_id, max(t.tx_date) as last_deal
    from public.transactions t
    where t.payment_status = 'SUCCESS' and t.client_id in (select o.client_id from o)
    group by t.client_id
  ),
  cand as (
    select o.client_id, o.owner_id, lr.last_request, lk.last_deal
    from o
    join last_req lr on lr.client_id = o.client_id
    left join last_ok lk on lk.client_id = o.client_id
    where lr.last_request < v_fresh                       -- a request from today may still go through
      and (lk.last_deal is null or lk.last_deal < lr.last_request)
  ),
  sizes as (
    select cd.client_id,
           (select coalesce(sum(t.abs_gel + t.cross_gel), 0)
              from public.transactions t
             where t.client_id = cd.client_id
               and t.payment_status = 'SUCCESS'
               and t.tx_date >= cd.last_request - 180
               and t.tx_date <  cd.last_request) as prior_turnover_gel,
           (select round(max(case when r.sells_currency = 'GEL' then r.amount
                                  when r.gets_currency  = 'GEL' then r.amount * r.rate end), 2)
              from public.requests r
             where r.client_id = cd.client_id
               and r.request_date >= v_today - v_rules.winback_window_days) as max_request_gel
    from cand cd
  ),
  latest_reason as (
    select distinct on (r.client_id) r.client_id, r.loss_reason
    from public.requests r
    where r.client_id in (select cd.client_id from cand cd)
    order by r.client_id, r.requested_at desc
  ),
  latest_step as (
    select distinct on (w.client_id) w.client_id, w.step, w.created_at
    from public.winback_actions w
    where w.client_id in (select cd.client_id from cand cd)
    order by w.client_id, w.created_at desc
  ),
  scored as (
    select cd.*, s.prior_turnover_gel, s.max_request_gel,
           greatest(s.prior_turnover_gel, coalesce(s.max_request_gel, 0)) as size_gel
    from cand cd
    join sizes s on s.client_id = cd.client_id
  )
  select sc.client_id,
         cl.name,
         cl.kind,
         sc.owner_id,
         p.full_name,
         case when sc.size_gel >= v_rules.tier_a_min_gel then 'A'
              when sc.size_gel >= v_rules.tier_b_min_gel then 'B'
              else 'C' end,
         sc.last_request,
         sc.last_deal,
         sc.prior_turnover_gel,
         sc.max_request_gel,
         lr.loss_reason,
         coalesce(ls.step, 'not_contacted'),
         ls.created_at
  from scored sc
  join public.clients cl  on cl.client_id = sc.client_id
  join public.profiles p  on p.id = sc.owner_id
  left join latest_reason lr on lr.client_id = sc.client_id
  left join latest_step  ls on ls.client_id = sc.client_id
  where v_all or sc.owner_id = v_me
  order by 6, sc.size_gel desc;
end;
$$;

-- ---------------------------------------------------------------------
-- The signed-in person
-- ---------------------------------------------------------------------
create or replace function public.my_profile()
returns table (id uuid, full_name text, email text, role text)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.full_name, p.email, p.role
  from public.profiles p
  where p.auth_user_id = (select auth.uid()) and p.active
$$;

-- ---------------------------------------------------------------------
-- Client lookup for the request form: name only, nothing else
-- ---------------------------------------------------------------------
create or replace function public.lookup_client(p_client_id text)
returns table (client_id text, valid boolean, known boolean, name text, kind text)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id text := private.normalize_client_id(p_client_id);
begin
  if private.my_profile_id() is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  return query
  select v_id,
         v_id ~ '^([0-9]{9}|[0-9]{11})$',
         c.client_id is not null,
         c.name,
         case when length(v_id) = 9 then 'company' when length(v_id) = 11 then 'person' end
  from (select 1) d
  left join public.clients c on c.client_id = v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Log a request (the only way requests are created from the app)
-- ---------------------------------------------------------------------
create or replace function public.log_request(
  p_client_id      text,
  p_sells_currency text,
  p_gets_currency  text,
  p_amount         numeric,
  p_rate           numeric,
  p_note           text default null,
  p_client_name    text default null
)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me         uuid := private.my_profile_id();
  v_id         text := private.normalize_client_id(p_client_id);
  v_sells      text := upper(trim(coalesce(p_sells_currency, '')));
  v_gets       text := upper(trim(coalesce(p_gets_currency, '')));
  v_new        boolean;
  v_request_id bigint;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot log requests' using errcode = '42501';
  end if;
  if v_id !~ '^([0-9]{9}|[0-9]{11})$' then
    raise exception 'Check the ID: companies have 9 digits, people 11' using errcode = '22023';
  end if;
  if v_sells !~ '^[A-Z]{3}$' or v_gets !~ '^[A-Z]{3}$' or v_sells = v_gets then
    raise exception 'Choose two different currencies' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter the amount' using errcode = '22023';
  end if;
  if p_rate is null or p_rate <= 0 then
    raise exception 'Enter the rate you offered' using errcode = '22023';
  end if;
  -- a client we don't know yet (or know without a name) must come with a name
  if not exists (select 1 from public.clients c where c.client_id = v_id and c.name is not null)
     and length(coalesce(trim(p_client_name), '')) < 2 then
    raise exception 'New client: enter the client''s name' using errcode = '22023';
  end if;

  insert into public.clients (client_id, name, created_by)
  values (v_id, nullif(trim(p_client_name), ''), v_me)
  on conflict (client_id) do nothing;
  v_new := found;

  if not v_new and nullif(trim(p_client_name), '') is not null then
    update public.clients c set name = trim(p_client_name)
    where c.client_id = v_id and c.name is null;
  end if;

  -- a client new to the platform: fetch its recent transaction history
  if v_new then
    insert into private.backfill_queue (client_id) values (v_id)
    on conflict (client_id) do update set done_at = null, queued_at = now();
  end if;

  insert into public.requests (kam_id, client_id, sells_currency, gets_currency, amount, rate, note)
  values (v_me, v_id, v_sells, v_gets, round(p_amount, 2), p_rate, nullif(trim(p_note), ''))
  returning id into v_request_id;

  return v_request_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Give (or clear, with null) the reason a request did not go through
-- ---------------------------------------------------------------------
create or replace function public.set_loss_reason(p_request_id bigint, p_reason text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me  uuid := private.my_profile_id();
  v_row public.request_outcomes%rowtype;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;
  select * into v_row from public.request_outcomes o where o.id = p_request_id;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_row.kam_id <> v_me and not private.is_admin() then
    raise exception 'This request belongs to another KAM' using errcode = '42501';
  end if;
  if v_row.outcome <> 'did_not_go_through' then
    raise exception 'Only requests that did not go through need a reason' using errcode = '22023';
  end if;
  if p_reason is not null and not exists (
    select 1 from public.loss_reasons l where l.code = p_reason and l.active
  ) then
    raise exception 'Unknown reason' using errcode = '22023';
  end if;

  update public.requests r
     set loss_reason = p_reason,
         loss_reason_at = case when p_reason is null then null else now() end
   where r.id = p_request_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Delete a request: the KAM who logged it, shortly after logging
-- (to fix a typo); admins any time. Every delete is in the audit log.
-- ---------------------------------------------------------------------
create or replace function public.delete_request(p_request_id bigint)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me      uuid := private.my_profile_id();
  v_req     public.requests%rowtype;
  v_minutes int;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;
  select * into v_req from public.requests r where r.id = p_request_id;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if not private.is_admin() then
    if v_req.kam_id <> v_me then
      raise exception 'This request belongs to another KAM' using errcode = '42501';
    end if;
    select r.request_delete_minutes into v_minutes from public.rules r;
    if v_req.created_at < now() - make_interval(mins => v_minutes) then
      raise exception 'Requests can be deleted only within % minutes of logging. Ask an admin.', v_minutes
        using errcode = '42501';
    end if;
  end if;
  delete from public.requests r where r.id = p_request_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Record the next step for a client on the win-back list
-- ---------------------------------------------------------------------
create or replace function public.set_winback_step(p_client_id text, p_step text, p_note text default null)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me uuid := private.my_profile_id();
  v_id text := private.normalize_client_id(p_client_id);
  v_action_id bigint;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot record win-back steps' using errcode = '42501';
  end if;
  if not exists (select 1 from public.clients c where c.client_id = v_id) then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;
  if not private.is_admin() and not private.is_my_client(v_id) then
    raise exception 'This client is not in your book' using errcode = '42501';
  end if;
  if p_step not in ('not_contacted', 'called', 'meeting_set', 'converted', 'not_interested') then
    raise exception 'Unknown step' using errcode = '22023';
  end if;
  insert into public.winback_actions (client_id, step, note, created_by)
  values (v_id, p_step, nullif(trim(p_note), ''), v_me)
  returning id into v_action_id;
  return v_action_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Function permissions: signed-in users only, never signed-out visitors
-- ---------------------------------------------------------------------
revoke execute on function
  public.data_freshness(),
  public.month_portfolio(date),
  public.kam_month_summary(date),
  public.winback_list(),
  public.my_profile(),
  public.lookup_client(text),
  public.log_request(text, text, text, numeric, numeric, text, text),
  public.set_loss_reason(bigint, text),
  public.delete_request(bigint),
  public.set_winback_step(text, text, text)
from public, anon;

grant execute on function
  public.data_freshness(),
  public.month_portfolio(date),
  public.kam_month_summary(date),
  public.winback_list(),
  public.my_profile(),
  public.lookup_client(text),
  public.log_request(text, text, text, numeric, numeric, text, text),
  public.set_loss_reason(bigint, text),
  public.delete_request(bigint),
  public.set_winback_step(text, text, text)
to authenticated;

-- ---------------------------------------------------------------------
-- Lock down: internal functions are not callable from the app, except
-- the few helpers the access rules and the outcomes view need.
-- ---------------------------------------------------------------------
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.my_profile_id(), private.my_role(), private.can_see_all(), private.is_admin(),
  private.can_write(), private.is_my_client(text), private.freshness_date(), private.tbilisi_today()
to authenticated;
