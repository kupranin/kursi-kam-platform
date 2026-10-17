-- Paste this in the Supabase SQL editor after 41_rate_competitiveness.sql,
-- 44_request_abs_gel.sql, and 45_historical_display_class.sql.
-- Do not re-run earlier files.
-- Safe to paste again. It does not change log_request, treasury_quote,
-- treasury_set_rate, treasury_decline, treasury_answer_better, ask_again,
-- or edit_request. It does not change treasury_queue(). It does not
-- drop or reorder request_outcomes. It does not backfill old rows and
-- it does not notify for them.
--
-- From the moment this trigger exists, a new app request
-- (source = app, created_at >= 2026-10-17 00:00 Asia/Tbilisi) gets an
-- ABS GEL from the Kursi board at insert, or later from a usable
-- treasury quote or an admin amount. A missing board rate is not
-- filled from a later fetch. If it cannot be valued at insert, the
-- request is still stored. ABS GEL stays null, status is pending_admin,
-- and one admin inbox row is written. Resolving deletes that row, so
-- a later admin does not see it. KAM submission is not refused.
--
-- It does not replace private.request_kpi_class, private.request_display_class,
-- client_request_brief, or client_request_history. Analytics calls the
-- display class and only changes the ABS GEL sum.
--
-- The inbox is the existing user_notifications table. private.emit is
-- not called, so Make.com is not paged. Treasury is not paged.
-- A manual figure is written only by set_request_abs_gel. The existing
-- audit trigger on requests records that update.

alter table public.requests add column if not exists abs_gel numeric(18,2);
alter table public.requests add column if not exists abs_gel_source text;
alter table public.requests add column if not exists abs_gel_status text;
alter table public.requests add column if not exists abs_gel_rate numeric;
alter table public.requests add column if not exists abs_gel_rate_at timestamptz;
alter table public.requests add column if not exists abs_gel_path text;
alter table public.requests add column if not exists abs_gel_reason text;
alter table public.requests add column if not exists abs_board_rate numeric;
alter table public.requests add column if not exists abs_board_rate_at timestamptz;
alter table public.requests add column if not exists abs_board_path text;
alter table public.requests add column if not exists abs_gel_by uuid references public.profiles (id);
alter table public.requests add column if not exists abs_gel_at timestamptz;

comment on column public.requests.abs_gel is
  'Stored ABS GEL for an app request created after this feature. Null while pending. Never a stand-in zero. Old rows stay null.';
comment on column public.requests.abs_gel_source is
  'received_gel, provisional_board, treasury_quote, or manual_admin.';
comment on column public.requests.abs_gel_status is
  'calculated or pending_admin. Null on rows this feature did not value.';
comment on column public.requests.abs_board_rate is
  'Kursi board GEL per 1 unit of the received currency, frozen at the first successful lookup.';

alter table public.requests drop constraint if exists requests_abs_gel_status_ok;
alter table public.requests add constraint requests_abs_gel_status_ok check (
  (abs_gel_status is null and abs_gel is null and abs_gel_source is null)
  or (abs_gel_status = 'pending_admin' and abs_gel is null and abs_gel_source is null)
  or (
    abs_gel_status = 'calculated'
    and abs_gel > 0
    and abs_gel_source in ('received_gel', 'provisional_board', 'treasury_quote', 'manual_admin')
  )
) not valid;

create index if not exists requests_abs_pending_idx
  on public.requests (requested_at desc)
  where abs_gel_status = 'pending_admin';

-- One missing-ABS notice per request. A later update does not insert another.
create unique index if not exists user_notifications_abs_pending_one
  on public.user_notifications (request_id)
  where event_type = 'abs_gel.pending' and request_id is not null;

