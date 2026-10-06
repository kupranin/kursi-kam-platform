-- =====================================================================
-- KAM platform, migration 9: reference rates for treasury
--
-- Treasury sees every rate it can use when quoting:
--   standard  our standard rates: we buy / we sell, GEL per 1 unit,
--             plus cross rates (e.g. USD priced in EUR)
--   nbg       the official National Bank of Georgia rate
-- Rates are loaded by a feed (core system, NBG) through
-- load_reference_rates, which only the service key can call.
-- Every rate treasury gives now also records the standard rate at
-- that moment, so special rates can later be compared to standard.
-- =====================================================================

create table public.reference_rates (
  source          text not null check (source in ('standard', 'nbg')),
  currency        text not null check (currency ~ '^[A-Z]{3}$'),
  quote_currency  text not null default 'GEL' check (quote_currency ~ '^[A-Z]{3}$'),
  buy             numeric(18,6) check (buy > 0),        -- standard: we buy the currency
  sell            numeric(18,6) check (sell > 0),       -- standard: we sell the currency
  official        numeric(18,6) check (official > 0),   -- nbg: official rate
  as_of           timestamptz not null,
  updated_at      timestamptz not null default now(),
  primary key (source, currency, quote_currency),
  constraint reference_rates_shape check (
    (source = 'standard' and buy is not null and sell is not null)
    or (source = 'nbg' and official is not null and quote_currency = 'GEL')
  )
);

alter table public.reference_rates enable row level security;
revoke all on public.reference_rates from anon, authenticated;
grant select on public.reference_rates to authenticated;
create policy reference_rates_read on public.reference_rates for select to authenticated
  using ((select private.can_see_all()) or (select private.is_treasury()));

