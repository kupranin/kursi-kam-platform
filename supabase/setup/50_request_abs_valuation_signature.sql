-- Paste this in the Supabase SQL editor after 45_historical_display_class.sql
-- and 47_new_request_abs_gel.sql.
-- Do not re-run 44, 45, 47, 48, or 49.
-- Safe to paste again.
--
-- public.client_request_history calls
-- private.request_abs_valuation(text, text, numeric, numeric, text, timestamptz, timestamptz).
-- That signature is created in 44_request_abs_gel.sql. Production does not
-- have it, so opening a client's requests fails with 42883. SQL 47 does
-- not create or drop this function. It calls the same seven arguments
-- for a row this feature did not value.
--
-- The body below is the SQL 44 read-time valuation, unchanged.
-- Argument order is sells currency, received currency, received amount,
-- requests.rate, quote_status, quoted_at, requested_at.
-- It does not call private.value_abs_gel. It does not read or write
-- requests.abs_gel. It does not backfill. A null amount stays null.
-- A missing rate is missing_rate, not zero and not pending_admin.
--
-- It does not replace client_request_history, client_request_brief,
-- analytics_request_kpis, request_abs_valuations, or request_display_class.
-- It does not change the ABS GEL trigger, value_abs_gel, pending_admin,
-- or manual_admin. It does not drop the older three-argument overload.

create or replace function private.request_abs_valuation(
  p_sells_currency text,
  p_gets_currency text,
  p_gets_amount numeric,
  p_rate numeric,
  p_quote_status text,
  p_quoted_at timestamptz,
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
  v_sells text := upper(btrim(coalesce(p_sells_currency, '')));
  v_ccy text := upper(btrim(coalesce(p_gets_currency, '')));
  v_rate numeric;
  v_at timestamptz;
  v_source text;
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

  -- requests.rate is the treasury quote: lari per 1 unit received only
  -- when the client sells GEL and the figure is inside the lari band.
  -- A decline or a null rate is missing. A cross, RUB at 1 or above,
  -- and any figure outside the band are not divided and fall through.
  if p_rate is not null
     and p_rate > 0
     and p_quote_status is distinct from 'declined'
     and v_sells = 'GEL'
     and private.gel_scale_ok(v_ccy, p_rate)
  then
    request_abs_gel := round(abs(p_gets_amount) * p_rate, 2);
    valuation_rate := round(p_rate, 8);
    valuation_timestamp := coalesce(p_quoted_at, p_at);
    valuation_source := 'treasury_quote';
    valuation_status := 'calculated';
    return next;
    return;
  end if;

  if p_at is null then
    valuation_status := 'missing_rate';
    return next;
    return;
  end if;

  select h.rate, h.rate_at, h.source
    into v_rate, v_at, v_source
  from private.historical_gel_rate(v_ccy, p_at) h;

  if v_rate is not null then
    request_abs_gel := round(abs(p_gets_amount) * v_rate, 2);
    valuation_rate := v_rate;
    valuation_timestamp := v_at;
    valuation_source := v_source;
    valuation_status := 'calculated';
  else
    valuation_status := 'missing_rate';
  end if;

  return next;
end;
$$;

comment on function private.request_abs_valuation(text, text, numeric, numeric, text, timestamptz, timestamptz) is
  'ABS GEL of the amount the client receives. gets_amount null is missing_amount. GEL received uses the amount and does not apply a rate. requests.rate is the treasury quote and is used first when quote_status is not declined, the rate is not null, the client sells GEL, and the figure is lari per 1 unit of the received currency inside the lari band. A cross quote, a decline, a null rate, and a figure outside the band, including RUB at 1 or more, are not used and are not divided. Otherwise the latest Kursi board sell in market_rates with fetched_at at or before p_at. An older stored snapshot is used. A fetch after p_at is not. reference_rates is current only and is not read. Official, buy, and a competitor rate are not read. Never a missing rate as zero.';

revoke all on function private.request_abs_valuation(text, text, numeric, numeric, text, timestamptz, timestamptz) from public, anon, authenticated;

-- Read-only checks. Leave these lines commented. They do not write.
--
-- The seven-argument function is present:
-- select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'private'
--   and p.proname = 'request_abs_valuation'
--   and pg_get_function_identity_arguments(p.oid)
--       = 'p_sells_currency text, p_gets_currency text, p_gets_amount numeric, p_rate numeric, p_quote_status text, p_quoted_at timestamp with time zone, p_at timestamp with time zone';
--
-- client_request_history identity and OUT list are unchanged.
-- Expect one row. args must be: p_client_id text, p_offset integer, p_limit integer
-- Expect result to be these 16 columns, in this order:
-- id bigint, request_date date, requested_at timestamp with time zone,
-- sells_currency text, gets_currency text, amount numeric, received_amount numeric,
-- rate numeric, bank text, request_abs_gel numeric, valuation_status text,
-- kpi_class text, loss_reason text, legacy_status text, kam_name text, owner_name text
-- select pg_get_function_identity_arguments(p.oid) as args,
--        pg_get_function_result(p.oid) as result
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname = 'client_request_history';