-- Latest Kursi board sell in the stored direction. Out-of-band figures
-- are returned and rejected by the caller. Nothing is inverted.
create or replace function private.kursi_board_sell(p_currency text, p_quote text)
returns table (sell numeric, fetched_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select r.sell, r.fetched_at
  from public.market_rates r
  where r.source = 'kursi'
    and r.venue_kind = 'board'
    and r.venue not like '% app'
    and r.currency = p_currency
    and r.quote_currency = p_quote
    and r.sell is not null
    and r.sell > 0
  order by r.fetched_at desc
  limit 1
$$;

-- GEL per 1 unit of p_gets. Direct received/GEL in the lari band wins.
-- Otherwise the first canonical cross whose both legs are already in
-- band and already stored in that direction. EUR/GEL = EUR/USD × USD/GEL.
-- USD/GEL = EUR/GEL ÷ EUR/USD. The same shape covers the other canonical
-- crosses. RUB at 1 or above fails the lari band and is not divided.
create or replace function private.snapshot_received_gel(p_gets text)
returns table (rate numeric, rate_at timestamptz, path text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pair text;
  v_base text;
  v_quote text;
  v_direct numeric;
  v_direct_at timestamptz;
  v_cross numeric;
  v_cross_at timestamptz;
  v_gel numeric;
  v_gel_at timestamptz;
  v_result numeric;
  v_pairs text[] := array['EUR/USD', 'EUR/RUB', 'USD/RUB', 'USD/CNY', 'EUR/CNY'];
begin
  if p_gets is null or p_gets = '' or p_gets = 'GEL' then
    return;
  end if;

  select s.sell, s.fetched_at into v_direct, v_direct_at
  from private.kursi_board_sell(p_gets, 'GEL') s;
  if private.gel_scale_ok(p_gets, v_direct) then
    rate := round(v_direct, 8);
    rate_at := v_direct_at;
    path := 'direct';
    return next;
    return;
  end if;

  foreach v_pair in array v_pairs loop
    v_base := split_part(v_pair, '/', 1);
    v_quote := split_part(v_pair, '/', 2);
    v_cross := null;
    v_cross_at := null;
    v_gel := null;
    v_gel_at := null;
    v_result := null;

    if v_base = p_gets then
      select s.sell, s.fetched_at into v_cross, v_cross_at
      from private.kursi_board_sell(v_base, v_quote) s;
      select s.sell, s.fetched_at into v_gel, v_gel_at
      from private.kursi_board_sell(v_quote, 'GEL') s;
      if private.rate_in_scale(v_pair, v_cross) and private.gel_scale_ok(v_quote, v_gel) then
        v_result := v_cross * v_gel;
        if private.gel_scale_ok(p_gets, v_result) then
          rate := round(v_result, 8);
          rate_at := least(v_cross_at, v_gel_at);
          path := 'cross:' || v_pair || '*' || v_quote || '/GEL';
          return next;
          return;
        end if;
      end if;
    elsif v_quote = p_gets then
      select s.sell, s.fetched_at into v_gel, v_gel_at
      from private.kursi_board_sell(v_base, 'GEL') s;
      select s.sell, s.fetched_at into v_cross, v_cross_at
      from private.kursi_board_sell(v_base, v_quote) s;
      if private.gel_scale_ok(v_base, v_gel) and private.rate_in_scale(v_pair, v_cross) and v_cross > 0 then
        v_result := v_gel / v_cross;
        if private.gel_scale_ok(p_gets, v_result) then
          rate := round(v_result, 8);
          rate_at := least(v_cross_at, v_gel_at);
          path := 'cross:' || v_base || '/GEL/' || v_pair;
          return next;
          return;
        end if;
      end if;
    end if;
  end loop;
end;
$$;

-- Automatic valuation. Does not raise. A miss is pending_admin and a null amount.
-- p_lookup_board is true only on insert. A later update never reads the
-- board again. A null snapshot stays null until a usable quote or an
-- admin amount. It is not filled from a newer fetch.
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

create or replace function private.apply_request_abs_gel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := timestamptz '2026-10-17 00:00:00+04';
  v_lookup boolean := false;
  v_board_rate numeric;
  v_board_at timestamptz;
  v_board_path text;
  v_row record;
begin
  -- Rows already stored, including app rows created earlier today, have
  -- a null status. Leave them alone. Do not notify and do not backfill.
  if tg_op = 'UPDATE' and old.abs_gel_status is null then
    return new;
  end if;
  if new.source is distinct from 'app' then
    return new;
  end if;
  if coalesce(new.created_at, now()) < v_cutoff then
    return new;
  end if;

  -- An admin correction. The board snapshot stays. Other updates cannot
  -- replace a manual figure, including a later quote or a board move.
  if tg_op = 'UPDATE'
     and private.is_admin()
     and new.abs_gel_source = 'manual_admin'
     and new.abs_gel is not null
     and round(new.abs_gel, 2) > 0
     and (
       old.abs_gel_source is distinct from 'manual_admin'
       or new.abs_gel is distinct from old.abs_gel
     )
  then
    new.abs_gel := round(new.abs_gel, 2);
    new.abs_gel_source := 'manual_admin';
    new.abs_gel_status := 'calculated';
    new.abs_gel_path := 'manual';
    new.abs_gel_reason := null;
    new.abs_gel_rate := null;
    new.abs_gel_rate_at := null;
    new.abs_board_rate := old.abs_board_rate;
    new.abs_board_rate_at := old.abs_board_rate_at;
    new.abs_board_path := old.abs_board_path;
    if new.abs_gel_by is null then
      new.abs_gel_by := private.my_profile_id();
    end if;
    if new.abs_gel_at is null then
      new.abs_gel_at := now();
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and old.abs_gel_source = 'manual_admin' then
    new.abs_gel := old.abs_gel;
    new.abs_gel_source := old.abs_gel_source;
    new.abs_gel_status := old.abs_gel_status;
    new.abs_gel_rate := old.abs_gel_rate;
    new.abs_gel_rate_at := old.abs_gel_rate_at;
    new.abs_gel_path := old.abs_gel_path;
    new.abs_gel_reason := old.abs_gel_reason;
    new.abs_board_rate := old.abs_board_rate;
    new.abs_board_rate_at := old.abs_board_rate_at;
    new.abs_board_path := old.abs_board_path;
    new.abs_gel_by := old.abs_gel_by;
    new.abs_gel_at := old.abs_gel_at;
    return new;
  end if;

  v_board_rate := null;
  v_board_at := null;
  v_board_path := null;
  if tg_op = 'INSERT' then
    v_lookup := true;
  elsif old.gets_currency is not distinct from new.gets_currency then
    v_board_rate := old.abs_board_rate;
    v_board_at := old.abs_board_rate_at;
    v_board_path := old.abs_board_path;
  end if;

  -- A valuation error must not refuse the request.
  begin
    select *
      into v_row
    from private.value_abs_gel(
      new.sells_currency,
      new.gets_currency,
      new.amount,
      new.gets_amount,
      new.rate,
      new.quote_status,
      new.quoted_at,
      coalesce(new.requested_at, new.created_at, now()),
      v_board_rate,
      v_board_at,
      v_board_path,
      v_lookup
    );
  exception when others then
    raise warning 'abs gel valuation skipped: %', sqlerrm;
    new.abs_gel := null;
    new.abs_gel_source := null;
    new.abs_gel_status := 'pending_admin';
    new.abs_gel_rate := null;
    new.abs_gel_rate_at := null;
    new.abs_gel_path := null;
    new.abs_gel_reason := 'no_board_rate';
    new.abs_board_rate := v_board_rate;
    new.abs_board_rate_at := v_board_at;
    new.abs_board_path := v_board_path;
    new.abs_gel_by := null;
    new.abs_gel_at := null;
    return new;
  end;

  if v_row.abs_status is null then
    new.abs_gel := null;
    new.abs_gel_source := null;
    new.abs_gel_status := 'pending_admin';
    new.abs_gel_rate := null;
    new.abs_gel_rate_at := null;
    new.abs_gel_path := null;
    new.abs_gel_reason := 'no_board_rate';
    new.abs_board_rate := v_board_rate;
    new.abs_board_rate_at := v_board_at;
    new.abs_board_path := v_board_path;
    new.abs_gel_by := null;
    new.abs_gel_at := null;
    return new;
  end if;

  new.abs_gel := v_row.abs_gel;
  new.abs_gel_source := v_row.abs_source;
  new.abs_gel_status := v_row.abs_status;
  new.abs_gel_rate := v_row.abs_rate;
  new.abs_gel_rate_at := v_row.abs_rate_at;
  new.abs_gel_path := v_row.abs_path;
  new.abs_gel_reason := v_row.abs_reason;
  new.abs_board_rate := v_row.board_rate;
  new.abs_board_rate_at := v_row.board_at;
  new.abs_board_path := v_row.board_path;
  new.abs_gel_by := null;
  new.abs_gel_at := case when v_row.abs_status = 'calculated' then now() else null end;

  if tg_op = 'UPDATE'
     and new.abs_gel is not distinct from old.abs_gel
     and new.abs_gel_source is not distinct from old.abs_gel_source
     and new.abs_gel_status is not distinct from old.abs_gel_status
     and new.abs_gel_rate is not distinct from old.abs_gel_rate
     and new.abs_gel_path is not distinct from old.abs_gel_path
     and new.abs_gel_reason is not distinct from old.abs_gel_reason
     and new.abs_board_rate is not distinct from old.abs_board_rate
     and new.abs_board_path is not distinct from old.abs_board_path
  then
    new.abs_gel_rate_at := old.abs_gel_rate_at;
    new.abs_board_rate_at := old.abs_board_rate_at;
    new.abs_gel_by := old.abs_gel_by;
    new.abs_gel_at := old.abs_gel_at;
  end if;

  return new;
end;
$$;

drop trigger if exists requests_apply_abs_gel on public.requests;
create trigger requests_apply_abs_gel
  before insert or update on public.requests
  for each row execute function private.apply_request_abs_gel();

create or replace function private.notify_abs_gel_pending(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.requests%rowtype;
  v_client text;
  v_kam text;
  v_reason_ka text;
  v_reason_en text;
  v_sell text;
  v_gets text;
  v_body_ka text;
  v_body_en text;
begin
  select * into v_req from public.requests r where r.id = p_id;
  if not found or v_req.abs_gel_status is distinct from 'pending_admin' then
    return;
  end if;

  select coalesce(c.name, v_req.client_id) into v_client
  from public.clients c where c.client_id = v_req.client_id;
  v_client := coalesce(v_client, v_req.client_id);
  select coalesce(p.full_name, 'KAM') into v_kam
  from public.profiles p where p.id = v_req.kam_id;
  v_kam := coalesce(v_kam, 'KAM');
  v_sell := coalesce(to_char(v_req.amount, 'FM999999999990.00'), '—') || ' ' || coalesce(v_req.sells_currency, '');
  v_gets := coalesce(to_char(v_req.gets_amount, 'FM999999999990.00'), '—') || ' ' || coalesce(v_req.gets_currency, '');

  v_reason_ka := case v_req.abs_gel_reason
    when 'missing_gets_gel' then 'მიღებული ლარის თანხა არ არის'
    when 'no_board_rate' then 'დაფაზე ამ ვალუტის ლარის კურსი არ არის'
    when 'cannot_derive' then 'მიღებული თანხა არ არის და ჯვარედინი კურსიდან ვერ გამოითვლება'
    else 'ლარის თანხა ვერ გამოითვალა'
  end;
  v_reason_en := case v_req.abs_gel_reason
    when 'missing_gets_gel' then 'The lari amount received is missing'
    when 'no_board_rate' then 'The board has no lari rate for this currency'
    when 'cannot_derive' then 'The received amount is missing and cannot be derived from a cross'
    else 'The lari amount could not be calculated'
  end;

  v_body_ka := format(
    'მოთხოვნა %s. კლიენტი %s. KAM %s. %s → %s. ყიდის %s. იღებს %s. %s.',
    v_req.id, v_client, v_kam, v_req.sells_currency, v_req.gets_currency, v_sell, v_gets, v_reason_ka
  );
  v_body_en := format(
    'Request %s. Client %s. KAM %s. %s → %s. Sells %s. Gets %s. %s.',
    v_req.id, v_client, v_kam, v_req.sells_currency, v_req.gets_currency, v_sell, v_gets, v_reason_en
  );

  insert into public.user_notifications (
    audience, profile_id, event_type, request_id, title_ka, title_en, body_ka, body_en
  )
  select
    'admin', null, 'abs_gel.pending', p_id,
    format('ABS GEL ელოდება ადმინს · %s', p_id),
    format('ABS GEL is waiting for an admin · %s', p_id),
    v_body_ka, v_body_en
  where not exists (
    select 1
    from public.user_notifications n
    where n.request_id = p_id
      and n.event_type = 'abs_gel.pending'
  );
exception
  when unique_violation then
    return;
end;
$$;

-- Remove the inbox row. Read marks cannot hide it from an admin created
-- later. The bell has no closed status. Cascade removes any read rows.
-- One abs_gel.pending row per request can be inserted again if it is
-- pending once more. private.emit is not called.
create or replace function private.resolve_abs_gel_pending(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.user_notifications n
  where n.request_id = p_id
    and n.event_type = 'abs_gel.pending';
end;
$$;

create or replace function private.notice_request_abs_gel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := timestamptz '2026-10-17 00:00:00+04';
begin
  if new.source is distinct from 'app' or coalesce(new.created_at, now()) < v_cutoff then
    return null;
  end if;
  if new.abs_gel_status = 'pending_admin' then
    begin
      perform private.notify_abs_gel_pending(new.id);
    exception when others then
      raise warning 'abs gel notice skipped: %', sqlerrm;
    end;
  elsif tg_op = 'UPDATE'
        and new.abs_gel_status = 'calculated'
        and old.abs_gel_status is distinct from 'calculated' then
    begin
      perform private.resolve_abs_gel_pending(new.id);
    exception when others then
      raise warning 'abs gel resolve skipped: %', sqlerrm;
    end;
  end if;
  return null;
end;
$$;

drop trigger if exists requests_notice_abs_gel on public.requests;
create trigger requests_notice_abs_gel
  after insert or update on public.requests
  for each row execute function private.notice_request_abs_gel();

revoke all on function private.kursi_board_sell(text, text) from public, anon, authenticated;
revoke all on function private.snapshot_received_gel(text) from public, anon, authenticated;
revoke all on function private.value_abs_gel(text, text, numeric, numeric, numeric, text, timestamptz, timestamptz, numeric, timestamptz, text, boolean) from public, anon, authenticated;
revoke all on function private.apply_request_abs_gel() from public, anon, authenticated;
revoke all on function private.notify_abs_gel_pending(bigint) from public, anon, authenticated;
revoke all on function private.resolve_abs_gel_pending(bigint) from public, anon, authenticated;
revoke all on function private.notice_request_abs_gel() from public, anon, authenticated;

-- Admin queue. Only rows this feature marked pending. No historical scan.
create or replace function public.pending_abs_gel_queue()
returns table (
  request_id bigint,
  requested_at timestamptz,
  client_id text,
  client_name text,
  kam_name text,
  sells_currency text,
  gets_currency text,
  amount numeric,
  gets_amount numeric,
  reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.my_profile_id() is null or not private.is_admin() then
    raise exception 'მხოლოდ ადმინს შეუძლია ამ სიის ნახვა' using errcode = '42501';
  end if;
  return query
  select
    r.id,
    r.requested_at,
    r.client_id,
    c.name,
    p.full_name,
    r.sells_currency,
    r.gets_currency,
    r.amount,
    r.gets_amount,
    r.abs_gel_reason
  from public.requests r
  left join public.clients c on c.client_id = r.client_id
  left join public.profiles p on p.id = r.kam_id
  where r.abs_gel_status = 'pending_admin'
  order by r.requested_at desc, r.id desc;
end;
$$;

create or replace function public.set_request_abs_gel(p_request_id bigint, p_amount numeric)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_req public.requests%rowtype;
  v_abs numeric;
begin
  if private.my_profile_id() is null or not private.is_admin() then
    raise exception 'მხოლოდ ადმინს შეუძლია ლარის ჩაწერა' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 or round(p_amount, 2) <= 0 then
    raise exception 'ჩაწერეთ დადებითი ლარი' using errcode = '22023';
  end if;
  v_abs := round(p_amount, 2);

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  if v_req.abs_gel_status is distinct from 'pending_admin'
     and v_req.abs_gel_source is distinct from 'manual_admin' then
    raise exception 'ამ მოთხოვნაზე ლარი უკვე დათვლილია' using errcode = '22023';
  end if;

  update public.requests r
     set abs_gel = v_abs,
         abs_gel_source = 'manual_admin',
         abs_gel_status = 'calculated',
         abs_gel_path = 'manual',
         abs_gel_reason = null,
         abs_gel_rate = null,
         abs_gel_rate_at = null,
         abs_gel_by = private.my_profile_id(),
         abs_gel_at = now()
   where r.id = p_request_id;
end;
$$;

comment on function public.set_request_abs_gel(bigint, numeric) is
  'Admin entry or correction of ABS GEL. Does not replace a board or treasury figure. The requests audit trigger records the change.';

revoke all on function public.pending_abs_gel_queue() from public, anon;
grant execute on function public.pending_abs_gel_queue() to authenticated;
revoke all on function public.set_request_abs_gel(bigint, numeric) from public, anon;
grant execute on function public.set_request_abs_gel(bigint, numeric) to authenticated;

-- Analytics prefers the stored figure. Pending is counted on its own
-- and is not added as zero. Rows this feature did not value still use
-- private.request_abs_valuation, including a missing historical figure.
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
      private.request_display_class(
        r.source,
        r.import_key,
        r.legacy_status,
        r.rate_written_at,
        r.payment_confirmed_at,
        r.marked_lost_at,
        r.loss_reason,
        r.client_reply,
        r.quote_status
      ) as klass,
      case
        when r.abs_gel_status = 'calculated' then r.abs_gel
        when r.abs_gel_status = 'pending_admin' then null
        else v.request_abs_gel
      end as request_abs_gel,
      case
        when r.abs_gel_status in ('calculated', 'pending_admin') then r.abs_gel_status
        else v.valuation_status
      end as valuation_status,
      case
        when private.request_display_class(
          r.source,
          r.import_key,
          r.legacy_status,
          r.rate_written_at,
          r.payment_confirmed_at,
          r.marked_lost_at,
          r.loss_reason,
          r.client_reply,
          r.quote_status
        ) = 'lost'
        then nullif(concat_ws(
          '. ',
          private.request_loss_text(
            r.loss_reason, lr.label_ka, r.legacy_loss_reason, r.loss_reason_note,
            r.client_decline_reason, r.decline_reason, r.legacy_status, r.import_key
          ),
          case
            when r.source = 'import' or coalesce(r.import_key, '') like 'agreement:%'
            then nullif(btrim(coalesce(r.legacy_status, '')), '')
          end
        ), '')
      end as reason
    from public.requests r
    left join public.profiles p on p.id = r.kam_id
    left join public.loss_reasons lr on lr.code = r.loss_reason
    left join lateral private.request_abs_valuation(
      r.sells_currency, r.gets_currency, r.gets_amount, r.rate, r.quote_status, r.quoted_at, r.requested_at
    ) v on r.abs_gel_status is null
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
      count(*) filter (
        where b.valuation_status is distinct from 'calculated'
          and b.valuation_status is distinct from 'pending_admin'
      )::bigint as abs_unavailable,
      count(*) filter (where b.valuation_status = 'pending_admin')::bigint as abs_pending,
      sum(b.request_abs_gel) filter (where b.klass = 'won' and b.valuation_status = 'calculated') as won_abs_gel,
      count(*) filter (
        where b.klass = 'won'
          and b.valuation_status is distinct from 'calculated'
          and b.valuation_status is distinct from 'pending_admin'
      )::bigint as won_abs_unavailable,
      count(*) filter (where b.klass = 'won' and b.valuation_status = 'pending_admin')::bigint as won_abs_pending,
      sum(b.request_abs_gel) filter (where b.klass = 'lost' and b.valuation_status = 'calculated') as lost_abs_gel,
      count(*) filter (
        where b.klass = 'lost'
          and b.valuation_status is distinct from 'calculated'
          and b.valuation_status is distinct from 'pending_admin'
      )::bigint as lost_abs_unavailable,
      count(*) filter (where b.klass = 'lost' and b.valuation_status = 'pending_admin')::bigint as lost_abs_pending
    from base b
    group by b.kam_id
  ),
  reasons as (
    select
      coalesce(b.reason, '') as label,
      count(*)::bigint as n,
      sum(b.request_abs_gel) filter (where b.valuation_status = 'calculated') as lost_abs_gel,
      count(*) filter (
        where b.valuation_status is distinct from 'calculated'
          and b.valuation_status is distinct from 'pending_admin'
      )::bigint as abs_unavailable,
      count(*) filter (where b.valuation_status = 'pending_admin')::bigint as abs_pending
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
      coalesce(sum(k.abs_pending), 0)::bigint as abs_pending,
      sum(k.won_abs_gel) as won_abs_gel,
      coalesce(sum(k.won_abs_unavailable), 0)::bigint as won_abs_unavailable,
      coalesce(sum(k.won_abs_pending), 0)::bigint as won_abs_pending,
      sum(k.lost_abs_gel) as lost_abs_gel,
      coalesce(sum(k.lost_abs_unavailable), 0)::bigint as lost_abs_unavailable,
      coalesce(sum(k.lost_abs_pending), 0)::bigint as lost_abs_pending
    from kam_rows k
  )
  select jsonb_build_object(
    'total', t.total,
    'won', t.won,
    'lost', t.lost,
    'open', t.open_n,
    'abs_gel', t.abs_gel,
    'abs_unavailable', t.abs_unavailable,
    'abs_pending', t.abs_pending,
    'won_abs_gel', t.won_abs_gel,
    'won_abs_unavailable', t.won_abs_unavailable,
    'won_abs_pending', t.won_abs_pending,
    'lost_abs_gel', t.lost_abs_gel,
    'lost_abs_unavailable', t.lost_abs_unavailable,
    'lost_abs_pending', t.lost_abs_pending,
    'reasons', coalesce((
      select jsonb_agg(jsonb_build_object(
        'label', r.label,
        'count', r.n,
        'lost_abs_gel', r.lost_abs_gel,
        'abs_unavailable', r.abs_unavailable,
        'abs_pending', r.abs_pending
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
        'abs_pending', k.abs_pending,
        'won_abs_gel', k.won_abs_gel,
        'won_abs_unavailable', k.won_abs_unavailable,
        'won_abs_pending', k.won_abs_pending,
        'lost_abs_gel', k.lost_abs_gel,
        'lost_abs_unavailable', k.lost_abs_unavailable,
        'lost_abs_pending', k.lost_abs_pending
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
  'Request-status KPIs and ABS GEL. Class is private.request_display_class from the historical display setup: import and agreement rows are won or lost from legacy_status, and an app row is won only when rate_written_at is set. This function does not replace that classifier. A stored figure is used when this feature wrote one. pending_admin is counted separately and is not summed as zero. Older rows still use the read-time valuation. Null dates are all time. p_to is exclusive.';

revoke all on function public.analytics_request_kpis(date, date, uuid) from public, anon;
grant execute on function public.analytics_request_kpis(date, date, uuid) to authenticated;

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
    case
      when r.abs_gel_status = 'calculated' then r.abs_gel
      when r.abs_gel_status = 'pending_admin' then null
      else v.request_abs_gel
    end,
    case
      when r.abs_gel_status is not null then r.gets_currency
      else v.valuation_currency
    end,
    case
      when r.abs_gel_status = 'calculated' then r.abs_gel_rate
      else v.valuation_rate
    end,
    case
      when r.abs_gel_status = 'calculated' then r.abs_gel_rate_at
      else v.valuation_timestamp
    end,
    case
      when r.abs_gel_status is not null then r.abs_gel_source
      else v.valuation_source
    end,
    case
      when r.abs_gel_status is not null then r.abs_gel_status
      else v.valuation_status
    end
  from public.requests r
  left join lateral private.request_abs_valuation(
    r.sells_currency, r.gets_currency, r.gets_amount, r.rate, r.quote_status, r.quoted_at, r.requested_at
  ) v on r.abs_gel_status is null
  where r.id = any (p_ids[1:200]);
end;
$$;

comment on function public.request_abs_valuations(bigint[]) is
  'ABS GEL for up to 200 request ids. Uses the stored figure when this feature wrote one. pending_admin returns a null amount and that status, not zero. Older ids still use the read-time valuation.';

revoke all on function public.request_abs_valuations(bigint[]) from public, anon;
grant execute on function public.request_abs_valuations(bigint[]) to authenticated;
