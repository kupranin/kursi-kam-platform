-- Paste this in the Supabase SQL editor when you want the change.
-- Copy it from disk. Paste it after 42_client_special_rates.sql.
-- Do not re-run 1_platform.sql.
-- Safe to paste again. It does not drop tables or functions.
-- It does not change log_request argument names.
-- It does not change request_outcomes, analyst_deals, or success/loss math.
-- It does not widen can_see_all. A KAM is not added to analyst_deals.
-- It does not reclassify old approvals. The new column defaults to false,
-- which means "already sent to the treasury write queue" (today's behavior).
--
-- Two choices after the client accepts a rate:
--   kam_client_reply (unchanged) saves the approval and leaves the flag false,
--   so the row stays on the treasury write queue.
--   kam_defer_rate_write saves the same approval and sets the flag true,
--   so treasury's write queue and its approval inbox do not see it.
--   kam_release_rate_write clears the flag once. The inbox then matches
--   today's approval notice. A second release does nothing.
-- A written rate (rate_written_at) is unchanged. This is not payment success.
-- Quote expiry is still enforced when the approval is saved. It is not
-- checked again on release, because the client already accepted.
-- An explicit loss or a payment mark cannot be released onto the write queue.
-- Treasury cannot mark a held row written until the KAM releases it.

alter table public.requests
  add column if not exists rate_write_deferred boolean not null default false;

comment on column public.requests.rate_write_deferred is
  'True only when the KAM saved a client approval and has not sent it to the treasury write queue yet. False is the default, including every approval saved before this column existed.';

-- ---------------------------------------------------------------------
-- Hold the approval off the write queue. Same checks as an approval in
-- kam_client_reply. Does not notify treasury or managers.
-- ---------------------------------------------------------------------
create or replace function public.kam_defer_rate_write(
  p_request_id bigint,
  p_rate       numeric
)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me   uuid := private.my_profile_id();
  v_req  public.requests%rowtype;
  v_rate numeric;
  v_id   bigint;
begin
  if v_me is null or not private.can_write() then
    raise exception 'თქვენს ანგარიშს ამ მოთხოვნის შეცვლა არ შეუძლია' using errcode = '42501';
  end if;

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  if v_req.kam_id <> v_me then
    raise exception 'ეს მოთხოვნა სხვა კამ-ს ეკუთვნის' using errcode = '42501';
  end if;
  if v_req.source <> 'app' or v_req.quote_status <> 'quoted' then
    raise exception 'ხაზინამ ჯერ კურსი არ გასცა' using errcode = '22023';
  end if;
  if v_req.client_reply is not null then
    raise exception 'ამ მოთხოვნაზე პასუხი უკვე ჩაწერილია' using errcode = '22023';
  end if;
  if v_req.rate_valid_until is null or v_req.rate_valid_until <= now() then
    raise exception 'ეს კურსი ვადაგასულია. თუ კლიენტს კვლავ სურს კონვერტაცია, თავიდან სთხოვეთ.' using errcode = '22023';
  end if;
  if v_req.rate_written_at is not null or v_req.payment_confirmed_at is not null then
    raise exception 'ეს მოთხოვნა უკვე შესრულდა' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.transactions t
    where t.client_id = v_req.client_id
      and t.tx_date = v_req.request_date
      and t.payment_status = 'SUCCESS'
      and (v_req.source = 'import' or t.tx_time >= v_req.requested_at - interval '1 minute')
  ) then
    raise exception 'ეს მოთხოვნა უკვე შესრულდა' using errcode = '22023';
  end if;
  if p_rate is null or p_rate <= 0 then
    raise exception 'ჩაწერეთ კურსი' using errcode = '22023';
  end if;

  v_rate := round(p_rate, 6);
  update public.requests r
     set client_reply = 'approved',
         approved_rate = v_rate,
         wanted_rate = null,
         better_decision = null,
         given_rate = null,
         client_decline_reason = null,
         client_replied_at = now(),
         better_decided_at = null,
         better_decided_by = null,
         rate_write_deferred = true
   where r.id = p_request_id
     and r.client_reply is null
  returning r.id into v_id;
  if v_id is null then
    raise exception 'ამ მოთხოვნაზე პასუხი უკვე ჩაწერილია' using errcode = '22023';
  end if;
