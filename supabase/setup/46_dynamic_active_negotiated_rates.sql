-- Paste this in the Supabase SQL editor when you want the change.
-- Copy it from disk. Paste it after 45_historical_display_class.sql.
-- Do not re-run 1_platform.sql. Do not edit 43, 44, or 45.
-- Safe to paste again.
--
-- This file does not create a table. public.dynamic_active_negotiated_rates
-- already exists (the export dynamic_active_negotiated_rates_rows.csv).
-- It does not grant that table to anon or authenticated.
-- It does not write client_special_rates, quotes, requests.rate, or any request.
-- It does not change reference_rates.
--
-- One function reads one client. It returns that client's unexpired
-- GEL/USD and GEL/EUR rows, plus the current standard buy, sell, and
-- midpoint for USD or EUR against GEL. Midpoint is (buy + sell) / 2.
-- There is no mid column. The standard row is "now", not a history row.
-- A KAM cannot select reference_rates, so the function reads it itself.
--
-- buy_rate and sell_rate are adjustments, not full FX rates.
-- If several unexpired rows share a pair, the latest created_at is kept.
-- If created_at ties, every tied row is returned. The function does not pick.
-- A past expires_at is not active. A blank expires_at stays active.
--
-- The caller must be an active kam, treasury, admin, or manager.
-- An analyst is rejected. A null or malformed client id is rejected.
-- is_my_client is not a block: a KAM may read any client and must not
-- modify another KAM's request. This function only reads.

revoke all on table public.dynamic_active_negotiated_rates from public, anon, authenticated;

create or replace function public.dynamic_active_negotiated_rates_for_client(p_client_id text)
returns table (
  row_id             text,
  created_at         timestamptz,
  expires_at         timestamptz,
  base_currency      text,
  secondary_currency text,
  pair               text,
  buy_rate           numeric,
  sell_rate          numeric,
  standard_buy       numeric,
  standard_sell      numeric,
  midpoint           numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me   uuid := private.my_profile_id();
  v_role text := private.my_role();
  v_id   text := private.normalize_client_id(p_client_id);
begin
  if v_me is null or v_role is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  if v_id is null or v_id !~ '^([0-9]{9}|[0-9]{11})$' then
    raise exception 'კლიენტის ID არასწორია' using errcode = '22023';
  end if;
  if v_role not in ('kam', 'treasury', 'admin', 'manager') then
    raise exception 'ამ კორექტირების ნახვა არ შეგიძლიათ' using errcode = '42501';
  end if;

  return query
  with raw as (
    select
      r.id::text as row_id,
      r.created_at,
      r.expires_at,
      upper(btrim(r.base_currency)) as base_currency,
      upper(btrim(r.secondary_currency)) as secondary_currency,
      r.buy_rate,
      r.sell_rate
    from public.dynamic_active_negotiated_rates r
    where private.normalize_client_id(r.user_identifier::text) = v_id
      and (r.expires_at is null or r.expires_at > now())
  ),
  pairs as (
    select
      raw.row_id,
      raw.created_at,
      raw.expires_at,
      raw.base_currency,
      raw.secondary_currency,
      raw.buy_rate,
      raw.sell_rate,
      case
        when raw.base_currency = 'GEL' and raw.secondary_currency in ('USD', 'EUR') then raw.secondary_currency
        when raw.secondary_currency = 'GEL' and raw.base_currency in ('USD', 'EUR') then raw.base_currency
        else null
      end as foreign_currency
    from raw
  ),
  gel as (
    select
      pairs.row_id,
      pairs.created_at,
      pairs.expires_at,
      pairs.base_currency,
      pairs.secondary_currency,
      pairs.buy_rate,
      pairs.sell_rate,
      pairs.foreign_currency
    from pairs
    where pairs.foreign_currency is not null
  ),
  latest as (
    select gel.foreign_currency, max(gel.created_at) as created_at
    from gel
    group by gel.foreign_currency
  )
  select
    g.row_id,
    g.created_at,
    g.expires_at,
    g.base_currency,
    g.secondary_currency,
    ('GEL/' || g.foreign_currency)::text,
    g.buy_rate,
    g.sell_rate,
    std.buy,
    std.sell,
    case
      when std.buy is not null and std.sell is not null then (std.buy + std.sell) / 2
      else null
    end
  from gel g
  join latest l
    on l.foreign_currency = g.foreign_currency
   and g.created_at is not distinct from l.created_at
  left join public.reference_rates std
    on std.source = 'standard'
   and std.currency = g.foreign_currency
   and std.quote_currency = 'GEL'
  order by g.foreign_currency, g.row_id;
end;
$$;

comment on function public.dynamic_active_negotiated_rates_for_client(text) is
  'One client''s unexpired GEL/USD and GEL/EUR negotiated adjustments, with the current standard buy, sell, and midpoint. Read only. Kam, treasury, admin, or manager. Not an analyst. Does not write a rate.';

revoke all on function public.dynamic_active_negotiated_rates_for_client(text) from public, anon;
grant execute on function public.dynamic_active_negotiated_rates_for_client(text) to authenticated;
