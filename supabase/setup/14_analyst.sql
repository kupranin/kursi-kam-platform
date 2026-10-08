-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 12_inbox.sql. It does not change how a request is asked,
-- quoted, or counted.
--
-- The role check is its own short step, and the new column is the next
-- short step. Each one locks one table, then finishes, before the list
-- below is built. If a step says lock timeout, paste this file again.
--
-- An analyst can read every request: both amounts, the rate, the lari
-- value, whether it succeeded or was lost, and the reason when it was lost.
-- The row also names the treasury person who quoted (requests.quoted_by).
-- Until someone quotes, that name is empty. The client id is its own column.
-- They cannot change anything. An admin can correct the rate, both
-- amounts, and the lari figure. That correction is checked with
-- private.is_admin(), so a KAM cannot do it.
--
-- Two times, in minutes:
--   first response — from the moment the KAM placed the request until
--   treasury's first answer (the earlier of quoted_at and the first row
--   in public.quotes).
--   rate writing — from the moment the client agreed until treasury marked
--   the rate as written. Empty when it is not written yet.
-- Old rows brought in from the agreement file are not timed.


-- Locks profiles only. commit lets that lock go before anything else runs.
begin;
set local lock_timeout = '3s';
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'manager', 'treasury', 'kam', 'analyst'));
comment on table public.profiles is
  'One row per person. Roles: admin = everything incl. users and rules; manager = sees everything, changes nothing; treasury = gives rates, sees all requests; kam = own requests, clients and follow-ups; analyst = reads every request and the treasury times, changes nothing.';
commit;

-- Locks requests only. commit lets that lock go before the list is built.
begin;
set local lock_timeout = '3s';
alter table public.requests add column if not exists rate_written_at timestamptz;
commit;

-- Locks requests only. gel_amount is the lari figure an admin types.
-- Empty means the formula may fill it. commit lets that lock go.
begin;
set local lock_timeout = '3s';
alter table public.requests add column if not exists gel_amount numeric(18,2);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'requests_gel_amount_positive') then
    alter table public.requests
      add constraint requests_gel_amount_positive check (gel_amount is null or gel_amount > 0);
  end if;
end $$;
comment on column public.requests.gel_amount is
  'Lari figure an admin typed. When set, the analyst list uses it and the formula does not replace it. Empty means calculate.';
commit;

create or replace function private.is_analyst()
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.my_role() = 'analyst', false) $$;

-- Lari value of one request.
-- When the client sells or receives GEL and that amount is filled, that
-- amount is the lari figure. It is not divided or multiplied by the rate.
-- When that GEL amount is empty:
--   RUB, rate below 1: lari = rubles × rate (lari per 1 ruble).
--     4,770,195 RUB at 0.0317 is 151,215.18 GEL.
--   RUB, rate of 1 or more: not a lari rate. 84.7 is rubles per 1 dollar.
--     The lari figure stays empty. It is not multiplied and not divided.
--   USD or EUR, rate from 1 to 10: lari = amount × rate (lari per 1 unit;
--     USD about 2.60, EUR about 3.10). A rate of 84 on a dollar or euro
--     leg is not lari, so the lari figure stays empty.
--   Any other currency: lari = amount × rate.
-- A cross (neither side is GEL) has no lari figure.
-- When an admin has typed requests.gel_amount, the list uses that figure
-- and this formula does not replace it.
create or replace function private.request_gel(
  p_sells    text,
  p_gets     text,
  p_sell_amt numeric,
  p_gets_amt numeric,
  p_rate     numeric
)
returns numeric
language sql immutable set search_path = ''
as $$
  select case
    when p_sells = 'GEL' and p_sell_amt is not null then round(p_sell_amt, 2)
    when p_gets = 'GEL' and p_gets_amt is not null then round(p_gets_amt, 2)
    when p_rate is null or p_rate <= 0 then null
    when p_sells = 'GEL' and p_gets = 'RUB' and p_gets_amt is not null and p_rate < 1
      then round(p_gets_amt * p_rate, 2)
    when p_gets = 'GEL' and p_sells = 'RUB' and p_sell_amt is not null and p_rate < 1
      then round(p_sell_amt * p_rate, 2)
    when p_sells = 'GEL' and p_gets in ('USD', 'EUR') and p_gets_amt is not null
     and p_rate >= 1 and p_rate <= 10
      then round(p_gets_amt * p_rate, 2)
    when p_gets = 'GEL' and p_sells in ('USD', 'EUR') and p_sell_amt is not null
     and p_rate >= 1 and p_rate <= 10
      then round(p_sell_amt * p_rate, 2)
    when p_sells = 'GEL' and p_gets_amt is not null and p_gets not in ('RUB', 'USD', 'EUR')
      then round(p_gets_amt * p_rate, 2)
    when p_gets = 'GEL' and p_sell_amt is not null and p_sells not in ('RUB', 'USD', 'EUR')
      then round(p_sell_amt * p_rate, 2)
    else null
  end
