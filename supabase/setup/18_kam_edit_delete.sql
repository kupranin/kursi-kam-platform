-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 16_client_history.sql. Do not re-run 1_platform.sql.
-- If you paste an older file that recreates requests_admin_update or
-- requests_admin_delete, paste this file once more afterwards.
-- If you already pasted 21_delete_and_loss_approval.sql, paste that file
-- once more after this one. This file does not delete existing requests.
--
-- A KAM can edit and delete only a request they logged (kam_id).
-- An admin (private.is_admin(), the real role) can edit and delete any request.
-- Treasury can change or clear the rate treasury wrote (requests.rate),
-- and clearing it also clears rate_written_at. Treasury cannot delete the
-- request and cannot change the client's fields.
-- A manager or an analyst cannot edit or delete a request, and cannot change a rate.
-- View-as is not a database role. private.is_admin() still sees an admin.
--
-- Edit covers the fields on the request form: client id, client name,
-- sells currency, sell amount, gets currency, gets amount, banks, note,
-- and the rate the client asked for. It does not change the treasury rate,
-- who quoted, when the rate was written, or the quote status.
-- The client row is never deleted. A new id is created only when that
-- client is not on file yet.
-- Delete removes that request and the quote rows under it. Notifications
-- that point at it are unlinked. The client stays.
-- Old GBP rows still load. A currency that is already stored can stay.
-- A currency that is changed must be GEL, USD, EUR, RUB, or CNY.

-- ---------------------------------------------------------------------
-- Who may update or delete a row. Column limits are in the trigger below,
-- because one signed-in role (authenticated) cannot be granted different
-- columns for a KAM and for treasury.
-- ---------------------------------------------------------------------
drop policy if exists requests_admin_update on public.requests;
drop policy if exists requests_admin_delete on public.requests;
drop policy if exists requests_update on public.requests;
drop policy if exists requests_delete on public.requests;

create policy requests_update on public.requests
  for update to authenticated
  using (
    (select private.is_admin())
    or (
      (select private.my_role()) = 'kam'
      and kam_id = (select private.my_profile_id())
    )
    or (select private.my_role()) = 'treasury'
  )
  with check (
    (select private.is_admin())
    or (
      (select private.my_role()) = 'kam'
      and kam_id = (select private.my_profile_id())
    )
    or (select private.my_role()) = 'treasury'
  );

create policy requests_delete on public.requests
  for delete to authenticated
  using (
    (select private.is_admin())
    or (
      (select private.my_role()) = 'kam'
      and kam_id = (select private.my_profile_id())
    )
  );

