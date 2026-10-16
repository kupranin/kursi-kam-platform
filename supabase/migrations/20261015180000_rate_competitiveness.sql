-- Paste this in the Supabase SQL editor. Copy it from disk. Safe to run again.
-- Do not re-run 1_platform.sql.
--
-- Public Kursi board versus the best comparable competitor.
-- This does not read requests, quotes, the bank file, or admin.
-- It does not grant those. An analyst can call the function; the role
-- check is inside it. KAM and treasury get an empty result.
--
-- Rule version: the same bands and Kursi misfile as src/lib/rateGrid.ts
-- on 15 October 2026. A later change to those bands is a conscious change.
-- Buy advantage = round5(Kursi buy − best competitor buy).
-- Sell advantage = round5(best competitor sell − Kursi sell).
-- Positive means the public board is better for the client. Zero is a tie
-- at five decimals. Negative means the public board is worse.
-- RUB/GEL stays lari per 1 ruble. Nothing here divides or multiplies by 84.7.
--
-- Grain: market_rates when Kursi has more than one stored fetch.
-- Otherwise market_rate_hours when that table has more than one stored hour.
-- One stored generation cannot reconstruct earlier periods. Hours are not invented.

create or replace function private.rate_in_scale(p_pair text, p_value numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_pair
    when 'USD/GEL' then p_value >= 1.5 and p_value <= 4.2
    when 'EUR/GEL' then p_value >= 1.6 and p_value <= 4.8
    when 'RUB/GEL' then p_value >= 0.008 and p_value <= 0.15
    when 'CNY/GEL' then p_value >= 0.15 and p_value <= 0.8
    when 'EUR/USD' then p_value >= 0.95 and p_value <= 1.55
    when 'EUR/RUB' then p_value >= 40 and p_value <= 200
    when 'USD/RUB' then p_value >= 40 and p_value <= 200
    when 'USD/CNY' then p_value >= 4.5 and p_value <= 12
    when 'EUR/CNY' then p_value >= 5 and p_value <= 14
    else false
  end;
$$;

create or replace function private.rate_canonical(p_pair text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_pair in (
    'USD/GEL', 'EUR/GEL', 'RUB/GEL', 'CNY/GEL',
    'EUR/USD', 'EUR/RUB', 'USD/RUB', 'USD/CNY', 'EUR/CNY'
  );
$$;

create or replace function private.rate_pair_allowed(p_currency text, p_quote text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_currency in ('USD', 'EUR', 'RUB', 'CNY')
    and p_currency <> p_quote
    and (p_quote = 'GEL' or p_quote in ('USD', 'EUR', 'RUB', 'CNY'));
$$;

create or replace function private.rate_sides_in(p_pair text, p_buy numeric, p_sell numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select ((p_buy is not null and p_buy > 0) or (p_sell is not null and p_sell > 0))
    and (p_buy is null or p_buy <= 0 or private.rate_in_scale(p_pair, p_buy))
    and (p_sell is null or p_sell <= 0 or private.rate_in_scale(p_pair, p_sell));
$$;

create or replace function private.rate_looks_reciprocal(p_pair text, p_buy numeric, p_sell numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select ((p_buy is not null and p_buy > 0) or (p_sell is not null and p_sell > 0))
    and (p_buy is null or p_buy <= 0 or not private.rate_in_scale(p_pair, p_buy))
    and (p_sell is null or p_sell <= 0 or not private.rate_in_scale(p_pair, p_sell))
    and (p_buy is null or p_buy <= 0 or p_buy = 0 or private.rate_in_scale(p_pair, 1 / p_buy))
    and (p_sell is null or p_sell <= 0 or p_sell = 0 or private.rate_in_scale(p_pair, 1 / p_sell));
$$;

create or replace function private.rate_invert(p_buy numeric, p_sell numeric)
returns table (buy numeric, sell numeric)
language sql
immutable
set search_path = ''
as $$
  select
    case
      when p_buy is not null and p_sell is not null then
        case when p_sell = 0 then null else 1 / p_sell end
      else
        case when p_buy is null or p_buy = 0 then null else 1 / p_buy end
    end,
    case
      when p_buy is not null and p_sell is not null then
        case when p_buy = 0 then null else 1 / p_buy end
      else
        case when p_sell is null or p_sell = 0 then null else 1 / p_sell end
    end;
$$;

-- Five decimals, same tie the rates screen prints. A printed 0.00000 is zero.
create or replace function private.rate_round5(p_value numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null then null
    when round(p_value, 5) = 0 then 0
    else round(p_value, 5)
  end;
$$;

create or replace function private.orient_board_rate(
  p_source text,
  p_currency text,
  p_quote text,
  p_buy numeric,
  p_sell numeric
)
returns table (currency text, quote_currency text, buy numeric, sell numeric)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_currency text := p_currency;
  v_quote text := p_quote;
  v_buy numeric := p_buy;
  v_sell numeric := p_sell;
  v_pair text;
  v_flip text;
begin
  if p_source = 'kursi'
    and p_quote = 'GEL'
    and not private.rate_sides_in(p_currency || '/GEL', p_buy, p_sell)
  then
    if p_currency = 'USD' and private.rate_sides_in('USD/CNY', p_buy, p_sell) then
      return query select p_currency, 'CNY'::text, p_buy, p_sell;
      return;
    elsif p_currency = 'USD' and private.rate_sides_in('USD/RUB', p_buy, p_sell) then
      return query select p_currency, 'RUB'::text, p_buy, p_sell;
      return;
    elsif p_currency = 'EUR' and private.rate_sides_in('EUR/USD', p_buy, p_sell) then
      return query select p_currency, 'USD'::text, p_buy, p_sell;
      return;
    elsif p_currency = 'EUR' and private.rate_sides_in('EUR/RUB', p_buy, p_sell) then
      return query select p_currency, 'RUB'::text, p_buy, p_sell;
      return;
    end if;
  end if;

  v_pair := v_currency || '/' || v_quote;
  v_flip := v_quote || '/' || v_currency;

  if private.rate_canonical(v_pair) then
    if private.rate_looks_reciprocal(v_pair, v_buy, v_sell) then
      select i.buy, i.sell into v_buy, v_sell from private.rate_invert(v_buy, v_sell) i;
    end if;
    return query select v_currency, v_quote, v_buy, v_sell;
    return;
  end if;

  if private.rate_canonical(v_flip) then
    if private.rate_sides_in(v_flip, v_buy, v_sell) then
      return query select v_quote, v_currency, v_buy, v_sell;
      return;
    end if;
    if private.rate_looks_reciprocal(v_flip, v_buy, v_sell) then
      select i.buy, i.sell into v_buy, v_sell from private.rate_invert(v_buy, v_sell) i;
      return query select v_quote, v_currency, v_buy, v_sell;
      return;
    end if;
  end if;

  return query select p_currency, p_quote, p_buy, p_sell;
end;
$$;

create or replace function private.rate_identity(p_source text, p_venue text, p_kind text)
returns table (key text, label text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text;
begin
  if p_kind = 'kiosk' or coalesce(p_venue, '') like '% app' then
    return;
  end if;
  v_name := lower(regexp_replace(coalesce(p_venue, ''), '[^a-zA-Z0-9]', '', 'g'));
  if p_source = 'kursi' and p_kind = 'board' then
    key := 'kursi'; label := 'Kursi'; return next; return;
  end if;
  if p_source = 'rico' and p_kind = 'board' then
    key := 'rico'; label := 'Rico'; return next; return;
  end if;
  if p_kind = 'bank' and v_name in ('tbc', 'tbcbank', 'tbcge') then
    key := 'tbc'; label := 'TBC'; return next; return;
  end if;
  if p_kind = 'bank' and v_name in ('bog', 'bogge', 'bankofgeorgia') then
    key := 'bog'; label := 'BOG'; return next; return;
  end if;
  if p_source = 'valuto' and p_kind = 'board' then
    key := 'valuto'; label := 'Valuto'; return next; return;
  end if;
  if p_source = 'expresslombard' and p_kind = 'board' then
    key := 'lombard'; label := 'Express Lombard'; return next; return;
  end if;
  if p_source = 'crystal' and p_kind = 'board' then
    key := 'crystal'; label := 'Crystal'; return next; return;
  end if;
  if p_source = 'girocredit' and p_kind = 'board' then
    key := 'giro'; label := 'Giro Credit'; return next; return;
  end if;
  if p_source = 'fxhub' and p_kind = 'board' then
    key := 'fxhub'; label := 'FX Hub'; return next; return;
  end if;
  if p_kind = 'bank' and v_name <> '' then
    key := 'bank:' || v_name; label := p_venue; return next;
  end if;
end;
$$;

create or replace function private.finish_board_incident(
  p_kind text,
  p_grain text,
  p_pair text,
  p_side text,
  p_quote text,
  p_start_at timestamptz,
  p_last_at timestamptz,
  p_end_at timestamptz,
  p_start_kursi numeric,
  p_start_names text,
  p_end_kursi numeric,
  p_end_names text,
  p_max_gap numeric,
  p_max_kursi numeric,
  p_max_best numeric,
  p_max_names text,
  p_max_keys text[],
  p_max_tetri numeric,
  p_max_bps numeric,
  p_keys text[],
  p_points jsonb,
  p_weight numeric,
  p_weighted numeric,
  p_adv_sum numeric,
  p_count integer
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_avg numeric;
  v_weight_kind text;
  v_end timestamptz;
  v_dur numeric;
  v_keys jsonb;
begin
  if p_grain = 'hours' or p_weight is null or p_weight = 0 then
    v_avg := case when coalesce(p_count, 0) > 0 then private.rate_round5(p_adv_sum / p_count) else null end;
    v_weight_kind := 'equal';
  else
    v_avg := private.rate_round5(p_weighted / p_weight);
    v_weight_kind := 'time';
  end if;

  if p_kind = 'open' then
    v_end := null;
  else
    v_end := p_end_at;
  end if;

  v_dur := round(extract(epoch from (coalesce(v_end, p_last_at) - p_start_at)) / 60.0);

  select coalesce(jsonb_agg(d.k order by d.k), '[]'::jsonb)
    into v_keys
  from (
    select distinct u.k
    from unnest(coalesce(p_keys, '{}'::text[])) as u(k)
    where u.k is not null and u.k <> ''
  ) d;

  return jsonb_build_object(
    'id', p_pair || '|' || p_side || '|' || to_char(p_start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'pair', p_pair,
    'side', p_side,
    'quote_currency', p_quote,
    'started_at', p_start_at,
    'ended_at', v_end,
    'end_kind', p_kind,
    'duration_minutes', v_dur,
    'kursi_rate', p_max_kursi,
    'best_rate', p_max_best,
    'best_names', coalesce(p_max_names, ''),
    'best_keys', coalesce(to_jsonb(p_max_keys), '[]'::jsonb),
    'best_keys_any', v_keys,
    'max_gap', p_max_gap,
    'avg_gap', v_avg,
    'avg_weight', v_weight_kind,
    'start_kursi_rate', p_start_kursi,
    'end_kursi_rate', p_end_kursi,
    'start_names', coalesce(p_start_names, ''),
    'end_names', coalesce(p_end_names, ''),
    'tetri', case when p_quote = 'GEL' then p_max_tetri else null end,
    'bps', p_max_bps,
    'points', coalesce(p_points, '[]'::jsonb)
  );
end;
$$;

create or replace function public.board_competitiveness(
  p_from date,
  p_to date,
  p_pair text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_from date;
  v_to date;
  v_start timestamptz;
  v_end timestamptz;
  v_stamps integer := 0;
  v_hours integer := 0;
  v_grain text;
  v_raw jsonb := '[]'::jsonb;
  v_incidents jsonb := '[]'::jsonb;
  v_observations jsonb := '[]'::jsonb;
  v_pairs text[] := '{}'::text[];
  v_want text;
  rec record;
  v_open boolean := false;
  v_prev_at timestamptz;
  v_cur_pair text;
  v_cur_side text;
  v_points jsonb;
  v_keys text[];
  v_adv_sum numeric;
  v_count integer;
  v_weight numeric;
  v_weighted numeric;
  v_max_gap numeric;
  v_max_kursi numeric;
  v_max_best numeric;
  v_max_names text;
  v_max_keys text[];
  v_max_tetri numeric;
  v_max_bps numeric;
  v_start_at timestamptz;
  v_start_kursi numeric;
  v_start_names text;
  v_last_at timestamptz;
  v_last_adv numeric;
  v_last_kursi numeric;
  v_last_names text;
  v_quote text;
  v_comparable boolean;
  v_mins numeric;
begin
  v_role := private.my_role();
  if v_role is null or v_role not in ('admin', 'manager', 'analyst') then
    return jsonb_build_object(
      'grain', 'none',
      'reason', 'forbidden',
      'pairs', '[]'::jsonb,
      'observations', '[]'::jsonb,
      'incidents', '[]'::jsonb
    );
  end if;

  if p_from is null or p_to is null then
    return jsonb_build_object(
      'grain', 'none',
      'reason', 'range',
      'pairs', '[]'::jsonb,
      'observations', '[]'::jsonb,
      'incidents', '[]'::jsonb
    );
  end if;

  v_from := least(p_from, p_to);
  v_to := greatest(p_from, p_to);
  if v_to - v_from > 91 then
    v_from := v_to - 91;
  end if;
  v_start := v_from::timestamp at time zone 'Asia/Tbilisi';
  v_end := (v_to + 1)::timestamp at time zone 'Asia/Tbilisi';
  v_want := nullif(btrim(coalesce(p_pair, '')), '');

  select count(*) into v_stamps
  from (
    select r.fetched_at
    from public.market_rates r
    where r.source = 'kursi'
      and r.venue_kind = 'board'
    group by r.fetched_at
    limit 2
  ) s;

  if to_regclass('public.market_rate_hours') is not null then
    execute $hours$
      select count(*)
      from (
        select h.hour_start
        from public.market_rate_hours h
        where h.source = 'kursi'
          and h.venue_kind = 'board'
        group by h.hour_start
        limit 2
      ) s
    $hours$
    into v_hours;
  end if;

  if v_stamps >= 2 then
    v_grain := 'fetches';
  elsif coalesce(v_hours, 0) >= 2 then
    v_grain := 'hours';
  else
    return jsonb_build_object(
      'grain', 'none',
      'reason', 'single_generation',
      'pairs', '[]'::jsonb,
      'observations', '[]'::jsonb,
      'incidents', '[]'::jsonb
    );
  end if;

  if v_grain = 'hours' then
    execute $hours$
      select coalesce(jsonb_agg(jsonb_build_object(
        'source', h.source,
        'venue', h.venue,
        'venue_kind', h.venue_kind,
        'currency', h.currency,
        'quote_currency', h.quote_currency,
        'buy', h.buy,
        'sell', h.sell,
        'fetched_at', h.fetched_at,
        'cluster_key', h.hour_start
      )), '[]'::jsonb)
      from public.market_rate_hours h
      where h.venue_kind in ('board', 'bank')
        and h.venue not like '% app'
        and h.currency in ('USD', 'EUR', 'RUB', 'CNY')
        and h.quote_currency in ('GEL', 'USD', 'EUR', 'RUB', 'CNY')
        and h.currency <> h.quote_currency
        and h.hour_start >= $1
        and h.hour_start < $2
    $hours$
    into v_raw
    using v_start, v_end;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'source', r.source,
      'venue', r.venue,
      'venue_kind', r.venue_kind,
      'currency', r.currency,
      'quote_currency', r.quote_currency,
      'buy', r.buy,
      'sell', r.sell,
      'fetched_at', r.fetched_at,
      'cluster_key', null
    )), '[]'::jsonb)
    into v_raw
    from public.market_rates r
    where r.venue_kind in ('board', 'bank')
      and r.venue not like '% app'
      and r.currency in ('USD', 'EUR', 'RUB', 'CNY')
      and r.quote_currency in ('GEL', 'USD', 'EUR', 'RUB', 'CNY')
      and r.currency <> r.quote_currency
      and r.fetched_at >= v_start
      and r.fetched_at < v_end;
  end if;

  for rec in
    with raw as (
      select *
      from jsonb_to_recordset(v_raw) as x(
        source text,
        venue text,
        venue_kind text,
        currency text,
        quote_currency text,
        buy numeric,
        sell numeric,
        fetched_at timestamptz,
        cluster_key timestamptz
      )
    ),
    oriented as (
      select
        r.source,
        r.venue,
        r.fetched_at,
        r.cluster_key,
        z.currency,
        z.quote_currency,
        z.buy,
        z.sell,
        i.key as identity_key,
        i.label as identity_label
      from raw r
      cross join lateral private.orient_board_rate(r.source, r.currency, r.quote_currency, r.buy, r.sell) z
      cross join lateral private.rate_identity(r.source, r.venue, r.venue_kind) i
      where private.rate_pair_allowed(z.currency, z.quote_currency)
        and ((z.buy is not null and z.buy > 0) or (z.sell is not null and z.sell > 0))
    ),
    stamps as (
      select
        d.fetched_at,
        lag(d.fetched_at) over (order by d.fetched_at) as prev_at
      from (select distinct o.fetched_at from oriented o where o.cluster_key is null) d
    ),
    marked as (
      select
        s.fetched_at,
        sum(case
          when s.prev_at is null then 1
          when s.fetched_at - s.prev_at > interval '10 minutes' then 1
          else 0
        end) over (order by s.fetched_at) as cluster_n
      from stamps s
    ),
    clustered as (
      select m.fetched_at, min(m.fetched_at) over (partition by m.cluster_n) as cluster_at
      from marked m
    ),
    with_cluster as (
      select
        o.*,
        coalesce(o.cluster_key, c.cluster_at) as cluster_at
      from oriented o
      left join clustered c on o.cluster_key is null and c.fetched_at = o.fetched_at
    ),
    anchors as (
      select
        w.cluster_at,
        coalesce(
          max(w.fetched_at) filter (where w.identity_key = 'kursi'),
          max(w.fetched_at)
        ) as anchor
      from with_cluster w
      where w.cluster_at is not null
      group by w.cluster_at
    ),
    picked as (
      select distinct on (w.cluster_at, w.identity_key, w.currency, w.quote_currency)
        w.cluster_at,
        w.currency,
        w.quote_currency,
        w.identity_key,
        w.identity_label,
        w.buy,
        w.sell,
        w.fetched_at
      from with_cluster w
      join anchors a on a.cluster_at = w.cluster_at
      where w.cluster_at is not null
      order by w.cluster_at, w.identity_key, w.currency, w.quote_currency,
        abs(extract(epoch from (w.fetched_at - a.anchor))),
        w.fetched_at desc
    ),
    sides as (
      select p.cluster_at, p.currency, p.quote_currency, 'buy'::text as side,
        p.identity_key, p.identity_label, p.buy as rate, p.fetched_at
      from picked p
      where p.buy is not null and p.buy > 0
      union all
      select p.cluster_at, p.currency, p.quote_currency, 'sell'::text,
        p.identity_key, p.identity_label, p.sell, p.fetched_at
      from picked p
      where p.sell is not null and p.sell > 0
    ),
    spine as (
      select distinct s.cluster_at, s.currency, s.quote_currency, s.side
      from sides s
    ),
    kursi as (
      select * from sides where identity_key = 'kursi'
    ),
    comps as (
      select * from sides where identity_key <> 'kursi'
    ),
    best as (
      select
        c.cluster_at,
        c.currency,
        c.quote_currency,
        c.side,
        case when c.side = 'buy' then max(c.rate) else min(c.rate) end as best_rate
      from comps c
      group by c.cluster_at, c.currency, c.quote_currency, c.side
    ),
    best_named as (
      select
        b.cluster_at,
        b.currency,
        b.quote_currency,
        b.side,
        b.best_rate,
        array_agg(c.identity_key order by c.identity_label, c.identity_key) as keys,
        array_agg(c.identity_label order by c.identity_label, c.identity_key) as labels
      from best b
      join comps c
        on c.cluster_at = b.cluster_at
       and c.currency = b.currency
       and c.quote_currency = b.quote_currency
       and c.side = b.side
       and private.rate_round5(c.rate) = private.rate_round5(b.best_rate)
      group by b.cluster_at, b.currency, b.quote_currency, b.side, b.best_rate
    ),
    scored as (
      select
        coalesce(k.fetched_at, an.anchor) as at,
        s.currency || '/' || s.quote_currency as pair,
        s.side,
        s.quote_currency,
        k.rate as kursi_rate,
        bn.best_rate,
        coalesce(array_to_string(bn.labels, ', '), '') as best_names,
        coalesce(bn.keys, '{}'::text[]) as best_keys,
        case
          when k.rate is null or bn.best_rate is null then null
          when s.side = 'buy' then private.rate_round5(k.rate - bn.best_rate)
          else private.rate_round5(bn.best_rate - k.rate)
        end as advantage
      from spine s
      join anchors an on an.cluster_at = s.cluster_at
      left join kursi k
        on k.cluster_at = s.cluster_at
       and k.currency = s.currency
       and k.quote_currency = s.quote_currency
       and k.side = s.side
      left join best_named bn
        on bn.cluster_at = s.cluster_at
       and bn.currency = s.currency
       and bn.quote_currency = s.quote_currency
       and bn.side = s.side
    )
    select
      sc.at,
      sc.pair,
      sc.side,
      sc.quote_currency,
      sc.kursi_rate,
      sc.best_rate,
      sc.best_names,
      sc.best_keys,
      sc.advantage,
      case
        when sc.kursi_rate is null then 'no_kursi'
        when sc.best_rate is null then 'only_kursi'
        when sc.advantage > 0 then 'best'
        when sc.advantage = 0 then 'tied'
        else 'worse'
      end as standing,
      case
        when sc.quote_currency = 'GEL' and sc.advantage is not null then sc.advantage * 100
        else null
      end as tetri,
      case
        when sc.kursi_rate is not null and sc.kursi_rate <> 0 and sc.advantage is not null
          then sc.advantage / sc.kursi_rate * 10000
        else null
      end as bps
    from scored sc
    order by sc.pair, sc.side, sc.at
  loop
    if not (v_pairs @> array[rec.pair]) then
      v_pairs := v_pairs || rec.pair;
    end if;

    if v_want is not null and rec.pair = v_want then
      v_observations := v_observations || jsonb_build_array(jsonb_build_object(
        'at', rec.at,
        'pair', rec.pair,
        'side', rec.side,
        'kursi_rate', rec.kursi_rate,
        'best_rate', rec.best_rate,
        'best_names', rec.best_names,
        'best_keys', to_jsonb(rec.best_keys),
        'advantage', rec.advantage,
        'standing', rec.standing,
        'tetri', rec.tetri,
        'bps', rec.bps
      ));
    end if;

    if v_cur_pair is distinct from rec.pair or v_cur_side is distinct from rec.side then
      if v_open then
        v_incidents := v_incidents || jsonb_build_array(private.finish_board_incident(
          'open', v_grain, v_cur_pair, v_cur_side, v_quote,
          v_start_at, v_last_at, null,
          v_start_kursi, v_start_names, v_last_kursi, v_last_names,
          v_max_gap, v_max_kursi, v_max_best, v_max_names, v_max_keys, v_max_tetri, v_max_bps,
          v_keys, v_points, v_weight, v_weighted, v_adv_sum, v_count
        ));
      end if;
      v_open := false;
      v_prev_at := null;
      v_cur_pair := rec.pair;
      v_cur_side := rec.side;
    end if;

    -- only Kursi, best, and tied end the run at that observation.
    -- No Kursi rate is not a recovery: the run stops at the last worse point.
    -- A gap over 90 minutes is a hole, not a still-worse stretch.
    v_comparable := rec.standing in ('worse', 'best', 'tied', 'only_kursi');
    if v_open then
      if (not v_comparable) or rec.at - v_prev_at > interval '90 minutes' then
        v_incidents := v_incidents || jsonb_build_array(private.finish_board_incident(
          'break', v_grain, v_cur_pair, v_cur_side, v_quote,
          v_start_at, v_last_at, v_last_at,
          v_start_kursi, v_start_names, v_last_kursi, v_last_names,
          v_max_gap, v_max_kursi, v_max_best, v_max_names, v_max_keys, v_max_tetri, v_max_bps,
          v_keys, v_points, v_weight, v_weighted, v_adv_sum, v_count
        ));
        v_open := false;
      elsif rec.standing <> 'worse' then
        v_mins := extract(epoch from (rec.at - v_last_at)) / 60.0;
        if v_grain <> 'hours' and v_mins > 0 then
          v_weighted := v_weighted + v_last_adv * v_mins;
          v_weight := v_weight + v_mins;
        end if;
        v_points := v_points || jsonb_build_array(jsonb_build_object(
          'at', rec.at,
          'pair', rec.pair,
          'side', rec.side,
          'kursi_rate', rec.kursi_rate,
          'best_rate', rec.best_rate,
          'best_names', rec.best_names,
          'best_keys', to_jsonb(rec.best_keys),
          'advantage', rec.advantage,
          'standing', rec.standing,
          'tetri', rec.tetri,
          'bps', rec.bps
        ));
        v_incidents := v_incidents || jsonb_build_array(private.finish_board_incident(
          'flip', v_grain, v_cur_pair, v_cur_side, v_quote,
          v_start_at, v_last_at, rec.at,
          v_start_kursi, v_start_names, rec.kursi_rate, rec.best_names,
          v_max_gap, v_max_kursi, v_max_best, v_max_names, v_max_keys, v_max_tetri, v_max_bps,
          v_keys, v_points, v_weight, v_weighted, v_adv_sum, v_count
        ));
        v_open := false;
      else
        v_mins := extract(epoch from (rec.at - v_last_at)) / 60.0;
        if v_grain <> 'hours' and v_mins > 0 then
          v_weighted := v_weighted + v_last_adv * v_mins;
          v_weight := v_weight + v_mins;
        end if;
        v_adv_sum := v_adv_sum + rec.advantage;
        v_count := v_count + 1;
        v_keys := v_keys || coalesce(rec.best_keys, '{}'::text[]);
        v_points := v_points || jsonb_build_array(jsonb_build_object(
          'at', rec.at,
          'pair', rec.pair,
          'side', rec.side,
          'kursi_rate', rec.kursi_rate,
          'best_rate', rec.best_rate,
          'best_names', rec.best_names,
          'best_keys', to_jsonb(rec.best_keys),
          'advantage', rec.advantage,
          'standing', rec.standing,
          'tetri', rec.tetri,
          'bps', rec.bps
        ));
        if rec.advantage < v_max_gap then
          v_max_gap := rec.advantage;
          v_max_kursi := rec.kursi_rate;
          v_max_best := rec.best_rate;
          v_max_names := rec.best_names;
          v_max_keys := rec.best_keys;
          v_max_tetri := rec.tetri;
          v_max_bps := rec.bps;
        end if;
        v_last_at := rec.at;
        v_last_adv := rec.advantage;
        v_last_kursi := rec.kursi_rate;
        v_last_names := rec.best_names;
      end if;
    end if;

    if not v_open and rec.standing = 'worse' then
      v_open := true;
      v_quote := rec.quote_currency;
      v_start_at := rec.at;
      v_start_kursi := rec.kursi_rate;
      v_start_names := rec.best_names;
      v_last_at := rec.at;
      v_last_adv := rec.advantage;
      v_last_kursi := rec.kursi_rate;
      v_last_names := rec.best_names;
      v_max_gap := rec.advantage;
      v_max_kursi := rec.kursi_rate;
      v_max_best := rec.best_rate;
      v_max_names := rec.best_names;
      v_max_keys := rec.best_keys;
      v_max_tetri := rec.tetri;
      v_max_bps := rec.bps;
      v_keys := coalesce(rec.best_keys, '{}'::text[]);
      v_adv_sum := rec.advantage;
      v_count := 1;
      v_weight := 0;
      v_weighted := 0;
      v_points := jsonb_build_array(jsonb_build_object(
        'at', rec.at,
        'pair', rec.pair,
        'side', rec.side,
        'kursi_rate', rec.kursi_rate,
        'best_rate', rec.best_rate,
        'best_names', rec.best_names,
        'best_keys', to_jsonb(rec.best_keys),
        'advantage', rec.advantage,
        'standing', rec.standing,
        'tetri', rec.tetri,
        'bps', rec.bps
      ));
    end if;

    if v_comparable then
      v_prev_at := rec.at;
    end if;
  end loop;

  if v_open then
    v_incidents := v_incidents || jsonb_build_array(private.finish_board_incident(
      'open', v_grain, v_cur_pair, v_cur_side, v_quote,
      v_start_at, v_last_at, null,
      v_start_kursi, v_start_names, v_last_kursi, v_last_names,
      v_max_gap, v_max_kursi, v_max_best, v_max_names, v_max_keys, v_max_tetri, v_max_bps,
      v_keys, v_points, v_weight, v_weighted, v_adv_sum, v_count
    ));
  end if;

  return jsonb_build_object(
    'grain', v_grain,
    'reason', null,
    'pairs', coalesce(to_jsonb(v_pairs), '[]'::jsonb),
    'observations', v_observations,
    'incidents', v_incidents
  );
end;
$$;

comment on function public.board_competitiveness(date, date, text) is
  'Public Kursi board versus the best competitor. Does not read requests. Positive gap means the board is better. Rule version 2026-10-15.';

revoke all on function private.rate_in_scale(text, numeric) from public, anon, authenticated;
revoke all on function private.rate_canonical(text) from public, anon, authenticated;
revoke all on function private.rate_pair_allowed(text, text) from public, anon, authenticated;
revoke all on function private.rate_sides_in(text, numeric, numeric) from public, anon, authenticated;
revoke all on function private.rate_looks_reciprocal(text, numeric, numeric) from public, anon, authenticated;
revoke all on function private.rate_invert(numeric, numeric) from public, anon, authenticated;
revoke all on function private.rate_round5(numeric) from public, anon, authenticated;
revoke all on function private.orient_board_rate(text, text, text, numeric, numeric) from public, anon, authenticated;
revoke all on function private.rate_identity(text, text, text) from public, anon, authenticated;
revoke all on function private.finish_board_incident(text, text, text, text, text, timestamptz, timestamptz, timestamptz, numeric, text, numeric, text, numeric, numeric, numeric, text, text[], numeric, numeric, text[], jsonb, numeric, numeric, numeric, integer) from public, anon, authenticated;

revoke all on function public.board_competitiveness(date, date, text) from public, anon;
grant execute on function public.board_competitiveness(date, date, text) to authenticated;

create index if not exists market_rates_board_range_idx
  on public.market_rates (fetched_at, currency, quote_currency)
  where venue_kind in ('board', 'bank');
