-- Paste this in the Supabase SQL editor after 47_new_request_abs_gel.sql.
-- Do not re-run 49, 50, 51, or 52. Safe to paste again.
-- Does not execute a delete. Does not change log_request.
--
-- Analytics Amount GEL is private.request_gel. When the client sells GEL
-- and that sell amount is filled, the lari figure is the sell amount.
-- When the client receives GEL and that amount is filled, the lari figure
-- is the received amount. Neither of those is multiplied by the rate.
-- When the GEL amount is empty, the lari figure is the foreign amount
-- times the request rate, and only when that rate is already lari per
-- 1 unit of the foreign currency.
--
-- This replaces private.value_abs_gel only. The trigger already calls it.
-- A filled received GEL amount stays abs(gets_amount), source received_gel.
-- A missing received GEL amount, selling USD, EUR, RUB, or CNY, with
-- requests.rate inside the lari band, becomes abs(sell amount × rate),
-- rounded to tetri. Source stays treasury_quote, because that is the
-- request rate. Path is sold_times_rate. It is not a board snapshot.
-- A missing rate is not taken from the board and stays pending_admin.
-- RUB at 1 or above is outside the band and is not multiplied.
-- A result of zero is not stored. Status is calculated only when the
-- multiply succeeds. The function does not raise.
--
-- Selling GEL is unchanged. A filled GEL sell amount is the lari figure.
-- A filled foreign receive amount times an in-band rate is the lari
-- figure. Crosses are unchanged. SQL 45 and SQL 49 are unchanged.
--
-- The update below only touches app rows created on or after
-- 2026-10-17 00:00 Asia/Tbilisi that are still pending because the
-- received lari is missing, sell a foreign currency, and already have
-- an in-band rate. Setting amount to itself makes the existing trigger
-- recalculate. Older rows are not updated. Nothing is deleted.

