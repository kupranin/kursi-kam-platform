-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 12_inbox.sql. It does not change how a request is asked,
-- quoted, or counted.
--
-- An analyst can read every request: both amounts, the rate, the lari
-- value, whether it succeeded or was lost, and the reason when it was lost.
-- They cannot change anything. Admin can read the same list.
--
-- Two times, in minutes:
--   first response — from the moment the KAM placed the request until
--   treasury's first answer (the earlier of quoted_at and the first row
--   in public.quotes).
--   rate writing — from the moment the client agreed until treasury marked
--   the rate as written. Empty when it is not written yet.
-- Old rows brought in from the agreement file are not timed.


alter table public.requests add column if not exists rate_written_at timestamptz;

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'manager', 'treasury', 'kam', 'analyst'));

comment on table public.profiles is
  'One row per person. Roles: admin = everything incl. users and rules; manager = sees everything, changes nothing; treasury = gives rates, sees all requests; kam = own requests, clients and follow-ups; analyst = reads every request and the treasury times, changes nothing.';

create or replace function private.is_analyst()
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.my_role() = 'analyst', false) $$;

-- Lari value of one request. The rate is lari per 1 foreign unit.
-- A cross (neither side is GEL) has no lari figure.
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
    when p_sells = 'GEL' and p_gets_amt is not null and p_rate is not null and p_rate > 0 then round(p_gets_amt * p_rate, 2)
    when p_gets = 'GEL' and p_sell_amt is not null and p_rate is not null and p_rate > 0 then round(p_sell_amt * p_rate, 2)
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

-- The list. Runs as the owner so an analyst can read it without being
-- given write access to requests. The last line hides it from every
-- other role.
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
  d.status,
  case when d.status = 'lost' then d.reason else null end as loss_reason,
  d.first_response_minutes,
  d.rate_write_minutes
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
    private.request_gel(
      r.sells_currency, r.gets_currency, r.amount, r.gets_amount, coalesce(r.approved_rate, r.rate)
    ) as amount_gel,
    case
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
    private.rate_write_minutes(r.client_reply, r.client_replied_at, r.rate_written_at, r.source) as rate_write_minutes
  from public.requests r
  join public.clients c on c.client_id = r.client_id
  left join public.profiles p on p.id = r.kam_id
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
  'Every request for an analyst or an admin. Read only. Dates, both amounts, the lari value, success or lost, the reason, and the two treasury times in minutes.';

revoke all on public.analyst_deals from public, anon;
grant select on public.analyst_deals to authenticated;

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