$$;

-- Minutes from the request being placed until treasury's first answer.
create or replace function private.first_response_minutes(
  p_request_id   bigint,
  p_asked_at     timestamptz,
  p_requested_at timestamptz,
  p_quoted_at    timestamptz,
  p_source       text
)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select case
    when p_source = 'import' then null
    else (
      select round((extract(epoch from (f.ts - s.ts)) / 60.0)::numeric, 1)
      from (select coalesce(p_asked_at, p_requested_at) as ts) s
      cross join lateral (
        select min(t.ts) as ts
        from (
          select p_quoted_at as ts
          union all
          select min(q.created_at) from public.quotes q where q.request_id = p_request_id
        ) t
        where t.ts is not null
      ) f
      where f.ts is not null and s.ts is not null and f.ts >= s.ts
    )
  end
$$;

-- Minutes from the client agreeing until treasury marked the rate written.
-- Empty when the rate is not written yet.
create or replace function private.rate_write_minutes(
  p_reply      text,
  p_replied_at timestamptz,
  p_written_at timestamptz,
  p_source     text
)
returns numeric
language sql immutable set search_path = ''
as $$
  select case
    when p_source = 'import' then null
    when p_reply = 'approved'
     and p_replied_at is not null
     and p_written_at is not null
     and p_written_at >= p_replied_at
    then round((extract(epoch from (p_written_at - p_replied_at)) / 60.0)::numeric, 1)
    else null
  end
$$;