create or replace function private.value_abs_gel(
  p_sells text,
  p_gets text,
  p_sell_amt numeric,
  p_gets_amt numeric,
  p_rate numeric,
  p_quote_status text,
  p_quoted_at timestamptz,
  p_at timestamptz,
  p_board_rate numeric,
  p_board_at timestamptz,
  p_board_path text,
  p_lookup_board boolean
)
returns table (
  abs_gel numeric,
  abs_source text,
  abs_status text,
  abs_rate numeric,
  abs_rate_at timestamptz,
  abs_path text,
  abs_reason text,
  board_rate numeric,
  board_at timestamptz,
  board_path text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sells text := upper(btrim(coalesce(p_sells, '')));
  v_gets text := upper(btrim(coalesce(p_gets, '')));
  v_rate numeric;
  v_at timestamptz;
  v_path text;
  v_abs numeric;
  v_quote boolean;
begin
  if v_gets = 'GEL' then
    board_rate := p_board_rate;
    board_at := p_board_at;
    board_path := p_board_path;
    if p_gets_amt is not null and p_gets_amt > 0 and round(abs(p_gets_amt), 2) > 0 then
      abs_gel := round(abs(p_gets_amt), 2);
      abs_source := 'received_gel';
      abs_status := 'calculated';
      abs_rate := 1;
      abs_rate_at := p_at;
      abs_path := 'received_gel';
      abs_reason := null;
    elsif v_sells in ('USD', 'EUR', 'RUB', 'CNY')
      and p_sell_amt is not null
      and p_sell_amt > 0
      and private.gel_scale_ok(v_sells, p_rate)
    then
      v_abs := round(abs(p_sell_amt) * p_rate, 2);
      if v_abs is not null and v_abs > 0 then
        abs_gel := v_abs;
        abs_source := 'treasury_quote';
        abs_status := 'calculated';
        abs_rate := round(p_rate, 8);
        abs_rate_at := coalesce(p_quoted_at, now());
        abs_path := 'sold_times_rate';
        abs_reason := null;
      else
        abs_gel := null;
        abs_source := null;
        abs_status := 'pending_admin';
        abs_rate := null;
        abs_rate_at := null;
        abs_path := null;
        abs_reason := 'missing_gets_gel';
      end if;
    else
      abs_gel := null;
      abs_source := null;
      abs_status := 'pending_admin';
      abs_rate := null;
      abs_rate_at := null;
      abs_path := null;
      abs_reason := 'missing_gets_gel';
    end if;
    return next;
    return;
  end if;

  if p_lookup_board then
    select s.rate, s.rate_at, s.path into v_rate, v_at, v_path
    from private.snapshot_received_gel(v_gets) s;
  else
    v_rate := p_board_rate;
    v_at := p_board_at;
    v_path := p_board_path;
  end if;

  board_rate := v_rate;
  board_at := v_at;
  board_path := v_path;

  v_quote := v_sells = 'GEL'
    and p_quote_status is distinct from 'declined'
    and p_rate is not null
    and p_rate > 0
    and private.gel_scale_ok(v_gets, p_rate);

  if v_quote then
    if p_gets_amt is not null and p_gets_amt > 0 then
      v_abs := round(abs(p_gets_amt) * p_rate, 2);
    elsif p_sell_amt is not null and p_sell_amt > 0 then
      v_abs := round(abs(p_sell_amt), 2);
    else
      v_abs := null;
    end if;
    if v_abs is not null and v_abs > 0 then
      abs_gel := v_abs;
      abs_source := 'treasury_quote';
      abs_status := 'calculated';
      abs_rate := round(p_rate, 8);
      -- Prefer quoted_at. A missing quote time is this write, not the request time in p_at.
      abs_rate_at := coalesce(p_quoted_at, now());
      abs_path := 'treasury_quote';
      abs_reason := null;
      return next;
      return;
    end if;
  end if;

  if v_rate is not null and v_rate > 0 and private.gel_scale_ok(v_gets, v_rate) then
    if p_gets_amt is not null and p_gets_amt > 0 then
      v_abs := round(abs(p_gets_amt) * v_rate, 2);
      if v_abs is not null and v_abs > 0 then
        abs_gel := v_abs;
        abs_source := 'provisional_board';
        abs_status := 'calculated';
        abs_rate := v_rate;
        abs_rate_at := v_at;
        abs_path := v_path;
        abs_reason := null;
        return next;
        return;
      end if;
    elsif v_sells = 'GEL' and p_sell_amt is not null and p_sell_amt > 0 and v_path = 'direct' then
      v_abs := round(abs(p_sell_amt), 2);
      if v_abs is not null and v_abs > 0 then
        abs_gel := v_abs;
        abs_source := 'provisional_board';
        abs_status := 'calculated';
        abs_rate := v_rate;
        abs_rate_at := v_at;
        abs_path := 'direct';
        abs_reason := null;
        return next;
        return;
      end if;
    end if;
  end if;

  abs_gel := null;
  abs_source := null;
  abs_status := 'pending_admin';
  abs_rate := null;
  abs_rate_at := null;
  abs_path := null;
  if p_gets_amt is null and not (v_sells = 'GEL' and v_path = 'direct' and v_rate is not null) then
    abs_reason := case when v_rate is null then 'no_board_rate' else 'cannot_derive' end;
  elsif v_rate is null then
    abs_reason := 'no_board_rate';
  else
    abs_reason := 'rounds_to_zero';
  end if;
  return next;
end;
$$;

-- Recalculate only the new-app rows this branch can now value.
-- A second paste matches nothing, because those rows are no longer pending.
update public.requests r
set amount = r.amount
where r.source = 'app'
  and r.created_at >= timestamptz '2026-10-17 00:00:00+04'
  and r.abs_gel_status = 'pending_admin'
  and r.abs_gel_reason = 'missing_gets_gel'
  and upper(btrim(r.gets_currency)) = 'GEL'
  and upper(btrim(r.sells_currency)) in ('USD', 'EUR', 'RUB', 'CNY')
  and r.amount is not null
  and r.amount > 0
  and (r.gets_amount is null or r.gets_amount <= 0)
  and private.gel_scale_ok(upper(btrim(r.sells_currency)), r.rate);