-- Direct updates from the app role are column-checked here.
-- Functions in this file are security definer, so they run as the owner
-- and this guard lets them through. Those functions check the role themselves.
create or replace function private.guard_request_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user is distinct from 'authenticated' then
    return new;
  end if;

  if private.is_admin() then
    return new;
  end if;

  if private.my_role() = 'kam' then
    if old.kam_id is distinct from private.my_profile_id()
       or new.kam_id is distinct from old.kam_id then
      raise exception 'This request belongs to another KAM' using errcode = '42501';
    end if;
    if new.rate is distinct from old.rate
       or new.quoted_by is distinct from old.quoted_by
       or new.quoted_at is distinct from old.quoted_at
       or new.quote_status is distinct from old.quote_status
       or new.rate_valid_until is distinct from old.rate_valid_until
       or new.decline_reason is distinct from old.decline_reason
       or new.rate_written_at is distinct from old.rate_written_at
       or new.rate_written_by is distinct from old.rate_written_by
       or new.gel_amount is distinct from old.gel_amount
       or new.approved_rate is distinct from old.approved_rate
       or new.wanted_rate is distinct from old.wanted_rate
       or new.given_rate is distinct from old.given_rate
       or new.client_reply is distinct from old.client_reply
       or new.better_decision is distinct from old.better_decision
       or new.client_decline_reason is distinct from old.client_decline_reason
       or new.client_replied_at is distinct from old.client_replied_at
       or new.better_decided_at is distinct from old.better_decided_at
       or new.better_decided_by is distinct from old.better_decided_by
       or new.loss_reason is distinct from old.loss_reason
       or new.loss_reason_at is distinct from old.loss_reason_at
       or new.loss_reason_note is distinct from old.loss_reason_note
       or new.source is distinct from old.source
       or new.import_key is distinct from old.import_key
       or new.legacy_status is distinct from old.legacy_status
       or new.legacy_loss_reason is distinct from old.legacy_loss_reason
       or new.requested_at is distinct from old.requested_at
       or new.request_date is distinct from old.request_date
       or new.asked_at is distinct from old.asked_at
       or new.created_at is distinct from old.created_at
    then
      raise exception 'You can change the request you logged, not the treasury rate' using errcode = '42501';
    end if;
    return new;
  end if;

  if private.my_role() = 'treasury' then
    if new.kam_id is distinct from old.kam_id
       or new.client_id is distinct from old.client_id
       or new.sells_currency is distinct from old.sells_currency
       or new.gets_currency is distinct from old.gets_currency
       or new.amount is distinct from old.amount
       or new.gets_amount is distinct from old.gets_amount
       or new.client_rate is distinct from old.client_rate
       or new.note is distinct from old.note
       or new.bank is distinct from old.bank
       or new.banks is distinct from old.banks
       or new.quote_status is distinct from old.quote_status
       or new.rate_valid_until is distinct from old.rate_valid_until
       or new.quoted_by is distinct from old.quoted_by
       or new.quoted_at is distinct from old.quoted_at
       or new.decline_reason is distinct from old.decline_reason
       or new.gel_amount is distinct from old.gel_amount
       or new.approved_rate is distinct from old.approved_rate
       or new.wanted_rate is distinct from old.wanted_rate
       or new.given_rate is distinct from old.given_rate
       or new.client_reply is distinct from old.client_reply
       or new.better_decision is distinct from old.better_decision
       or new.client_decline_reason is distinct from old.client_decline_reason
       or new.client_replied_at is distinct from old.client_replied_at
       or new.better_decided_at is distinct from old.better_decided_at
       or new.better_decided_by is distinct from old.better_decided_by
       or new.loss_reason is distinct from old.loss_reason
       or new.loss_reason_at is distinct from old.loss_reason_at
       or new.loss_reason_note is distinct from old.loss_reason_note
       or new.source is distinct from old.source
       or new.import_key is distinct from old.import_key
       or new.legacy_status is distinct from old.legacy_status
       or new.legacy_loss_reason is distinct from old.legacy_loss_reason
       or new.requested_at is distinct from old.requested_at
       or new.request_date is distinct from old.request_date
       or new.asked_at is distinct from old.asked_at
       or new.created_at is distinct from old.created_at
    then
      raise exception 'Treasury can change the rate only' using errcode = '42501';
    end if;
    return new;
  end if;

  raise exception 'Your account cannot change requests' using errcode = '42501';
end;
$$;

revoke all on function private.guard_request_update() from public, anon, authenticated;

drop trigger if exists requests_guard_update on public.requests;
create trigger requests_guard_update
  before update on public.requests
  for each row execute function private.guard_request_update();

-- "Asked again" is only when the KAM actually asks again (asked_at moves).
-- Clearing a treasury rate sets the request back to asking without that.
create or replace function private.inbox_on_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client text;
  v_kam    text;
  v_pair   text;
  v_rate   text;
