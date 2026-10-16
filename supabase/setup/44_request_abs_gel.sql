-- Paste this in the Supabase SQL editor when you want the change.
-- Copy it from disk. Paste it after 43_defer_rate_write.sql.
-- Do not re-run 1_platform.sql. Do not paste 43 again.
-- Safe to paste again. It does not change requests, quotes, clients,
-- request_outcomes, analyst_deals, treasury_queue, or gel_amount.
-- It does not write an owner. It does not drop a view.
--
-- ABS GEL is the received amount (requests.gets_amount) times the GEL
-- value of one unit of the received currency (requests.gets_currency).
-- requests.amount is the amount the client sells. It is not used here.
-- When gets_amount is empty, the status is missing_amount. The sell
-- amount is not converted through the negotiated rate.
--
-- The GEL value is a historical board snapshot in market_rates.
-- fetch-market-rates stores a batch every 30 minutes (cron */30),
-- and each source in that run gets its own fetched_at. A snapshot is
-- used only when fetched_at is at or before requested_at and not more
-- than 30 minutes earlier. Older than that is missing_rate, not zero,
-- and today's rate is not used. reference_rates is current only and
-- is not read.
-- A cross uses two legs from that same 30-minute window. The same
-- fetched_at is preferred, because one source batch shares it. If the
-- legs are more than 30 minutes apart, the cross is not calculated.
--
-- Supported direct pairs are the board pairs already stored as lari
-- per 1 unit: USD/GEL, EUR/GEL, RUB/GEL, CNY/GEL. RUB is used only
-- when the stored figure is already below 1. A ruble figure of 1 or
-- more is not inverted and is not divided by a constant.
-- If EUR/GEL or CNY/GEL is missing, one intermediate path is allowed:
-- EUR/USD × USD/GEL, or USD/GEL ÷ USD/CNY. The product must land in
-- the same lari band. GBP and any other currency have no stored path.
--
-- Money is rounded to 2 decimal places (tetri). The rate is rounded
-- to 8 decimal places. Both use PostgreSQL numeric round (half away
-- from zero).
--
-- Won / lost / open on the analytics functions is request status only.
-- Won: rate_written_at is set. A payment mark is not a win.
-- Lost: not won, and an explicit decline or loss mark (client decline,
-- treasury decline, marked_lost_at, or loss_reason).
-- Open: everything else, including a payment mark with no written rate,
-- a transaction match, and a legacy file status. Those stay on
-- request_outcomes. A written rate wins over a loss mark on the same row.


create index if not exists market_rates_ccy_quote_fetched_idx
  on public.market_rates (currency, quote_currency, fetched_at desc);

