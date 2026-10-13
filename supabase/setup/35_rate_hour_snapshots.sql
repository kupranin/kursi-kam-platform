-- Paste this in the Supabase SQL editor when you want the change.
-- Copy it from disk. Paste it after 34_client_blocked.sql.
-- Do not re-run 1_platform.sql. Do not paste the index file
-- 20261013140100_desk_day_indexes.sql.
-- Safe to paste again. It does not drop market_rates and does not
-- delete stored rates.
--
-- market_rates keeps each fetch when 7_market_rates_history.sql has
-- been pasted. If the old key is still in place, only the latest board
-- is stored. This table keeps one row-set per Tbilisi hour from the
-- rows that already exist, and a trigger writes the hour again whenever
-- a board or bank rate is inserted (refresh button or the 30-minute job).
-- Hours that were never stored are not invented. A later fetch in the
-- same hour replaces that hour. An older fetch does not.

create table if not exists public.market_rate_hours (
  source          text not null,
  venue           text not null,
  venue_kind      text not null,
  currency        text not null,
  quote_currency  text not null,
  buy             numeric,
  sell            numeric,
  official        numeric,
  hour_start      timestamptz not null,
  fetched_at      timestamptz not null,
  primary key (source, venue, currency, quote_currency, hour_start)
);

comment on table public.market_rate_hours is
  'One board or bank snapshot per source, venue, pair, and Asia/Tbilisi hour. Filled from market_rates. Missing hours stay missing.';

create index if not exists market_rate_hours_hour_idx
  on public.market_rate_hours (hour_start);

alter table public.market_rate_hours enable row level security;
revoke all on public.market_rate_hours from anon, authenticated;
grant select on public.market_rate_hours to authenticated;

drop policy if exists market_rate_hours_read on public.market_rate_hours;
create policy market_rate_hours_read on public.market_rate_hours
  for select to authenticated
  using ((select private.my_role()) in ('admin', 'manager', 'treasury', 'kam'));

create or replace function private.keep_market_rate_hour()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hour timestamptz;
begin
  if new.venue_kind not in ('board', 'bank') or new.venue like '% app' then
    return new;
  end if;
  if new.buy is null and new.sell is null then
    return new;
  end if;

  v_hour := date_trunc('hour', new.fetched_at at time zone 'Asia/Tbilisi') at time zone 'Asia/Tbilisi';

  insert into public.market_rate_hours (
    source, venue, venue_kind, currency, quote_currency, buy, sell, official, hour_start, fetched_at
  ) values (
    new.source, new.venue, new.venue_kind, new.currency, new.quote_currency,
    new.buy, new.sell, new.official, v_hour, new.fetched_at
  )
  on conflict (source, venue, currency, quote_currency, hour_start) do update
    set buy = excluded.buy,
        sell = excluded.sell,
        official = excluded.official,
        venue_kind = excluded.venue_kind,
        fetched_at = excluded.fetched_at
    where public.market_rate_hours.fetched_at <= excluded.fetched_at;

  return new;
end;
$$;

revoke all on function private.keep_market_rate_hour() from public, anon, authenticated;

drop trigger if exists market_rates_keep_hour on public.market_rates;
create trigger market_rates_keep_hour
  after insert on public.market_rates
  for each row execute function private.keep_market_rate_hour();

-- Copy hours that are already stored. One row per hour, the latest
-- fetch in that hour. This does not fill an hour that has no row.
insert into public.market_rate_hours (
  source, venue, venue_kind, currency, quote_currency, buy, sell, official, hour_start, fetched_at
)
select distinct on (source, venue, currency, quote_currency, hour_start)
  source,
  venue,
  venue_kind,
  currency,
  quote_currency,
  buy,
  sell,
  official,
  hour_start,
  fetched_at
from (
  select
    r.source,
    r.venue,
    r.venue_kind,
    r.currency,
    r.quote_currency,
    r.buy,
    r.sell,
    r.official,
    r.fetched_at,
    date_trunc('hour', r.fetched_at at time zone 'Asia/Tbilisi') at time zone 'Asia/Tbilisi' as hour_start
  from public.market_rates r
  where r.venue_kind in ('board', 'bank')
    and r.venue not like '% app'
    and (r.buy is not null or r.sell is not null)
) stored
order by source, venue, currency, quote_currency, hour_start, fetched_at desc
on conflict (source, venue, currency, quote_currency, hour_start) do update
  set buy = excluded.buy,
      sell = excluded.sell,
      official = excluded.official,
      venue_kind = excluded.venue_kind,
      fetched_at = excluded.fetched_at
  where public.market_rate_hours.fetched_at <= excluded.fetched_at;
