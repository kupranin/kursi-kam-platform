-- Paste this in the Supabase SQL editor. Safe to run again.
-- The rates page keeps a history. Each fetch adds a snapshot, and the page
-- picks the one closest to 11:00, 13:00, 15:00, 17:00 and 19:00 (Tbilisi).
-- Rows already stored stay. They are the first snapshot.
-- This does not touch requests, quotes or transactions.

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.conrelid = 'public.market_rates'::regclass
      and c.contype = 'p'
      and a.attname = 'fetched_at'
  ) then
    alter table public.market_rates drop constraint market_rates_pkey;
    alter table public.market_rates
      add constraint market_rates_pkey
      primary key (source, venue, currency, quote_currency, fetched_at);
  end if;
end
$$;

create index if not exists market_rates_fetched_idx
  on public.market_rates (fetched_at);

-- One cell per source, venue, pair and hour for the last p_days.
-- A reading fills an hour only when that hour is its closest.
-- Within 90 minutes it wins. Up to 3 hours, it is used only when
-- that hour has no closer reading. Signed-in readers use their own
-- permission on market_rates.
create or replace function public.market_rate_grid(p_days integer default 14)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with params as (
    select greatest(1, least(coalesce(p_days, 14), 31)) as days
  ),
  bounds as (
    select
      ((now() at time zone 'Asia/Tbilisi')::date - (params.days - 1)) as first_day,
      (now() at time zone 'Asia/Tbilisi')::date as last_day
    from params
  ),
  slots as (
    select
      d::date as day,
      s.slot,
      ((d::date + make_time(s.slot, 0, 0)) at time zone 'Asia/Tbilisi') as slot_at
    from bounds b
    cross join generate_series(b.first_day::timestamp, b.last_day::timestamp, interval '1 day') as d
    cross join (values (11), (13), (15), (17), (19)) as s(slot)
  ),
  snaps as (
    select
      r.source,
      r.venue,
      r.venue_kind,
      r.currency,
      r.quote_currency,
      r.buy,
      r.sell,
      r.fetched_at,
      (r.fetched_at at time zone 'Asia/Tbilisi')::date as day
    from public.market_rates r
    cross join bounds b
    where r.venue_kind in ('board', 'bank')
      and r.venue not like '% app'
      and r.currency in ('USD', 'EUR', 'RUB', 'CNY')
      and r.quote_currency in ('GEL', 'USD', 'EUR', 'RUB', 'CNY')
      and r.currency <> r.quote_currency
      and r.fetched_at >= (b.first_day::timestamp at time zone 'Asia/Tbilisi')
      and r.fetched_at < ((b.last_day + 1)::timestamp at time zone 'Asia/Tbilisi')
  ),
  paired as (
    select
      snaps.source,
      snaps.venue,
      snaps.venue_kind,
      snaps.currency,
      snaps.quote_currency,
      snaps.buy,
      snaps.sell,
      snaps.fetched_at,
      snaps.day,
      slots.slot,
      abs(extract(epoch from (snaps.fetched_at - slots.slot_at))) as dist
    from snaps
    join slots on slots.day = snaps.day
  ),
  nearest as (
    select *
    from (
      select
        paired.*,
        min(paired.dist) over (
          partition by paired.source, paired.venue, paired.currency, paired.quote_currency, paired.fetched_at
        ) as min_dist
      from paired
    ) scored
    where scored.dist = scored.min_dist
  ),
  best_window as (
    select distinct on (source, venue, currency, quote_currency, day, slot)
      source, venue, venue_kind, currency, quote_currency, buy, sell, fetched_at, day, slot
    from nearest
    where dist <= 90 * 60
    order by source, venue, currency, quote_currency, day, slot, dist, fetched_at desc
  ),
  best_orphan as (
    select distinct on (n.source, n.venue, n.currency, n.quote_currency, n.day, n.slot)
      n.source, n.venue, n.venue_kind, n.currency, n.quote_currency, n.buy, n.sell, n.fetched_at, n.day, n.slot
    from nearest n
    where n.dist > 90 * 60
      and n.dist <= 180 * 60
      and not exists (
        select 1
        from best_window w
        where w.source = n.source
          and w.venue = n.venue
          and w.currency = n.currency
          and w.quote_currency = n.quote_currency
          and w.day = n.day
          and w.slot = n.slot
      )
    order by n.source, n.venue, n.currency, n.quote_currency, n.day, n.slot, n.dist, n.fetched_at desc
  ),
  chosen as (
    select * from best_window
    union all
    select * from best_orphan
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'source', source,
    'venue', venue,
    'venue_kind', venue_kind,
    'currency', currency,
    'quote_currency', quote_currency,
    'buy', buy,
    'sell', sell,
    'fetched_at', fetched_at,
    'day', to_char(day, 'YYYY-MM-DD'),
    'slot', slot
  )), '[]'::jsonb)
  from chosen;
$$;

revoke all on function public.market_rate_grid(integer) from public, anon;
grant execute on function public.market_rate_grid(integer) to authenticated;