end;
$$;

comment on function public.kam_defer_rate_write(bigint, numeric) is
  'Save a client approval and hold it off the treasury write queue. The owning KAM only. Does not set rate_written_at and does not notify treasury.';

revoke all on function public.kam_defer_rate_write(bigint, numeric) from public, anon;
grant execute on function public.kam_defer_rate_write(bigint, numeric) to authenticated;

-- ---------------------------------------------------------------------
-- Send a held approval to the write queue exactly once.
-- ---------------------------------------------------------------------
create or replace function public.kam_release_rate_write(p_request_id bigint)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me   uuid := private.my_profile_id();
  v_req  public.requests%rowtype;
  v_id   bigint;
  f      jsonb;
begin
  if v_me is null or not private.can_write() then
    raise exception 'თქვენს ანგარიშს ამ მოთხოვნის შეცვლა არ შეუძლია' using errcode = '42501';
  end if;

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  if v_req.kam_id <> v_me then
    raise exception 'ეს მოთხოვნა სხვა კამ-ს ეკუთვნის' using errcode = '42501';
  end if;
  if v_req.client_reply is distinct from 'approved' or v_req.approved_rate is null then
    raise exception 'კლიენტს ჯერ არ დაუმტკიცებია კურსი' using errcode = '22023';
  end if;
  if v_req.rate_written_at is not null or v_req.payment_confirmed_at is not null then
    return;
  end if;
  if v_req.marked_lost_at is not null
     or v_req.loss_approved_at is not null
     or nullif(btrim(coalesce(v_req.loss_reason, '')), '') is not null then
    raise exception 'დაკარგული მოთხოვნა გაწერის რიგში არ მიდის' using errcode = '22023';
  end if;
  if v_req.rate_write_deferred is not true then
    return;
  end if;

  update public.requests r
     set rate_write_deferred = false
   where r.id = p_request_id
     and r.rate_write_deferred
     and r.rate_written_at is null
  returning r.id into v_id;

  if v_id is null then
    return;
  end if;

  begin
    f := private.request_facts(p_request_id);
    perform private.emit(
      'request.client_approved',
      p_request_id,
      v_req.kam_id,
      format('%s: %s approved %s. Quoted rate was %s. Client sells %s. Client gets %s.',
             f->>'kam_name', f->>'client_name', f->>'approved_rate_text', f->>'rate_text',
             f->>'sells_text', f->>'gets_text'),
      format('%s: %s-მა დაამტკიცა კურსი %s. ხაზინის კურსი იყო %s. კლიენტი ყიდის %s. კლიენტი იღებს %s.',
             f->>'kam_name', f->>'client_name', f->>'approved_rate_text', f->>'rate_text',
             f->>'sells_text', f->>'gets_text'),
      f
    );
  exception when others then
    raise warning 'notification skipped: %', sqlerrm;
  end;
end;
$$;

comment on function public.kam_release_rate_write(bigint) is
  'Move a held client approval onto the treasury write queue once. The owning KAM only. A second call returns without a second notice. Does not set rate_written_at.';

revoke all on function public.kam_release_rate_write(bigint) from public, anon;
grant execute on function public.kam_release_rate_write(bigint) to authenticated;