-- Lari per 1 unit, using the bands the rate fetcher already trusts.
-- RUB must be below 1. A wider band is not accepted.
create or replace function private.gel_scale_ok(p_currency text, p_value numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value is not null
     and p_value > 0
     and case p_currency
       when 'USD' then p_value >= 1.5 and p_value <= 4.2
       when 'EUR' then p_value >= 1.6 and p_value <= 4.8
       when 'RUB' then p_value >= 0.008 and p_value < 1 and p_value <= 0.15
       when 'CNY' then p_value >= 0.15 and p_value <= 0.8
       else false
     end
$$;

-- One stored number, turned into lari per 1 unit of p_currency.
-- Direct CCY/GEL in band is used as stored.
-- A reciprocal CCY/GEL is inverted, except RUB: a ruble figure of 1
-- or more is rejected and is not divided.
-- GEL/CCY is inverted when 1/value lands in the lari band. RUB is not.
create or replace function private.orient_gel_rate(
  p_currency text,
  p_row_ccy text,
  p_row_quote text,
  p_value numeric
)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or p_value <= 0 then null
    when p_currency = 'RUB' and p_value >= 1 then null
    when p_row_ccy = p_currency
     and p_row_quote = 'GEL'
     and private.gel_scale_ok(p_currency, p_value)
      then round(p_value, 8)
    when p_currency <> 'RUB'
     and p_row_ccy = p_currency
     and p_row_quote = 'GEL'
     and not private.gel_scale_ok(p_currency, p_value)
     and private.gel_scale_ok(p_currency, 1 / p_value)
      then round(1 / p_value, 8)
    when p_currency <> 'RUB'
     and p_row_ccy = 'GEL'
     and p_row_quote = p_currency
     and private.gel_scale_ok(p_currency, 1 / p_value)
      then round(1 / p_value, 8)
    else null
  end
$$;

-- Quote per 1 base, inside an explicit band.
-- Used by the cross lookup. Defined first so that function can call it.
create or replace function private.pair_in_band(
  p_base text,
  p_quote text,
  p_row_ccy text,
  p_row_quote text,
  p_value numeric,
  p_low numeric,
  p_high numeric
)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or p_value <= 0 or p_low is null or p_high is null then null
    when p_row_ccy = p_base and p_row_quote = p_quote and p_value >= p_low and p_value <= p_high
      then round(p_value, 8)
    when p_row_ccy = p_quote and p_row_quote = p_base
     and (1 / p_value) >= p_low and (1 / p_value) <= p_high
      then round(1 / p_value, 8)
    when p_row_ccy = p_base and p_row_quote = p_quote
     and not (p_value >= p_low and p_value <= p_high)
     and (1 / p_value) >= p_low and (1 / p_value) <= p_high
      then round(1 / p_value, 8)
    else null
  end
$$;

-- Latest usable lari-per-unit snapshot in the 30 minutes at or before p_at.
-- Official (NBG stored on the row) beats a board side.
-- The latest such official wins. Valuto breaks a tie.
-- If no official is in band, the latest usable board side is used.
-- A snapshot older than one fetch interval is not returned.
create or replace function private.historical_gel_rate(p_currency text, p_at timestamptz)
returns table (rate numeric, rate_at timestamptz, source text)
language sql
stable
security definer
set search_path = ''
as $$
  select picked.gel_rate, picked.fetched_at, picked.source || ':' || picked.kind
  from (
    select
      r.fetched_at,
      r.source,
      coalesce(o.rate, m.rate, b.rate, s.rate) as gel_rate,
      case
        when o.rate is not null then 'official'
        when m.rate is not null then 'mid'
        when b.rate is not null then 'buy'
        else 'sell'
      end as kind,
      case when r.source = 'valuto' and r.venue = 'Valuto' then 0 else 1 end as valuto_rank
    from public.market_rates r
    cross join lateral (
      select private.orient_gel_rate(p_currency, r.currency, r.quote_currency, r.official) as rate
    ) o
    cross join lateral (
      select private.orient_gel_rate(
        p_currency, r.currency, r.quote_currency,
        case when r.buy > 0 and r.sell > 0 then (r.buy + r.sell) / 2 else null end
      ) as rate
    ) m
    cross join lateral (
      select private.orient_gel_rate(p_currency, r.currency, r.quote_currency, r.buy) as rate
    ) b
    cross join lateral (
      select private.orient_gel_rate(p_currency, r.currency, r.quote_currency, r.sell) as rate
    ) s
    where r.fetched_at <= p_at
      and r.fetched_at > p_at - interval '30 minutes'
      and r.venue_kind in ('board', 'bank')
      and r.venue not like '% app'
      and (
        (r.currency = p_currency and r.quote_currency = 'GEL')
        or (r.currency = 'GEL' and r.quote_currency = p_currency)
      )
      and coalesce(o.rate, m.rate, b.rate, s.rate) is not null
  ) picked
  order by
    case when picked.kind = 'official' then 0 else 1 end,
    picked.fetched_at desc,
    picked.valuto_rank
  limit 1
$$;

-- Same pair rules, but only the snapshot stored at p_exact.
-- One source batch shares fetched_at, so a cross can use that batch.
create or replace function private.historical_gel_rate_exact(p_currency text, p_exact timestamptz)
returns table (rate numeric, rate_at timestamptz, source text)
language sql
stable
security definer
set search_path = ''
as $$
  select picked.gel_rate, picked.fetched_at, picked.source || ':' || picked.kind
  from (
    select
      r.fetched_at,
      r.source,
      coalesce(o.rate, m.rate, b.rate, s.rate) as gel_rate,
      case
        when o.rate is not null then 'official'
        when m.rate is not null then 'mid'
        when b.rate is not null then 'buy'
        else 'sell'
      end as kind,
      case when r.source = 'valuto' and r.venue = 'Valuto' then 0 else 1 end as valuto_rank
    from public.market_rates r
    cross join lateral (
      select private.orient_gel_rate(p_currency, r.currency, r.quote_currency, r.official) as rate
    ) o
    cross join lateral (
      select private.orient_gel_rate(
        p_currency, r.currency, r.quote_currency,
        case when r.buy > 0 and r.sell > 0 then (r.buy + r.sell) / 2 else null end
      ) as rate
    ) m
    cross join lateral (
      select private.orient_gel_rate(p_currency, r.currency, r.quote_currency, r.buy) as rate
    ) b
    cross join lateral (
      select private.orient_gel_rate(p_currency, r.currency, r.quote_currency, r.sell) as rate
    ) s
    where r.fetched_at = p_exact
      and r.venue_kind in ('board', 'bank')
      and r.venue not like '% app'
      and (
        (r.currency = p_currency and r.quote_currency = 'GEL')
        or (r.currency = 'GEL' and r.quote_currency = p_currency)
      )
      and coalesce(o.rate, m.rate, b.rate, s.rate) is not null
  ) picked
  order by
    case when picked.kind = 'official' then 0 else 1 end,
    picked.valuto_rank
  limit 1
$$;

-- Latest quote per 1 base in the 30 minutes at or before p_at, inside the band.
-- Used only for EUR/USD and USD/CNY. Older than one fetch interval is not returned.
create or replace function private.historical_pair_rate(
  p_base text,
  p_quote text,
  p_at timestamptz,
  p_low numeric,
  p_high numeric
)
returns table (rate numeric, rate_at timestamptz, source text)
language sql
stable
security definer
set search_path = ''
as $$
  select picked.pair_rate, picked.fetched_at, picked.source || ':' || picked.kind
  from (
    select
      r.fetched_at,
      r.source,
      coalesce(o.rate, m.rate, b.rate, s.rate) as pair_rate,
      case
        when o.rate is not null then 'official'
        when m.rate is not null then 'mid'
        when b.rate is not null then 'buy'
        else 'sell'
      end as kind,
      case when r.source = 'valuto' and r.venue = 'Valuto' then 0 else 1 end as valuto_rank
    from public.market_rates r
    cross join lateral (
      select private.pair_in_band(p_base, p_quote, r.currency, r.quote_currency, r.official, p_low, p_high) as rate
    ) o
    cross join lateral (
      select private.pair_in_band(
        p_base, p_quote, r.currency, r.quote_currency,
        case when r.buy > 0 and r.sell > 0 then (r.buy + r.sell) / 2 else null end,
        p_low, p_high
      ) as rate
    ) m
    cross join lateral (
      select private.pair_in_band(p_base, p_quote, r.currency, r.quote_currency, r.buy, p_low, p_high) as rate
    ) b
    cross join lateral (
      select private.pair_in_band(p_base, p_quote, r.currency, r.quote_currency, r.sell, p_low, p_high) as rate
    ) s
    where r.fetched_at <= p_at
      and r.fetched_at > p_at - interval '30 minutes'
      and r.venue_kind in ('board', 'bank')
      and r.venue not like '% app'
      and (
        (r.currency = p_base and r.quote_currency = p_quote)
        or (r.currency = p_quote and r.quote_currency = p_base)
      )
      and coalesce(o.rate, m.rate, b.rate, s.rate) is not null
  ) picked
  order by
    case when picked.kind = 'official' then 0 else 1 end,
    picked.fetched_at desc,
    picked.valuto_rank
  limit 1
$$;

revoke all on function private.gel_scale_ok(text, numeric) from public, anon, authenticated;
revoke all on function private.orient_gel_rate(text, text, text, numeric) from public, anon, authenticated;
revoke all on function private.pair_in_band(text, text, text, text, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function private.historical_gel_rate(text, timestamptz) from public, anon, authenticated;
revoke all on function private.historical_gel_rate_exact(text, timestamptz) from public, anon, authenticated;
revoke all on function private.historical_pair_rate(text, text, timestamptz, numeric, numeric) from public, anon, authenticated;

-- Received amount × historical lari per 1 unit of the received currency.
create or replace function private.request_abs_valuation(
  p_gets_currency text,
  p_gets_amount numeric,
  p_at timestamptz
)
returns table (
  request_abs_gel numeric,
  valuation_currency text,
  valuation_rate numeric,
  valuation_timestamp timestamptz,
  valuation_source text,
  valuation_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ccy text := upper(btrim(coalesce(p_gets_currency, '')));
  v_rate numeric;
  v_at timestamptz;
  v_source text;
  v_leg_rate numeric;
  v_leg_at timestamptz;
  v_leg_source text;
  v_usd_rate numeric;
  v_usd_at timestamptz;
  v_usd_source text;
  v_product numeric;
begin
  request_abs_gel := null;
  valuation_currency := nullif(v_ccy, '');
  valuation_rate := null;
  valuation_timestamp := null;
  valuation_source := null;
  valuation_status := null;

  if p_gets_amount is null then
    valuation_status := 'missing_amount';
    return next;
    return;
  end if;

  if v_ccy !~ '^[A-Z]{3}$' then
    valuation_status := 'unsupported_currency';
    return next;
    return;
  end if;

  valuation_currency := v_ccy;

  if v_ccy = 'GEL' then
    request_abs_gel := round(abs(p_gets_amount), 2);
    valuation_rate := 1;
    valuation_timestamp := p_at;
    valuation_source := 'received_gel';
    valuation_status := 'calculated';
    return next;
    return;
  end if;

  if p_at is null then
    valuation_status := case when v_ccy in ('USD', 'EUR', 'RUB', 'CNY') then 'missing_rate' else 'unsupported_currency' end;
    return next;
    return;
  end if;

  select h.rate, h.rate_at, h.source
    into v_rate, v_at, v_source
  from private.historical_gel_rate(v_ccy, p_at) h;

  if v_rate is null and v_ccy = 'EUR' then
    select h.rate, h.rate_at, h.source
      into v_leg_rate, v_leg_at, v_leg_source
    from private.historical_pair_rate('EUR', 'USD', p_at, 0.95, 1.55) h;
    if v_leg_at is not null then
      select h.rate, h.rate_at, h.source
        into v_usd_rate, v_usd_at, v_usd_source
      from private.historical_gel_rate_exact('USD', v_leg_at) h;
    end if;
    if v_usd_rate is null then
      select h.rate, h.rate_at, h.source
        into v_usd_rate, v_usd_at, v_usd_source
      from private.historical_gel_rate('USD', p_at) h;
    end if;
    if v_leg_rate is not null and v_usd_rate is not null
       and v_leg_at is not null and v_usd_at is not null
       and abs(v_leg_at - v_usd_at) <= interval '30 minutes'
    then
      v_product := round(v_leg_rate * v_usd_rate, 8);
      if private.gel_scale_ok('EUR', v_product) then
        v_rate := v_product;
        v_at := least(v_leg_at, v_usd_at);
        v_source := 'cross:EUR/USD*USD/GEL:' || v_usd_source;
      end if;
    end if;
  elsif v_rate is null and v_ccy = 'CNY' then
    select h.rate, h.rate_at, h.source
      into v_leg_rate, v_leg_at, v_leg_source
    from private.historical_pair_rate('USD', 'CNY', p_at, 4.5, 12) h;
    if v_leg_at is not null then
      select h.rate, h.rate_at, h.source
        into v_usd_rate, v_usd_at, v_usd_source
      from private.historical_gel_rate_exact('USD', v_leg_at) h;
    end if;
    if v_usd_rate is null then
      select h.rate, h.rate_at, h.source
        into v_usd_rate, v_usd_at, v_usd_source
      from private.historical_gel_rate('USD', p_at) h;
    end if;
    if v_leg_rate is not null and v_leg_rate <> 0 and v_usd_rate is not null
       and v_leg_at is not null and v_usd_at is not null
       and abs(v_leg_at - v_usd_at) <= interval '30 minutes'
    then
      v_product := round(v_usd_rate / v_leg_rate, 8);
      if private.gel_scale_ok('CNY', v_product) then
        v_rate := v_product;
        v_at := least(v_leg_at, v_usd_at);
        v_source := 'cross:USD/GEL/USD/CNY:' || v_usd_source;
      end if;
    end if;
  end if;

  if v_rate is not null then
    request_abs_gel := round(abs(p_gets_amount) * v_rate, 2);
    valuation_rate := v_rate;
    valuation_timestamp := v_at;
    valuation_source := v_source;
    valuation_status := 'calculated';
  elsif v_ccy in ('USD', 'EUR', 'RUB', 'CNY') then
    valuation_status := 'missing_rate';
  else
    valuation_status := 'unsupported_currency';
  end if;

  return next;
end;
$$;

comment on function private.request_abs_valuation(text, numeric, timestamptz) is
  'ABS GEL of the amount the client receives. gets_amount null is missing_amount. GEL uses the amount. Other currencies use a market_rates snapshot no more than 30 minutes before p_at. A cross requires both legs in that window, same fetched_at first. Never today''s reference_rates row, never a missing rate as zero, never a ruble figure of 1 or more.';

revoke all on function private.request_abs_valuation(text, numeric, timestamptz) from public, anon, authenticated;

-- Request-status class for the analytics KPIs. Not request_outcomes.
create or replace function private.request_kpi_class(
  p_rate_written_at timestamptz,
  p_payment_confirmed_at timestamptz,
  p_marked_lost_at timestamptz,
  p_loss_reason text,
  p_client_reply text,
  p_quote_status text,
  p_import_key text,
  p_legacy_status text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_rate_written_at is not null then 'won'
    when p_marked_lost_at is not null
      or nullif(btrim(coalesce(p_loss_reason, '')), '') is not null
      or p_client_reply = 'declined'
      or p_quote_status = 'declined' then 'lost'
    else 'open'
  end
$$;

comment on function private.request_kpi_class(timestamptz, timestamptz, timestamptz, text, text, text, text, text) is
  'won = rate_written_at only. lost = loss mark, loss reason, or client or treasury decline. open = the rest, including a payment mark, a transaction match, and a legacy file status. The payment and legacy arguments are ignored.';

revoke all on function private.request_kpi_class(timestamptz, timestamptz, timestamptz, text, text, text, text, text) from public, anon, authenticated;

create or replace function private.request_loss_text(
  p_loss_code text,
  p_loss_label text,
  p_legacy_loss text,
  p_loss_note text,
  p_client_decline text,
  p_decline text,
  p_legacy_status text,
  p_import_key text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(concat_ws(
    '. ',
    nullif(btrim(coalesce(p_loss_label, p_legacy_loss)), ''),
    nullif(btrim(p_loss_note), ''),
    nullif(btrim(p_client_decline), ''),
    nullif(btrim(p_decline), '')
  ), '')
$$;

revoke all on function private.request_loss_text(text, text, text, text, text, text, text, text) from public, anon, authenticated;

-- Company or one KAM. A KAM is forced to their own kam_id.
-- Analyst sees the company and cannot pass a KAM filter.
-- Admin and manager may pass p_kam_id. Null dates mean all time.
-- p_to is exclusive. Totals are the sum of the KAM groups.
create or replace function public.analytics_request_kpis(
  p_from date default null,
  p_to date default null,
  p_kam_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.my_profile_id();
  v_role text := private.my_role();
  v_kam uuid;
  v_out jsonb;
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  if v_role = 'kam' then
    v_kam := v_me;
  elsif v_role in ('admin', 'manager') then
    v_kam := p_kam_id;
  elsif v_role = 'analyst' then
    v_kam := null;
  else
    raise exception 'ამ ანგარიშს ანალიტიკა არ აქვს' using errcode = '42501';
  end if;

  with base as (
    select
      r.kam_id,
      nullif(btrim(p.full_name), '') as kam_name,
      (p.id is not null) as profile_found,
      private.request_kpi_class(
        r.rate_written_at,
        r.payment_confirmed_at,
        r.marked_lost_at,
        r.loss_reason,
        r.client_reply,
        r.quote_status,
        r.import_key,
        r.legacy_status
      ) as klass,
      v.request_abs_gel,
      v.valuation_status,
      case
        when private.request_kpi_class(
          r.rate_written_at,
          r.payment_confirmed_at,
          r.marked_lost_at,
          r.loss_reason,
          r.client_reply,
          r.quote_status,
          r.import_key,
          r.legacy_status
        ) = 'lost'
        then private.request_loss_text(
          r.loss_reason, lr.label_ka, r.legacy_loss_reason, r.loss_reason_note,
          r.client_decline_reason, r.decline_reason, r.legacy_status, r.import_key
        )
      end as reason
    from public.requests r
    left join public.profiles p on p.id = r.kam_id
    left join public.loss_reasons lr on lr.code = r.loss_reason
    cross join lateral private.request_abs_valuation(r.gets_currency, r.gets_amount, r.requested_at) v
    where (p_from is null or r.request_date >= p_from)
      and (p_to is null or r.request_date < p_to)
      and (v_kam is null or r.kam_id = v_kam)
  ),
  kam_rows as (
    select
      b.kam_id,
      max(b.kam_name) as kam_name,
      case
        when b.kam_id is null then 'unassigned'
        when bool_or(b.profile_found) then 'named'
        else 'deleted'
      end as kam_state,
      count(*)::bigint as total,
      count(*) filter (where b.klass = 'won')::bigint as won,
      count(*) filter (where b.klass = 'lost')::bigint as lost,
      count(*) filter (where b.klass = 'open')::bigint as open_n,
      sum(b.request_abs_gel) filter (where b.valuation_status = 'calculated') as abs_gel,
      count(*) filter (where b.valuation_status is distinct from 'calculated')::bigint as abs_unavailable,
      sum(b.request_abs_gel) filter (where b.klass = 'won' and b.valuation_status = 'calculated') as won_abs_gel,
      count(*) filter (where b.klass = 'won' and b.valuation_status is distinct from 'calculated')::bigint as won_abs_unavailable,
      sum(b.request_abs_gel) filter (where b.klass = 'lost' and b.valuation_status = 'calculated') as lost_abs_gel,
      count(*) filter (where b.klass = 'lost' and b.valuation_status is distinct from 'calculated')::bigint as lost_abs_unavailable
    from base b
    group by b.kam_id
  ),
  reasons as (
    select
      coalesce(b.reason, '') as label,
      count(*)::bigint as n,
      sum(b.request_abs_gel) filter (where b.valuation_status = 'calculated') as lost_abs_gel,
      count(*) filter (where b.valuation_status is distinct from 'calculated')::bigint as abs_unavailable
    from base b
    where b.klass = 'lost'
    group by coalesce(b.reason, '')
  ),
  totals as (
    select
      coalesce(sum(k.total), 0)::bigint as total,
      coalesce(sum(k.won), 0)::bigint as won,
      coalesce(sum(k.lost), 0)::bigint as lost,
      coalesce(sum(k.open_n), 0)::bigint as open_n,
      sum(k.abs_gel) as abs_gel,
      coalesce(sum(k.abs_unavailable), 0)::bigint as abs_unavailable,
      sum(k.won_abs_gel) as won_abs_gel,
      coalesce(sum(k.won_abs_unavailable), 0)::bigint as won_abs_unavailable,
      sum(k.lost_abs_gel) as lost_abs_gel,
      coalesce(sum(k.lost_abs_unavailable), 0)::bigint as lost_abs_unavailable
    from kam_rows k
  )
  select jsonb_build_object(
    'total', t.total,
    'won', t.won,
    'lost', t.lost,
    'open', t.open_n,
    'abs_gel', t.abs_gel,
    'abs_unavailable', t.abs_unavailable,
    'won_abs_gel', t.won_abs_gel,
    'won_abs_unavailable', t.won_abs_unavailable,
    'lost_abs_gel', t.lost_abs_gel,
    'lost_abs_unavailable', t.lost_abs_unavailable,
    'reasons', coalesce((
      select jsonb_agg(jsonb_build_object(
        'label', r.label,
        'count', r.n,
        'lost_abs_gel', r.lost_abs_gel,
        'abs_unavailable', r.abs_unavailable
      ) order by r.n desc, r.label)
      from reasons r
    ), '[]'::jsonb),
    'kams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kam_id', k.kam_id,
        'name', k.kam_name,
        'state', k.kam_state,
        'total', k.total,
        'won', k.won,
        'lost', k.lost,
        'open', k.open_n,
        'abs_gel', k.abs_gel,
        'abs_unavailable', k.abs_unavailable,
        'won_abs_gel', k.won_abs_gel,
        'won_abs_unavailable', k.won_abs_unavailable,
        'lost_abs_gel', k.lost_abs_gel,
        'lost_abs_unavailable', k.lost_abs_unavailable
      ) order by k.total desc, k.kam_name nulls last)
      from kam_rows k
    ), '[]'::jsonb)
  )
  into v_out
  from totals t;

  return v_out;
end;
$$;

comment on function public.analytics_request_kpis(date, date, uuid) is
  'Request-status KPIs and ABS GEL. Won is rate_written_at only. A KAM sees only kam_id = self. Admin and manager may filter one KAM. Analyst sees every request and the KAM argument is ignored. A payment mark, a transaction match, and a legacy file status are not wins or losses. Totals equal the sum of the KAM rows. Null dates are all time. p_to is exclusive.';

revoke all on function public.analytics_request_kpis(date, date, uuid) from public, anon;
grant execute on function public.analytics_request_kpis(date, date, uuid) to authenticated;

-- Compact client summary for a KAM, admin, or manager who typed an ID.
-- Does not change assigned_kam_id. Does not use bank transactions.
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
      private.request_kpi_class(
        r.rate_written_at, r.payment_confirmed_at, r.marked_lost_at, r.loss_reason,
        r.client_reply, r.quote_status, r.import_key, r.legacy_status
      ) as klass,
      private.request_loss_text(
        r.loss_reason, lr.label_ka, r.legacy_loss_reason, r.loss_reason_note,
        r.client_decline_reason, r.decline_reason, r.legacy_status, r.import_key
      ) as reason
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
  'Request-status summary for one client. KAM, admin, or manager. A new ID with no requests is new_client. Loss warnings use completed requests only. Inactivity is days since the last request in Asia/Tbilisi, and only when that request exists. Does not assign a KAM.';

revoke all on function public.client_request_brief(text) from public, anon;
grant execute on function public.client_request_brief(text) to authenticated;

create or replace function public.client_request_history(
  p_client_id text,
  p_offset int default 0,
  p_limit int default 20
)
returns table (
  id bigint,
  request_date date,
  sells_currency text,
  gets_currency text,
  received_amount numeric,
  request_abs_gel numeric,
  valuation_status text,
  kpi_class text,
  loss_reason text,
  kam_name text
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
  if v_role not in ('kam', 'admin', 'manager') then
    raise exception 'ამ ანგარიშს კლიენტის შეჯამება არ აქვს' using errcode = '42501';
  end if;
  if v_id !~ '^([0-9]{9}|[0-9]{11})$' then
    return;
  end if;

  return query
  select
    r.id,
    r.request_date,
    r.sells_currency,
    r.gets_currency,
    r.gets_amount,
    v.request_abs_gel,
    v.valuation_status,
    private.request_kpi_class(
      r.rate_written_at, r.payment_confirmed_at, r.marked_lost_at, r.loss_reason,
      r.client_reply, r.quote_status, r.import_key, r.legacy_status
    ),
    case
      when private.request_kpi_class(
        r.rate_written_at, r.payment_confirmed_at, r.marked_lost_at, r.loss_reason,
        r.client_reply, r.quote_status, r.import_key, r.legacy_status
      ) = 'lost'
      then private.request_loss_text(
        r.loss_reason, lr.label_ka, r.legacy_loss_reason, r.loss_reason_note,
        r.client_decline_reason, r.decline_reason, r.legacy_status, r.import_key
      )
    end,
    nullif(btrim(p.full_name), '')
  from public.requests r
  left join public.profiles p on p.id = r.kam_id
  left join public.loss_reasons lr on lr.code = r.loss_reason
  cross join lateral private.request_abs_valuation(r.gets_currency, r.gets_amount, r.requested_at) v
  where r.client_id = v_id
  order by r.requested_at desc, r.id desc
  offset v_offset
  limit v_limit;
end;
$$;

comment on function public.client_request_history(text, int, int) is
  'One page of a client''s requests, newest first. At most 21 rows so the screen can see whether another page exists. Received amount is gets_amount. ABS GEL uses the same valuation as analytics.';

revoke all on function public.client_request_history(text, int, int) from public, anon;
grant execute on function public.client_request_history(text, int, int) to authenticated;

-- Cross-currency figure for the analysis grid. Does not write gel_amount.
-- Same roles that can read analyst_deals, plus a manager.
create or replace function public.request_abs_valuations(p_ids bigint[])
returns table (
  id bigint,
  request_abs_gel numeric,
  valuation_currency text,
  valuation_rate numeric,
  valuation_timestamp timestamptz,
  valuation_source text,
  valuation_status text
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
  if v_role not in ('analyst', 'admin', 'treasury', 'manager') then
    raise exception 'ამ ანგარიშს ეს სია არ აქვს' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    return;
  end if;

  return query
  select
    r.id,
    v.request_abs_gel,
    v.valuation_currency,
    v.valuation_rate,
    v.valuation_timestamp,
    v.valuation_source,
    v.valuation_status
  from public.requests r
  cross join lateral private.request_abs_valuation(r.gets_currency, r.gets_amount, r.requested_at) v
  where r.id = any (p_ids[1:200]);
end;
$$;

comment on function public.request_abs_valuations(bigint[]) is
  'ABS GEL for up to 200 request ids. Read only. Analyst, admin, treasury, or manager. Does not replace analyst_deals.amount_gel or requests.gel_amount.';

revoke all on function public.request_abs_valuations(bigint[]) from public, anon;
grant execute on function public.request_abs_valuations(bigint[]) to authenticated;