begin
  if new.source is distinct from 'app' then
    return null;
  end if;

  select coalesce(c.name, new.client_id) into v_client
  from public.clients c
  where c.client_id = new.client_id;
  v_client := coalesce(v_client, new.client_id);

  select p.full_name into v_kam from public.profiles p where p.id = new.kam_id;
  v_kam := coalesce(v_kam, 'KAM');
  v_pair := coalesce(new.sells_currency, '') || ' → ' || coalesce(new.gets_currency, '');
  v_rate := coalesce(to_char(new.rate, 'FM9990.0000'), '');

  if tg_op = 'INSERT' then
    perform private.inbox_add(
      'treasury', null, 'request.new', new.id,
      'ახალი მოთხოვნა', 'New request',
      v_kam || ': ' || v_client || ', ' || v_pair,
      v_kam || ': ' || v_client || ', ' || v_pair
    );
    return null;
  end if;

  if old.quote_status is distinct from 'asking'
     and new.quote_status = 'asking'
     and old.asked_at is distinct from new.asked_at then
    perform private.inbox_add(
      'treasury', null, 'request.new', new.id,
      'ახალი მოთხოვნა', 'New request',
      v_kam || ' ხელახლა იკითხა: ' || v_client || ', ' || v_pair,
      v_kam || ' asked again: ' || v_client || ', ' || v_pair
    );
  end if;

  if old.quote_status = 'asking' and new.quote_status = 'quoted' then
    perform private.inbox_add(
      'kam', new.kam_id, 'rate.quoted', new.id,
      'სახაზინომ კურსი გასცა', 'Treasury quoted',
      v_client || ': ' || v_rate,
      v_client || ': ' || v_rate
    );
  end if;

  if old.quote_status is distinct from 'declined' and new.quote_status = 'declined' then
    perform private.inbox_add(
      'kam', new.kam_id, 'treasury.declined', new.id,
      'სახაზინომ უარი თქვა', 'Treasury declined',
      v_client || ': ' || coalesce(new.decline_reason, ''),
      v_client || ': ' || coalesce(new.decline_reason, '')
    );
  end if;

  if old.client_reply is distinct from 'approved' and new.client_reply = 'approved' then
    perform private.inbox_add(
      'treasury', null, 'client.approved', new.id,
      'კლიენტმა დაამტკიცა', 'Client approved',
      v_kam || ': ' || v_client || ' ' || coalesce(to_char(new.approved_rate, 'FM9990.0000'), ''),
      v_kam || ': ' || v_client || ' ' || coalesce(to_char(new.approved_rate, 'FM9990.0000'), '')
    );
    perform private.inbox_add(
      'manager', null, 'client.approved', new.id,
      'კლიენტმა დაამტკიცა', 'Client approved',
      v_kam || ': ' || v_client || ' ' || coalesce(to_char(new.approved_rate, 'FM9990.0000'), ''),
      v_kam || ': ' || v_client || ' ' || coalesce(to_char(new.approved_rate, 'FM9990.0000'), '')
    );
  end if;

  if new.client_reply = 'better'
     and new.better_decision is null
     and (old.client_reply is distinct from 'better' or old.better_decision is not null) then
    perform private.inbox_add(
      'treasury', null, 'client.better', new.id,
      'კლიენტს უკეთესი კურსი სურს', 'Client wants a better rate',
      v_kam || ': ' || v_client || ' ' || coalesce(to_char(new.wanted_rate, 'FM9990.0000'), ''),
      v_kam || ': ' || v_client || ' ' || coalesce(to_char(new.wanted_rate, 'FM9990.0000'), '')
    );
  end if;

  if old.client_reply is distinct from 'declined' and new.client_reply = 'declined' then
    perform private.inbox_add(
      'treasury', null, 'client.declined', new.id,
      'კლიენტმა უარი თქვა', 'Client declined',
      v_client || ': ' || coalesce(new.client_decline_reason, ''),
      v_client || ': ' || coalesce(new.client_decline_reason, '')
    );
  end if;

  if tg_op = 'UPDATE'
     and old.rate_written_at is null
     and new.rate_written_at is not null then
    perform private.inbox_add(
      'kam', new.kam_id, 'rate.written', new.id,
      'კურსი გაწერილია', 'Rate is written',
      v_client || ': ' || coalesce(to_char(new.approved_rate, 'FM9990.0000'), v_rate),
      v_client || ': ' || coalesce(to_char(new.approved_rate, 'FM9990.0000'), v_rate)
    );
  end if;

  if old.client_reply = 'better'
     and old.better_decision is null
     and new.client_reply is null
     and new.quote_status = 'quoted' then
    if old.wanted_rate is not null and new.rate is not distinct from old.wanted_rate then
      perform private.inbox_add(
        'kam', new.kam_id, 'rate.quoted', new.id,
        'სახაზინომ კურსი გასცა', 'Treasury quoted',
        v_client || ': ' || v_rate,
        v_client || ': ' || v_rate
      );
    else
      perform private.inbox_add(
        'kam', new.kam_id, 'treasury.corrected', new.id,
        'სახაზინომ კურსი გაასწორა', 'Treasury corrected the rate',
        v_client || ': ' || v_rate,
        v_client || ': ' || v_rate
      );
    end if;
  end if;

  return null;
exception when others then
  raise warning 'inbox skipped: %', sqlerrm;
  return null;
end;
$$;

revoke all on function private.inbox_on_request() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Edit the fields a KAM fills in. PostgREST matches these argument
-- names exactly: p_amount, p_bank, p_client_id, p_client_name,
-- p_client_rate, p_gets_amount, p_gets_currency, p_note, p_request_id,
-- p_sells_currency. p_bank is text[] (TBC, BOG, Liberty).
-- A KAM may edit only their own request. An admin may edit any request.
-- Anyone else may not. Quoted rate, who quoted, and rate written stay.
-- Drop every older overload first so a different signature cannot linger.
-- ---------------------------------------------------------------------
do $drop_edit_request$
declare
  r record;