-- ---------------------------------------------------------------------
-- Feed entry point (service key only).
-- p_rates: [{"currency":"USD","quote_currency":"GEL","buy":2.675,"sell":2.715,"as_of":"..."}]
--          [{"currency":"USD","official":2.6948,"as_of":"..."}]
-- ---------------------------------------------------------------------
create or replace function public.load_reference_rates(p_source text, p_rates jsonb)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_rows int;
begin
  if p_source not in ('standard', 'nbg') then
    raise exception 'Unknown source %', p_source using errcode = '22023';
  end if;
  insert into public.reference_rates as rr (source, currency, quote_currency, buy, sell, official, as_of, updated_at)
  select p_source,
         upper(x ->> 'currency'),
         upper(coalesce(x ->> 'quote_currency', 'GEL')),
         (x ->> 'buy')::numeric,
         (x ->> 'sell')::numeric,
         (x ->> 'official')::numeric,
         coalesce((x ->> 'as_of')::timestamptz, now()),
         now()
  from jsonb_array_elements(p_rates) x
  on conflict (source, currency, quote_currency) do update set
    buy = excluded.buy, sell = excluded.sell, official = excluded.official,
    as_of = excluded.as_of, updated_at = now();
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.load_reference_rates(text, jsonb) from public, anon, authenticated;
grant execute on function public.load_reference_rates(text, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- Rate for a deal direction (client sells p_sells, gets p_gets)
-- ---------------------------------------------------------------------
create or replace function private.standard_rate_for(p_sells text, p_gets text)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select case
    when p_gets = 'GEL' then (select r.buy  from public.reference_rates r where r.source = 'standard' and r.currency = p_sells and r.quote_currency = 'GEL')
    when p_sells = 'GEL' then (select r.sell from public.reference_rates r where r.source = 'standard' and r.currency = p_gets  and r.quote_currency = 'GEL')
    else (select r.buy from public.reference_rates r where r.source = 'standard' and r.currency = p_sells and r.quote_currency = p_gets)
  end
$$;

create or replace function private.nbg_rate_for(p_sells text, p_gets text)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select case
    when p_gets = 'GEL' then a.official
    when p_sells = 'GEL' then b.official
    else round(a.official / nullif(b.official, 0), 6)
  end
  from (select (select r.official from public.reference_rates r where r.source = 'nbg' and r.currency = p_sells) as official) a,
       (select (select r.official from public.reference_rates r where r.source = 'nbg' and r.currency = p_gets)  as official) b
$$;

-- ---------------------------------------------------------------------
-- All reference rates, for the "Rates now" panel
-- ---------------------------------------------------------------------
create or replace function public.treasury_rates()
returns table (source text, currency text, quote_currency text, buy numeric, sell numeric, official numeric, as_of timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (private.is_treasury() or private.can_see_all()) then
    raise exception 'Only treasury can see the rate sheet' using errcode = '42501';
  end if;
  return query
  select r.source, r.currency, r.quote_currency, r.buy, r.sell, r.official, r.as_of
  from public.reference_rates r
  order by r.source desc, r.quote_currency, r.currency;
end;
$$;

-- ---------------------------------------------------------------------
-- Queue now carries the standard and NBG rate for each deal direction
-- ---------------------------------------------------------------------
drop function public.treasury_queue();
create or replace function public.treasury_queue()
returns table (
  request_id       bigint,
  asked_at         timestamptz,
  waiting_seconds  int,
  kam_name         text,
  client_id        text,
  client_name      text,
  client_kind      text,
  is_new_client    boolean,
  sells_currency   text,
  gets_currency    text,
  amount           numeric,
  note             text,
  last_rate        numeric,
  last_rate_at     timestamptz,
  standard_rate    numeric,   -- our standard rate for this direction
  nbg_rate         numeric,   -- official rate (cross rates computed through GEL)
  last_given_today numeric    -- latest special rate given today for the same direction, any client
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (private.is_treasury() or private.is_admin()) then
    raise exception 'Only treasury can see the rate queue' using errcode = '42501';
  end if;
  return query
  select r.id,
         r.asked_at,
         extract(epoch from now() - r.asked_at)::int,
         p.full_name,
         r.client_id,
         c.name,
         c.kind,
         not exists (select 1 from public.requests r2 where r2.client_id = r.client_id and r2.id <> r.id),
         r.sells_currency,
         r.gets_currency,
         r.amount,
         r.note,
         lq.rate,
         lq.created_at,
         private.standard_rate_for(r.sells_currency, r.gets_currency),
         private.nbg_rate_for(r.sells_currency, r.gets_currency),
         lt.rate
  from public.requests r
  join public.clients c  on c.client_id = r.client_id
  join public.profiles p on p.id = r.kam_id
  left join lateral (
    select q.rate, q.created_at
    from public.quotes q
    join public.requests r3 on r3.id = q.request_id
    where r3.client_id = r.client_id
      and r3.sells_currency = r.sells_currency
      and r3.gets_currency = r.gets_currency
      and q.action = 'quoted'
    order by q.created_at desc
    limit 1
  ) lq on true
  left join lateral (
    select q.rate
    from public.quotes q
    join public.requests r4 on r4.id = q.request_id
    where r4.sells_currency = r.sells_currency
      and r4.gets_currency = r.gets_currency
      and q.action = 'quoted'
      and (q.created_at at time zone 'Asia/Tbilisi')::date = private.tbilisi_today()
    order by q.created_at desc
    limit 1
  ) lt on true
  where r.quote_status = 'asking'
  order by r.asked_at;
end;
$$;

-- ---------------------------------------------------------------------
-- Every rate given records the standard rate at that moment
-- ---------------------------------------------------------------------
alter table public.quotes add column standard_rate numeric(18,6);

create or replace function public.treasury_quote(p_request_id bigint, p_rate numeric, p_valid_minutes int default null)
returns timestamptz
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me     uuid := private.my_profile_id();
  v_req    public.requests%rowtype;
  v_min    int;
  v_until  timestamptz;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'Only treasury can give rates' using errcode = '42501';
  end if;
  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_req.quote_status <> 'asking' then
    raise exception 'This request has already been answered' using errcode = '22023';
  end if;
  if p_rate is null or p_rate <= 0 then
    raise exception 'Enter a rate first' using errcode = '22023';
  end if;
  v_min := coalesce(p_valid_minutes, (select r.default_quote_minutes from public.rules r));
  if v_min < 1 or v_min > 240 then
    raise exception 'Validity must be between 1 and 240 minutes' using errcode = '22023';
  end if;
  v_until := now() + make_interval(mins => v_min);

  update public.requests r
     set rate = p_rate, quote_status = 'quoted', rate_valid_until = v_until,
         quoted_by = v_me, quoted_at = now(), decline_reason = null
   where r.id = p_request_id;
  insert into public.quotes (request_id, action, rate, valid_until, created_by, standard_rate)
  values (p_request_id, 'quoted', p_rate, v_until, v_me,
          private.standard_rate_for(v_req.sells_currency, v_req.gets_currency));
  return v_until;
end;
$$;

-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------
revoke execute on function public.treasury_rates(), public.treasury_queue() from public, anon;
grant execute on function public.treasury_rates(), public.treasury_queue() to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.my_profile_id(), private.my_role(), private.can_see_all(), private.is_admin(),
  private.can_write(), private.is_my_client(text), private.freshness_date(), private.tbilisi_today(),
  private.is_treasury()
to authenticated;