revoke all on function private.is_analyst() from public, anon, authenticated;
revoke all on function private.request_gel(text, text, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function private.first_response_minutes(bigint, timestamptz, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function private.rate_write_minutes(text, timestamptz, timestamptz, text) from public, anon, authenticated;

-- The list calls these three. A signed-in user needs execute on them, and
-- so does the owner of the list. Same grant as the other private helpers.
grant execute on function
  private.request_gel(text, text, numeric, numeric, numeric),
  private.first_response_minutes(bigint, timestamptz, timestamptz, timestamptz, text),
  private.rate_write_minutes(text, timestamptz, timestamptz, text)
to postgres, service_role, authenticated;

-- The list. Runs as the owner so an analyst can read it without being
-- given write access to requests. The last line hides it from every
-- other role.
-- Create or replace cannot insert or rename a column. Drop the old list
-- first so a second paste still works when gel_amount is already there.
drop view if exists public.analyst_deals;
create or replace view public.analyst_deals
with (security_invoker = false, security_barrier = true)
as
select
  d.id,
  d.request_date,
  d.kam_name,
  d.client_id,
  d.client_name,
  d.sells_currency,
  d.sell_amount,
  d.gets_currency,
  d.gets_amount,
  d.rate,
  d.amount_gel,
  d.gel_amount,
  d.status,
  case when d.status = 'lost' or d.rate_written then d.reason else null end as loss_reason,
  d.first_response_minutes,
  d.rate_write_minutes,
  d.quoted_by_name
from (
  select
    r.id,
    r.request_date,
    p.full_name as kam_name,
    r.client_id,
    c.name as client_name,
    r.sells_currency,
    r.amount as sell_amount,
    r.gets_currency,
    r.gets_amount,
    coalesce(r.approved_rate, r.rate) as rate,
    coalesce(
      r.gel_amount,
      private.request_gel(
        r.sells_currency, r.gets_currency, r.amount, r.gets_amount, coalesce(r.approved_rate, r.rate)
      )
    ) as amount_gel,
    r.gel_amount,
    (r.rate_written_at is not null) as rate_written,
    case
      when r.rate_written_at is not null then 'success'
      when w.tx_hit or w.file_won then 'success'
      when w.file_lost then 'lost'
      when w.file_open then 'open'
      when r.request_date >= coalesce(private.freshness_date(), r.request_date) then 'open'
      else 'lost'
    end as status,
    nullif(concat_ws(
      '. ',
      nullif(btrim(coalesce(lr.label_ka, r.legacy_loss_reason)), ''),
      nullif(btrim(r.loss_reason_note), ''),
      nullif(btrim(r.client_decline_reason), ''),
      nullif(btrim(r.decline_reason), '')
    ), '') as reason,
    private.first_response_minutes(r.id, r.asked_at, r.requested_at, r.quoted_at, r.source) as first_response_minutes,
    private.rate_write_minutes(r.client_reply, r.client_replied_at, r.rate_written_at, r.source) as rate_write_minutes,
    nullif(btrim(qb.full_name), '') as quoted_by_name
  from public.requests r
  join public.clients c on c.client_id = r.client_id
  left join public.profiles p on p.id = r.kam_id
  -- The view owner reads the name, so an analyst needs no grant on profiles.
  left join public.profiles qb on qb.id = r.quoted_by
  left join public.loss_reasons lr on lr.code = r.loss_reason
  cross join lateral (
    select
      exists (
        select 1
        from public.transactions t
        where t.client_id = r.client_id
          and t.tx_date = r.request_date
          and t.payment_status = 'SUCCESS'
          and (r.source = 'import' or t.tx_time >= r.requested_at - interval '1 minute')
      ) as tx_hit,
      (r.import_key like 'agreement:%' and r.legacy_status = 'შესრულდა') as file_won,
      (r.import_key like 'agreement:%' and r.legacy_status in (
          'არ შესრულდა',
          'ბანკმა გააჩერა ტრანზაქცია',
          'აღარ დასჭირდა და გააუქმა',
          'უარი თქვა, მცირედი განსხვავების გამო ბანკში ურჩევნოდა კონვერტაცია'
      )) as file_lost,
      (r.import_key like 'agreement:%' and (
          r.legacy_status is null
          or r.legacy_status in (
            'შესრულდა ნაწილობრივ',
            'შეთანხმებულია და გაწერეთ კურსი'
          )
      )) as file_open
  ) w
) d
where private.my_role() in ('analyst', 'admin');

comment on view public.analyst_deals is
  'Every request for an analyst or an admin. Dates, both amounts, the lari value, success or lost, the reason, the treasury person who quoted (empty until someone quotes), the client id in its own column, and the two treasury times in minutes. A written rate is success even when a loss reason is still shown. An admin corrects a row with admin_correct_request. An analyst cannot change a row.';

revoke all on public.analyst_deals from public, anon;
grant select on public.analyst_deals to authenticated;

-- Only a real admin can correct a row. private.is_admin() reads the
-- signed-in role, so a KAM cannot call this, and viewing the app as
-- someone else does not change that role.
-- Writes the sell amount, the amount to receive, the rate, and the lari
-- figure. An empty lari figure leaves gel_amount empty so the formula
-- can fill it. When the client already approved a rate, that approved
-- rate is updated too, because the list shows it first.
create or replace function public.admin_correct_request(
  p_request_id  bigint,
  p_sell_amount numeric,
  p_gets_amount numeric,
  p_rate        numeric,
  p_gel_amount  numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source   text;
  v_reply    text;
  v_approved numeric;
  v_sell     numeric;
  v_gets     numeric;
  v_rate     numeric;
  v_gel      numeric;
begin
  if not private.is_admin() then
    raise exception 'Only an admin can correct a request' using errcode = '42501';
  end if;

  select r.source, r.client_reply, r.approved_rate
    into v_source, v_reply, v_approved
  from public.requests r
  where r.id = p_request_id;

  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;

  v_sell := case when p_sell_amount is null then null else round(p_sell_amount, 2) end;
  v_gets := case when p_gets_amount is null then null else round(p_gets_amount, 2) end;
  v_rate := case when p_rate is null then null else round(p_rate, 6) end;
  v_gel  := case when p_gel_amount is null then null else round(p_gel_amount, 2) end;

  if v_sell is not null and v_sell <= 0 then
    raise exception 'The sell amount must be greater than zero' using errcode = '22023';
  end if;
  if v_gets is not null and v_gets <= 0 then
    raise exception 'The amount to receive must be greater than zero' using errcode = '22023';
  end if;
  if v_rate is not null and v_rate <= 0 then
    raise exception 'The rate must be greater than zero' using errcode = '22023';
  end if;
  if v_gel is not null and v_gel <= 0 then
    raise exception 'The lari amount must be greater than zero' using errcode = '22023';
  end if;
  if v_source = 'app' and v_sell is null and v_gets is null then
    raise exception 'Type the sell amount or the amount to receive' using errcode = '22023';
  end if;
  if v_reply = 'approved' and v_rate is null then
    raise exception 'An approved request needs a rate' using errcode = '22023';
  end if;

  update public.requests r
     set amount = v_sell,
         gets_amount = v_gets,
         gel_amount = v_gel,
         rate = v_rate,
         approved_rate = case when v_approved is null then null else v_rate end
   where r.id = p_request_id;
end;
$$;

revoke all on function public.admin_correct_request(bigint, numeric, numeric, numeric, numeric) from public, anon;
grant execute on function public.admin_correct_request(bigint, numeric, numeric, numeric, numeric) to authenticated;

-- Averages for the Analytics screen. Same minutes as the list.
-- Admin, manager, and analyst can read them. Nobody else.
create or replace function public.analytics_response_times(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_role text := private.my_role();
begin
  if v_role is null or v_role not in ('admin', 'manager', 'analyst') then
    raise exception 'Only admins, managers, and analysts can see these times' using errcode = '42501';
  end if;

  return (
    select jsonb_build_object(
      'requests', count(*),
      'answered', count(*) filter (where x.response_minutes is not null),
      'waiting_answer', count(*) filter (where x.response_minutes is null),
      'first_response_minutes', round(avg(x.response_minutes), 1),
      'agreed', count(*) filter (where x.client_reply = 'approved'),
      'written', count(*) filter (where x.write_minutes is not null),
      'waiting_write', count(*) filter (where x.client_reply = 'approved' and x.write_minutes is null),
      'write_minutes', round(avg(x.write_minutes), 1)
    )
    from (
      select
        r.client_reply,
        private.first_response_minutes(r.id, r.asked_at, r.requested_at, r.quoted_at, r.source) as response_minutes,
        private.rate_write_minutes(r.client_reply, r.client_replied_at, r.rate_written_at, r.source) as write_minutes
      from public.requests r
      where r.source = 'app'
        and (p_from is null or r.request_date >= p_from)
        and (p_to is null or r.request_date <= p_to)
    ) x
  );
end;
$$;

revoke all on function public.analytics_response_times(date, date) from public, anon;
grant execute on function public.analytics_response_times(date, date) to authenticated;