begin
  for r in
    select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'edit_request'
  loop
    execute format('drop function if exists %I.%I(%s)', r.nspname, r.proname, r.args);
  end loop;
end
$drop_edit_request$;

create or replace function public.edit_request(
  p_request_id     bigint,
  p_client_id      text,
  p_sells_currency text,
  p_gets_currency  text,
  p_amount         numeric,
  p_note           text default null,
  p_client_name    text default null,
  p_gets_amount    numeric default null,
  p_client_rate    numeric default null,
  p_bank           text[] default null
)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me       uuid := private.my_profile_id();
  v_req      public.requests%rowtype;
  v_id       text := private.normalize_client_id(p_client_id);
  v_sells    text := upper(trim(coalesce(p_sells_currency, '')));
  v_gets     text := upper(trim(coalesce(p_gets_currency, '')));
  v_sell_amt numeric := case when p_amount is null then null else round(p_amount, 2) end;
  v_gets_amt numeric := case when p_gets_amount is null then null else round(p_gets_amount, 2) end;
  v_name     text := nullif(trim(p_client_name), '');
  v_banks    text[];
  v_saved    text[];
  v_new      boolean;
begin
  if v_me is null then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if private.my_role() is distinct from 'kam' and not private.is_admin() then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;
  if v_req.kam_id is distinct from v_me and not private.is_admin() then
    raise exception 'This request belongs to another KAM' using errcode = '42501';
  end if;

  if v_id !~ '^([0-9]{9}|[0-9]{11})$' then
    raise exception 'Check the ID: companies have 9 digits, people 11' using errcode = '22023';
  end if;
  if v_sells !~ '^[A-Z]{3}$' or v_gets !~ '^[A-Z]{3}$' or v_sells = v_gets then
    raise exception 'Choose two different currencies' using errcode = '22023';
  end if;
  if (v_sells is distinct from v_req.sells_currency and v_sells not in ('GEL', 'USD', 'EUR', 'RUB', 'CNY'))
     or (v_gets is distinct from v_req.gets_currency and v_gets not in ('GEL', 'USD', 'EUR', 'RUB', 'CNY')) then
    raise exception 'აირჩიეთ GEL, USD, EUR, RUB ან CNY' using errcode = '22023';
  end if;
  if p_amount is not null and coalesce(v_sell_amt, 0) <= 0 then
    raise exception 'Enter a valid amount, or leave that side blank' using errcode = '22023';
  end if;
  if p_gets_amount is not null and coalesce(v_gets_amt, 0) <= 0 then
    raise exception 'Enter a valid amount, or leave that side blank' using errcode = '22023';
  end if;
  if coalesce(v_sell_amt, 0) <= 0 and coalesce(v_gets_amt, 0) <= 0 then
    raise exception 'Enter an amount on one side' using errcode = '22023';
  end if;
  if p_client_rate is not null and p_client_rate <= 0 then
    raise exception 'Enter the rate the client is asking, or leave it blank' using errcode = '22023';
  end if;
  if length(coalesce(trim(p_note), '')) > 500 then
    raise exception 'The comment is too long' using errcode = '22023';
  end if;
  if length(coalesce(v_name, '')) > 200 then
    raise exception 'სახელი 200 სიმბოლოზე გრძელია' using errcode = '22023';
  end if;

  if p_bank is null or cardinality(p_bank) < 1 then
    raise exception 'აირჩიეთ ერთი ბანკი მაინც: TBC, BOG ან Liberty' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(p_bank) as u(x)
    where btrim(coalesce(x, '')) not in ('TBC', 'BOG', 'Liberty')
  ) then
    raise exception 'აირჩიეთ ბანკი: TBC, BOG ან Liberty' using errcode = '22023';
  end if;
  select coalesce(array_agg(x order by array_position(array['TBC', 'BOG', 'Liberty']::text[], x)), '{}'::text[])
    into v_banks
  from (
    select distinct btrim(x) as x
    from unnest(p_bank) as u(x)
  ) s
  where x in ('TBC', 'BOG', 'Liberty');
  if cardinality(v_banks) < 1 or cardinality(v_banks) > 3 then
    raise exception 'აირჩიეთ ბანკი: TBC, BOG ან Liberty' using errcode = '22023';
  end if;

  if not exists (select 1 from public.clients c where c.client_id = v_id and c.name is not null)
     and length(coalesce(v_name, '')) < 2 then
    raise exception 'New client: enter the client''s name' using errcode = '22023';
  end if;

  insert into public.clients (client_id, name, created_by)
  values (v_id, v_name, v_me)
  on conflict (client_id) do nothing;
  v_new := found;

  if not v_new and length(coalesce(v_name, '')) >= 2 then
    update public.clients c set name = v_name where c.client_id = v_id;
  end if;

  select c.banks into v_saved from public.clients c where c.client_id = v_id;
  update public.clients c
  set banks = (
    select coalesce(array_agg(x order by array_position(array['TBC', 'BOG', 'Liberty']::text[], x)), '{}'::text[])
    from (
      select distinct unnest(coalesce(v_saved, '{}'::text[]) || v_banks) as x
    ) u
    where x in ('TBC', 'BOG', 'Liberty')
  )
  where c.client_id = v_id;

  if v_new then
    insert into private.backfill_queue (client_id) values (v_id)
    on conflict (client_id) do update set done_at = null, queued_at = now();
  end if;

  -- KAM fields only. Leave the quoted rate (rate, quoted_by, quoted_at),
  -- rate written (rate_written_at, rate_written_by), and quote status.
  update public.requests r
     set client_id = v_id,
         sells_currency = v_sells,
         gets_currency = v_gets,
         amount = v_sell_amt,
         gets_amount = v_gets_amt,
         client_rate = case when p_client_rate is null then null else round(p_client_rate, 6) end,
         note = nullif(trim(p_note), ''),
         bank = array_to_string(v_banks, ', '),
         banks = v_banks
   where r.id = p_request_id;