-- Inbox: a held approval does not notify treasury or managers.
-- Clearing the hold sends the same notice today's approval sends.
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
      'ხაზინამ კურსი გასცა', 'Treasury quoted',
      v_client || ': ' || v_rate,
      v_client || ': ' || v_rate
    );
  end if;

  if old.quote_status is distinct from 'declined' and new.quote_status = 'declined' then
    perform private.inbox_add(
      'kam', new.kam_id, 'treasury.declined', new.id,
      'ხაზინამ უარი თქვა', 'Treasury declined',
      v_client || ': ' || coalesce(new.decline_reason, ''),
      v_client || ': ' || coalesce(new.decline_reason, '')
    );
  end if;

  if old.client_reply is distinct from 'approved'
     and new.client_reply = 'approved'
     and coalesce(new.rate_write_deferred, false) = false then
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

  if tg_op = 'UPDATE'
     and coalesce(old.rate_write_deferred, false)
     and coalesce(new.rate_write_deferred, false) = false
     and new.client_reply = 'approved'
     and new.approved_rate is not null then
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
        'ხაზინამ კურსი გასცა', 'Treasury quoted',
        v_client || ': ' || v_rate,
        v_client || ': ' || v_rate
      );
    else
      perform private.inbox_add(
        'kam', new.kam_id, 'treasury.corrected', new.id,
        'ხაზინამ კურსი გაასწორა', 'Treasury corrected the rate',
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

-- Treasury write list: a held approval is not "rate to write".
create or replace function public.treasury_client_replies()
returns table (
  request_id            bigint,
  kam_name              text,
  client_id             text,
  client_name           text,
  sells_currency        text,
  gets_currency         text,
  amount                numeric,
  gets_amount           numeric,
  rate                  numeric,
  client_reply          text,
  approved_rate         numeric,
  wanted_rate           numeric,
  better_decision       text,
  given_rate            numeric,
  client_decline_reason text,
  client_replied_at     timestamptz,
  note                  text
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (private.is_treasury() or private.is_admin()) then
    raise exception 'მხოლოდ ხაზინას შეუძლია ამ სიის ნახვა' using errcode = '42501';
  end if;
  return query
  select r.id,
         p.full_name,
         r.client_id,
         c.name,
         r.sells_currency,
         r.gets_currency,
         r.amount,
         r.gets_amount,
         r.rate,
         r.client_reply,
         r.approved_rate,
         r.wanted_rate,
         r.better_decision,
         r.given_rate,
         r.client_decline_reason,
         r.client_replied_at,
         r.note
  from public.requests r
  join public.clients c on c.client_id = r.client_id
  join public.profiles p on p.id = r.kam_id
  where r.source = 'app'
    and r.client_reply is not null
    and not (r.client_reply = 'approved' and coalesce(r.rate_write_deferred, false))
    and (
      (r.client_reply = 'better' and r.better_decision is null)
      or (r.client_replied_at at time zone 'Asia/Tbilisi')::date = private.tbilisi_today()
      or (r.better_decided_at at time zone 'Asia/Tbilisi')::date = private.tbilisi_today()
    )
  order by
    case when r.client_reply = 'better' and r.better_decision is null then 0 else 1 end,
    r.client_replied_at desc;
end;
$$;

revoke all on function public.treasury_client_replies() from public, anon;
grant execute on function public.treasury_client_replies() to authenticated;

-- A held row is not ready for treasury to mark written.
create or replace function public.treasury_mark_rate_written(p_request_id bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.my_profile_id();
  v_req public.requests%rowtype;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'მხოლოდ ხაზინას შეუძლია ამის მონიშვნა' using errcode = '42501';
  end if;

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  if v_req.client_reply is distinct from 'approved' or v_req.approved_rate is null then
    raise exception 'კლიენტს ჯერ არ დაუმტკიცებია კურსი' using errcode = '22023';
  end if;
  if coalesce(v_req.rate_write_deferred, false) then
    raise exception 'KAM ჯერ არ გაუგზავნია ეს კურსი გასაწერად' using errcode = '22023';
  end if;
  if v_req.rate_written_at is not null then
    return;
  end if;

  update public.requests r
     set rate_written_at = now(),
         rate_written_by = v_me
   where r.id = p_request_id
     and r.rate_written_at is null
     and coalesce(r.rate_write_deferred, false) = false;
end;
$$;

revoke all on function public.treasury_mark_rate_written(bigint) from public, anon;
grant execute on function public.treasury_mark_rate_written(bigint) to authenticated;