end;
$$;

revoke all on function public.edit_request(bigint, text, text, text, numeric, text, text, numeric, numeric, text[]) from public, anon;
grant execute on function public.edit_request(bigint, text, text, text, numeric, text, text, numeric, numeric, text[]) to authenticated;

-- ---------------------------------------------------------------------
-- Delete the request row. The KAM who logged it, or an admin.
-- Quotes under it go with it. The client row stays.
-- ---------------------------------------------------------------------
create or replace function public.delete_request(p_request_id bigint)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me  uuid := private.my_profile_id();
  v_req public.requests%rowtype;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;
  select * into v_req from public.requests r where r.id = p_request_id;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_req.kam_id is distinct from v_me and not private.is_admin() then
    raise exception 'This request belongs to another KAM' using errcode = '42501';
  end if;

  delete from public.quotes q where q.request_id = p_request_id;
  update public.user_notifications n set request_id = null where n.request_id = p_request_id;
  update public.notification_events e set request_id = null where e.request_id = p_request_id;
  delete from public.requests r where r.id = p_request_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Treasury changes the rate it wrote, or clears it.
-- p_rate null removes the rate and, when one was written, rate_written_at.
-- It does not delete the request and does not change the client's fields.
-- ---------------------------------------------------------------------
create or replace function public.treasury_set_rate(p_request_id bigint, p_rate numeric)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me   uuid := private.my_profile_id();
  v_req  public.requests%rowtype;
  v_rate numeric;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'მხოლოდ სახაზინოს შეუძლია კურსის შეცვლა' using errcode = '42501';
  end if;

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;

  if p_rate is null then
    if v_req.rate is null and v_req.rate_written_at is null then
      raise exception 'ამ მოთხოვნაზე კურსი არ არის' using errcode = '22023';
    end if;
    update public.requests r
       set rate = null,
           rate_written_at = null,
           rate_written_by = null,
           rate_valid_until = null,
           quote_status = case
             when r.source = 'app' and r.quote_status = 'quoted' then 'asking'
             else r.quote_status
           end
     where r.id = p_request_id;
    return;
  end if;

  if p_rate <= 0 then
    raise exception 'ჩაწერეთ კურსი' using errcode = '22023';
  end if;
  if v_req.rate is null and v_req.rate_written_at is null and v_req.quote_status is distinct from 'quoted' then
    raise exception 'ჯერ კურსი გაგზავნეთ ჩვეულებრივი ველიდან' using errcode = '22023';
  end if;

  v_rate := round(p_rate, 6);
  update public.requests r
     set rate = v_rate
   where r.id = p_request_id;

  update public.quotes q
     set rate = v_rate
   where q.id = (
     select q2.id
     from public.quotes q2
     where q2.request_id = p_request_id
       and q2.action = 'quoted'
     order by q2.created_at desc
     limit 1
   );
end;
$$;

revoke all on function public.treasury_set_rate(bigint, numeric) from public, anon;
grant execute on function public.treasury_set_rate(bigint, numeric) to authenticated;
