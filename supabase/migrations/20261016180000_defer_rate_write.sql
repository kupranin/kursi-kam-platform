-- Same statements as supabase/setup/43_defer_rate_write.sql. Not applied.
-- Paste this in the Supabase SQL editor when you want the change.
-- Copy it from disk. Paste it after 42_client_special_rates.sql.
-- Do not re-run 1_platform.sql.
-- Safe to paste again. It does not drop tables. It does not use CASCADE.
-- It drops and recreates kam_release_rate_write(bigint) so the return can be text.
-- It drops treasury_reconfirm_deferred and treasury_reconfirm_queue if a previous
-- paste created them, and it does not recreate them. A database that never had
-- them is unchanged by those drops (IF EXISTS). Nothing else in this repo calls them.
-- It drops reconfirm-only columns if they exist and nothing else depends on them.
-- It does not change log_request argument names.
-- It does not change request_outcomes, analyst_deals, or success/loss math.
-- It does not widen can_see_all. A KAM is not added to analyst_deals.
-- It does not reclassify old approvals. rate_write_deferred defaults to false,
-- which means "already sent to the treasury write queue" (today's behavior).
-- No backfill. No update of old rows.
--
-- A treasury quote does not start an acceptance countdown.
-- treasury_quote keeps its signature and ignores p_valid_minutes.
-- A new quote stores rate_valid_until null. Old values are not rewritten.
-- kam_client_reply is replaced in this file. It no longer refuses a quote
-- because rate_valid_until or rules.default_quote_minutes has passed.
-- The other checks stay: owner, can_write, source, quoted, no reply yet,
-- not written, not paid, and the SUCCESS transaction guard. FOR UPDATE.
--
-- client_replied_at is the acceptance clock. kam_client_reply and
-- kam_defer_rate_write set it once, when the reply is first saved.
-- edit_request does not write it. The authenticated guard refuses a
-- direct change. ask_again refuses an approved reply, so it does not
-- clear that timestamp. treasury_answer_better clears it only when it
-- clears a better-rate reply, which is not an accepted deal. No accepted_at
-- column. The 24-hour hold is client_replied_at plus 24 hours.
--
-- Two choices for the owning KAM, same ownership as kam_client_reply
-- (kam_id must be the caller; an admin is not given another KAM's row):
--   kam_client_reply saves the approval and leaves the flag false,
--   so the row stays on the treasury write queue.
--   kam_defer_rate_write saves the same approval and sets the flag true.
--   The original quote, the approved rate, and client_replied_at stay.
--   Passing 24 hours does not cancel the request, mark it lost, change
--   the rate, or write it. It only makes the hold overdue.
--   Within 24 hours, kam_release_rate_write clears the flag and sends
--   the agreed deal. It does not rewrite the rate and it does not ask
--   treasury to reconfirm. 'released' puts the row on the write queue once.
--   The notice matches a normal approval: the inbox trigger writes one
--   treasury row and one manager row, and this function emits
--   request.client_approved once. A second call returns 'unchanged'
--   and does not notify again.
--   After 24 hours the owning KAM cannot release. The closing queue is
--   the row itself: held, approved, not released, not written, not paid,
--   not lost, and client_replied_at plus 24 hours is before now(). It
--   does not read closing_overdue_notified_at. A failed notice does not
--   hide the deal, and the queue does not wait for the cron job.
--   Treasury or admin approves closing, including after an exception.
--   That moves the same rate onto the write queue and records who and
--   when. It does not set rate_written_at and it does not overwrite the
--   first exception. If closing cannot be approved, the first exception
--   stores who, when, and a reason. The row stays in the queue until a
--   later approval. One inbox row and one private.emit per transition.
--   A second press of the same decision does not notify again.
--   'unchanged' is also a written rate or a payment mark.
-- A written rate (rate_written_at) is unchanged. This is not payment success.
-- ask_again does not fit: it refuses an approval and clears client_reply.
-- treasury_quote does not fit: it requires quote_status = 'asking' and
-- replaces the rate. Neither is called here.
-- An explicit loss or a payment mark cannot be released onto the write queue.
-- Treasury cannot mark a held row written.
-- treasury_set_rate cannot edit or clear requests.rate on an agreed deal
-- that is not yet written. That includes a hold, a KAM release, a closing
-- approval, and an immediate approval. The hold flag being false is not
-- enough. An unapproved quote can still be set or cleared. After
-- rate_written_at is set, the existing treasury_set_rate correction
-- remains: a new rate, or null, which also clears the written mark.
-- That correction is not a new workflow. This lock does not set
-- rate_written_at, payment, or loss.
-- This file drops trigger requests_guard_deferred_write and recreates it.
-- That drop is not CASCADE and does not drop requests_guard_update.
-- An authenticated update cannot clear the hold, mark a held row written,
-- or change the agreed rate, validity, quote status, reply, or acceptance
-- time while the hold is set. Security definer functions still pass.
-- They check the role themselves. Release goes through kam_release_rate_write.

alter table public.requests
  add column if not exists rate_write_deferred boolean not null default false;

comment on column public.requests.rate_write_deferred is
  'True only when the KAM saved a client approval and has not sent it to the treasury write queue yet. False is the default, including every approval saved before this column existed. The agreed rate stays while this is true. A stored rate_valid_until does not cancel it.';

alter table public.requests
  add column if not exists deferred_released_at timestamptz;

alter table public.requests
  add column if not exists deferred_released_by uuid references public.profiles (id);

comment on column public.requests.deferred_released_at is
  'When a held approval entered the treasury write queue. The owning KAM released it within 24 hours, or treasury approved closing after that. The hold clock itself is client_replied_at, not this column.';

comment on column public.requests.deferred_released_by is
  'Profile that moved a held approval onto the write queue. The owning KAM, or the treasury or admin user who approved closing.';

alter table public.requests
  add column if not exists closing_approved_at timestamptz;

alter table public.requests
  add column if not exists closing_approved_by uuid references public.profiles (id);

comment on column public.requests.closing_approved_at is
  'When treasury or an admin approved closing an overdue held deal. The deal then enters the ordinary write queue. This does not set rate_written_at.';

comment on column public.requests.closing_approved_by is
  'Treasury or admin profile that approved closing. Not a manager, analyst, or KAM.';

alter table public.requests
  add column if not exists closing_exception_at timestamptz;

alter table public.requests
  add column if not exists closing_exception_by uuid references public.profiles (id);

alter table public.requests
  add column if not exists closing_exception_reason text;

comment on column public.requests.closing_exception_reason is
  'Why treasury could not approve closing the first time. 2 to 500 characters. A later closing approval does not overwrite this, the actor, or the timestamp. The approval, the rate, and loss or payment fields stay as they were until that later approval, which only clears the hold.';

alter table public.requests
  add column if not exists closing_overdue_notified_at timestamptz;

comment on column public.requests.closing_overdue_notified_at is
  'Set only after the in-app inbox row and the private.emit outbox row are written in the same transaction. A failed attempt leaves this null so the next run can retry. The closing queue does not read this column. A missing value does not hide the deal. A later run does not send the notice again once this is set. This is not proof that Make.com delivered the outbox row.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'requests_closing_exception_reason_len'
      and conrelid = 'public.requests'::regclass
  ) then
    alter table public.requests
      add constraint requests_closing_exception_reason_len
      check (
        closing_exception_reason is null
        or (
          length(btrim(closing_exception_reason)) >= 2
          and length(closing_exception_reason) <= 500
        )
      );
  end if;
end
$$;

create index if not exists requests_deferred_kam_idx
  on public.requests (kam_id, id)
  where rate_write_deferred;

-- ---------------------------------------------------------------------
-- Hold the approval off the write queue. Same checks as an approval in
-- kam_client_reply, including the quote window. Does not notify.
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
  'Save a client approval and hold it off the treasury write queue. The owning KAM only, same as kam_client_reply. Does not refuse because rate_valid_until has passed. Does not set rate_written_at and does not notify treasury. client_replied_at is the hold clock.';

revoke all on function public.kam_defer_rate_write(bigint, numeric) from public, anon;
grant execute on function public.kam_defer_rate_write(bigint, numeric) to authenticated;

-- ---------------------------------------------------------------------
-- Release a held approval onto the write queue.
-- The 5/15/30 minute window is not checked again. The rate is not rewritten.
-- Drop is only so a previous void return can be replaced with text.
-- ---------------------------------------------------------------------
drop function if exists public.kam_release_rate_write(bigint);

create function public.kam_release_rate_write(p_request_id bigint)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me  uuid := private.my_profile_id();
  v_req public.requests%rowtype;
  v_id  bigint;
  f     jsonb;
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
    return 'unchanged';
  end if;
  if v_req.marked_lost_at is not null
     or v_req.loss_approved_at is not null
     or nullif(btrim(coalesce(v_req.loss_reason, '')), '') is not null then
    raise exception 'დაკარგული მოთხოვნა გაწერის რიგში არ მიდის' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.transactions t
    where t.client_id = v_req.client_id
      and t.tx_date = v_req.request_date
      and t.payment_status = 'SUCCESS'
      and (v_req.source = 'import' or t.tx_time >= v_req.requested_at - interval '1 minute')
  ) then
    return 'unchanged';
  end if;
  if v_req.quote_status is distinct from 'quoted' or v_req.rate is null then
    raise exception 'ხაზინამ ჯერ კურსი არ გასცა' using errcode = '22023';
  end if;
  if v_req.rate_write_deferred is not true then
    return 'unchanged';
  end if;
  if v_req.closing_approved_at is not null or v_req.closing_exception_at is not null then
    return 'unchanged';
  end if;
  if v_req.client_replied_at is null
     or v_req.client_replied_at + interval '24 hours' < now() then
    raise exception '24 საათი გავიდა. ამ გარიგებას ხაზინა ადასტურებს' using errcode = '22023';
  end if;

  update public.requests r
     set rate_write_deferred = false,
         deferred_released_at = now(),
         deferred_released_by = v_me
   where r.id = p_request_id
     and r.rate_write_deferred
     and r.rate_written_at is null
     and r.client_reply = 'approved'
     and r.approved_rate is not null
     and r.rate is not null
     and r.quote_status = 'quoted'
  returning r.id into v_id;

  if v_id is null then
    return 'unchanged';
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

  return 'released';
end;
$$;

comment on function public.kam_release_rate_write(bigint) is
  'Owning KAM only, and only while client_replied_at plus 24 hours is still in the future. Returns released when a held approval enters the write queue. Does not change rate, approved_rate, rate_valid_until, or client_replied_at. After 24 hours it raises and does not notify. Returns unchanged when nothing was sent, including a second call, a closing approval, or an exception. Does not set rate_written_at. One approval notice per channel on the first release only.';

revoke all on function public.kam_release_rate_write(bigint) from public, anon;
grant execute on function public.kam_release_rate_write(bigint) to authenticated;

-- Inbox: a held approval does not notify treasury or managers.
-- A KAM release clears the hold and sends the same notice today's
-- approval sends. client_reply is already approved, so the "became
-- approved" branch does not also fire. Treasury closing approval sets
-- closing_approved_at in the same update, so this branch does not also
-- notify treasury. That function notifies the owning KAM itself.
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
     and new.approved_rate is not null
     and new.closing_approved_at is not distinct from old.closing_approved_at then
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
-- A release whose client_replied_at is an earlier Tbilisi day still
-- appears on the day it was released.
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
    and not (
      r.client_reply = 'approved'
      and coalesce(r.rate_write_deferred, false)
    )
    and (
      (r.client_reply = 'better' and r.better_decision is null)
      or (r.client_replied_at at time zone 'Asia/Tbilisi')::date = private.tbilisi_today()
      or (r.better_decided_at at time zone 'Asia/Tbilisi')::date = private.tbilisi_today()
      or (
        coalesce(r.rate_write_deferred, false) = false
        and r.deferred_released_at is not null
        and (r.deferred_released_at at time zone 'Asia/Tbilisi')::date = private.tbilisi_today()
      )
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

-- Treasury changes the rate it wrote, or clears it.
-- An agreed rate that is not yet written stays, whether or not the hold
-- flag is set. Unapproved quotes can still be set or cleared.
-- After rate_written_at, the existing correction remains. Null still
-- clears that written mark. This function does not set payment or loss.
create or replace function public.treasury_set_rate(p_request_id bigint, p_rate numeric)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me   uuid := private.my_profile_id();
  v_req  public.requests%rowtype;
  v_rate numeric;
  v_id   bigint;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'მხოლოდ ხაზინას შეუძლია კურსის შეცვლა' using errcode = '42501';
  end if;

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  if v_req.client_reply = 'approved'
     and v_req.approved_rate is not null
     and v_req.rate_written_at is null then
    raise exception 'შეთანხმებული კურსი აღარ იცვლება' using errcode = '22023';
  end if;
  if coalesce(v_req.rate_write_deferred, false) then
    raise exception 'KAM ჯერ არ გაუგზავნია ეს კურსი გასაწერად' using errcode = '22023';
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
     where r.id = p_request_id
       and coalesce(r.rate_write_deferred, false) = false
       and (
         r.client_reply is distinct from 'approved'
         or r.approved_rate is null
         or r.rate_written_at is not null
       )
    returning r.id into v_id;
    if v_id is null then
      raise exception 'შეთანხმებული კურსი აღარ იცვლება' using errcode = '22023';
    end if;
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
   where r.id = p_request_id
     and coalesce(r.rate_write_deferred, false) = false
     and (
       r.client_reply is distinct from 'approved'
       or r.approved_rate is null
       or r.rate_written_at is not null
     )
  returning r.id into v_id;
  if v_id is null then
    raise exception 'შეთანხმებული კურსი აღარ იცვლება' using errcode = '22023';
  end if;

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

-- ---------------------------------------------------------------------
-- Client acceptance. Same signature as kam_client_reply. The quote
-- countdown is not a reason to refuse. Authorization, the row lock,
-- and the payment and loss guards stay.
-- ---------------------------------------------------------------------
create or replace function public.kam_client_reply(
  p_request_id bigint,
  p_reply      text,
  p_rate       numeric default null,
  p_reason     text default null
)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me     uuid := private.my_profile_id();
  v_req    public.requests%rowtype;
  v_rate   numeric;
  v_reason text;
  f        jsonb;
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
  if exists (
    select 1 from public.transactions t
    where t.client_id = v_req.client_id
      and t.tx_date = v_req.request_date
      and t.payment_status = 'SUCCESS'
      and (v_req.source = 'import' or t.tx_time >= v_req.requested_at - interval '1 minute')
  ) then
    raise exception 'ეს მოთხოვნა უკვე შესრულდა' using errcode = '22023';
  end if;

  if p_reply in ('approved', 'better') then
    if p_rate is null or p_rate <= 0 then
      raise exception 'ჩაწერეთ კურსი' using errcode = '22023';
    end if;
    v_rate := round(p_rate, 6);
  elsif p_reply = 'declined' then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is null or length(v_reason) < 2 then
      raise exception 'ჩაწერეთ მიზეზი' using errcode = '22023';
    end if;
    if length(v_reason) > 500 then
      raise exception 'მიზეზი ძალიან გრძელია' using errcode = '22023';
    end if;
  else
    raise exception 'აირჩიეთ პასუხი' using errcode = '22023';
  end if;

  if p_reply = 'approved' then
    if v_req.rate_written_at is not null then
      raise exception 'ეს მოთხოვნა უკვე შესრულდა' using errcode = '22023';
    end if;
    if v_req.payment_confirmed_at is not null then
      raise exception 'ეს მოთხოვნა უკვე შესრულდა' using errcode = '22023';
    end if;
    update public.requests r
       set client_reply = 'approved',
           approved_rate = v_rate,
           wanted_rate = null,
           better_decision = null,
           given_rate = null,
           client_decline_reason = null,
           client_replied_at = now(),
           better_decided_at = null,
           better_decided_by = null
     where r.id = p_request_id
       and r.client_reply is null;
  elsif p_reply = 'better' then
    update public.requests r
       set client_reply = 'better',
           wanted_rate = v_rate,
           approved_rate = null,
           better_decision = null,
           given_rate = null,
           client_decline_reason = null,
           client_replied_at = now(),
           better_decided_at = null,
           better_decided_by = null
     where r.id = p_request_id
       and r.client_reply is null;
  else
    update public.requests r
       set client_reply = 'declined',
           client_decline_reason = v_reason,
           approved_rate = null,
           wanted_rate = null,
           better_decision = null,
           given_rate = null,
           client_replied_at = now(),
           better_decided_at = null,
           better_decided_by = null
     where r.id = p_request_id
       and r.client_reply is null;
  end if;

  if not found then
    raise exception 'ამ მოთხოვნაზე პასუხი უკვე ჩაწერილია' using errcode = '22023';
  end if;

  if p_reply = 'approved' then
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
  end if;
end;
$$;

comment on function public.kam_client_reply(bigint, text, numeric, text) is
  'Owning KAM records the client reply. An approved reply may be saved after rate_valid_until. That column is not an acceptance deadline. Does not set rate_write_deferred, so the row goes to the write queue. One approval notice per channel.';

revoke all on function public.kam_client_reply(bigint, text, numeric, text) from public, anon;
grant execute on function public.kam_client_reply(bigint, text, numeric, text) to authenticated;

-- A corrected or accepted better rate goes back to the KAM without a new
-- acceptance countdown. Same signature. Decline still ends the loop.
create or replace function public.treasury_answer_better(
  p_request_id bigint,
  p_decision   text,
  p_rate       numeric default null,
  p_reason     text default null
)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me     uuid := private.my_profile_id();
  v_req    public.requests%rowtype;
  v_rate   numeric;
  v_reason text;
  f        jsonb;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'მხოლოდ ხაზინას შეუძლია ამ კურსის პასუხი' using errcode = '42501';
  end if;

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  if v_req.client_reply <> 'better' or v_req.better_decision is not null or v_req.wanted_rate is null then
    raise exception 'ეს მოთხოვნა აღარ ელოდება უკეთეს კურსს' using errcode = '22023';
  end if;

  if p_decision = 'accepted' then
    v_rate := v_req.wanted_rate;
  elsif p_decision = 'corrected' then
    if p_rate is null or p_rate <= 0 then
      raise exception 'ჩაწერეთ გასწორებული კურსი' using errcode = '22023';
    end if;
    v_rate := round(p_rate, 6);
  elsif p_decision = 'declined' then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is null or length(v_reason) < 2 then
      raise exception 'ჩაწერეთ მიზეზი' using errcode = '22023';
    end if;
    if length(v_reason) > 200 then
      raise exception 'მიზეზი ძალიან გრძელია' using errcode = '22023';
    end if;
  else
    raise exception 'აირჩიეთ დადასტურება, გასწორებული კურსი ან უარი' using errcode = '22023';
  end if;

  if p_decision = 'declined' then
    update public.requests r
       set quote_status = 'declined',
           decline_reason = v_reason,
           quoted_by = v_me,
           quoted_at = now(),
           rate = null,
           rate_valid_until = null,
           client_reply = null,
           approved_rate = null,
           wanted_rate = null,
           better_decision = null,
           given_rate = null,
           client_decline_reason = null,
           client_replied_at = null,
           better_decided_at = null,
           better_decided_by = null
     where r.id = p_request_id;
    insert into public.quotes (request_id, action, reason, created_by)
    values (p_request_id, 'declined', v_reason, v_me);
    begin
      f := private.request_facts(p_request_id);
      perform private.emit(
        'request.sent_back',
        p_request_id,
        v_req.kam_id,
        format('Treasury sent back %s (client sells %s, client gets %s): %s',
               f->>'client_name', f->>'sells_text', f->>'gets_text', f->>'decline_reason'),
        format('ხაზინის სამსახურმა დააბრუნა მოთხოვნა: %s (კლიენტი ყიდის %s, იღებს %s). მიზეზი: %s',
               f->>'client_name', f->>'sells_text', f->>'gets_text', f->>'decline_reason'),
        f
      );
    exception when others then
      raise warning 'notification skipped: %', sqlerrm;
    end;
    return;
  end if;

  update public.requests r
     set rate = v_rate,
         quote_status = 'quoted',
         rate_valid_until = null,
         quoted_by = v_me,
         quoted_at = now(),
         decline_reason = null,
         client_reply = null,
         approved_rate = null,
         wanted_rate = null,
         better_decision = null,
         given_rate = null,
         client_decline_reason = null,
         client_replied_at = null,
         better_decided_at = null,
         better_decided_by = null
   where r.id = p_request_id;
  insert into public.quotes (request_id, action, rate, valid_until, created_by)
  values (p_request_id, 'quoted', v_rate, null, v_me);
  begin
    f := private.request_facts(p_request_id);
    perform private.emit(
      'rate.ready',
      p_request_id,
      v_req.kam_id,
      format('Rate for %s: %s. Client sells %s. Client gets %s.',
             f->>'client_name', f->>'rate_text', f->>'sells_text', f->>'gets_text'),
      format('%s-ის კურსი: %s. კლიენტი ყიდის %s. კლიენტი იღებს %s.',
             f->>'client_name', f->>'rate_text', f->>'sells_text', f->>'gets_text'),
      f
    );
  exception when others then
    raise warning 'notification skipped: %', sqlerrm;
  end;
end;
$$;

revoke all on function public.treasury_answer_better(bigint, text, numeric, text) from public, anon;
grant execute on function public.treasury_answer_better(bigint, text, numeric, text) to authenticated;

-- Same signature. p_valid_minutes is ignored so a new quote does not
-- create an acceptance deadline. Old rate_valid_until values stay.
create or replace function public.treasury_quote(p_request_id bigint, p_rate numeric, p_valid_minutes int default null)
returns timestamptz
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me  uuid := private.my_profile_id();
  v_req public.requests%rowtype;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'Only treasury can give rates' using errcode = '42501';
  end if;
  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_req.quote_status <> 'asking' then
    raise exception 'This request has already been answered' using errcode = '22023';
  end if;
  if p_rate is null or p_rate <= 0 then
    raise exception 'Enter a rate first' using errcode = '22023';
  end if;

  update public.requests r
     set rate = p_rate,
         quote_status = 'quoted',
         rate_valid_until = null,
         quoted_by = v_me,
         quoted_at = now(),
         decline_reason = null
   where r.id = p_request_id;
  insert into public.quotes (request_id, action, rate, valid_until, created_by, standard_rate)
  values (
    p_request_id,
    'quoted',
    p_rate,
    null,
    v_me,
    private.standard_rate_for(v_req.sells_currency, v_req.gets_currency)
  );
  return null;
end;
$$;

comment on function public.treasury_quote(bigint, numeric, int) is
  'Treasury quotes a rate. p_valid_minutes is accepted and ignored. rate_valid_until is cleared for this quote so it is not an acceptance deadline. Does not rewrite other rows.';

revoke all on function public.treasury_quote(bigint, numeric, int) from public, anon;
grant execute on function public.treasury_quote(bigint, numeric, int) to authenticated;

-- The quote notice must not say the rate expires. Same function otherwise.
create or replace function private.notify_request_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  f          jsonb;
  v_extra_en text;
  v_extra_ka text;
begin
  begin
    if new.source <> 'app' then
      return null;
    end if;
    f := private.request_facts(new.id);
    v_extra_en :=
      case when coalesce(f->>'client_rate_text', '') = '' then ''
           else ' Rate the client is asking: ' || (f->>'client_rate_text') || '.' end
      || coalesce(' Comment: ' || nullif(f->>'note', ''), '');
    v_extra_ka :=
      case when coalesce(f->>'client_rate_text', '') = '' then ''
           else ' კლიენტის მოთხოვნილი კურსი: ' || (f->>'client_rate_text') || '.' end
      || coalesce(' კომენტარი: ' || nullif(f->>'note', ''), '');

    if tg_op = 'INSERT' then
      perform private.emit('request.new', new.id, new.kam_id,
        format('New rate request from %s: %s. Client sells %s. Client gets %s.%s',
               f->>'kam_name', f->>'client_name', f->>'sells_text', f->>'gets_text', v_extra_en),
        format('ახალი მოთხოვნა კურსზე, %s: %s. კლიენტი ყიდის %s. კლიენტი იღებს %s.%s',
               f->>'kam_name', f->>'client_name', f->>'sells_text', f->>'gets_text', v_extra_ka),
        f);

    elsif old.quote_status = 'asking' and new.quote_status = 'quoted' then
      perform private.emit('rate.ready', new.id, new.kam_id,
        format('Rate for %s: %s. Client sells %s. Client gets %s.',
               f->>'client_name', f->>'rate_text', f->>'sells_text', f->>'gets_text'),
        format('%s-ის კურსი: %s. კლიენტი ყიდის %s. კლიენტი იღებს %s.',
               f->>'client_name', f->>'rate_text', f->>'sells_text', f->>'gets_text'),
        f);

    elsif old.quote_status = 'asking' and new.quote_status = 'declined' then
      perform private.emit('request.sent_back', new.id, new.kam_id,
        format('Treasury sent back %s (client sells %s, client gets %s): %s',
               f->>'client_name', f->>'sells_text', f->>'gets_text', f->>'decline_reason'),
        format('ხაზინის სამსახურმა დააბრუნა მოთხოვნა: %s (კლიენტი ყიდის %s, იღებს %s). მიზეზი: %s',
               f->>'client_name', f->>'sells_text', f->>'gets_text', f->>'decline_reason'),
        f);

    elsif old.quote_status in ('quoted', 'declined') and new.quote_status = 'asking' then
      perform private.emit('request.asked_again', new.id, new.kam_id,
        format('%s asks again: %s. Client sells %s. Client gets %s.%s',
               f->>'kam_name', f->>'client_name', f->>'sells_text', f->>'gets_text', v_extra_en),
        format('ხელახალი მოთხოვნა, %s: %s. კლიენტი ყიდის %s. კლიენტი იღებს %s.%s',
               f->>'kam_name', f->>'client_name', f->>'sells_text', f->>'gets_text', v_extra_ka),
        f);
    end if;
  exception when others then
    raise warning 'notification skipped: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.notify_request_change() from public, anon, authenticated;

insert into public.notification_rules (event_type, audience, enabled, description) values
  ('deal.closing_due', 'treasury', true, 'A held approval has passed 24 hours and needs treasury to approve closing'),
  ('deal.closing_approved', 'kam', true, 'Treasury approved closing and the agreed rate is on the write queue'),
  ('deal.closing_exception', 'kam', true, 'Treasury recorded why a held deal cannot be closed')
on conflict (event_type, audience) do nothing;

-- Overdue held deals. Not treasury_queue(), so that return type stays.
create or replace function public.treasury_closing_queue()
returns table (
  request_id               bigint,
  kam_name                 text,
  client_id                text,
  client_name              text,
  sells_currency           text,
  gets_currency            text,
  amount                   numeric,
  gets_amount              numeric,
  rate                     numeric,
  approved_rate            numeric,
  client_replied_at        timestamptz,
  note                     text,
  closing_exception_at     timestamptz,
  closing_exception_reason text
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
         r.approved_rate,
         r.client_replied_at,
         r.note,
         r.closing_exception_at,
         r.closing_exception_reason
  from public.requests r
  join public.clients c on c.client_id = r.client_id
  join public.profiles p on p.id = r.kam_id
  where r.source = 'app'
    and r.rate_write_deferred
    and r.client_reply = 'approved'
    and r.approved_rate is not null
    and r.rate_written_at is null
    and r.payment_confirmed_at is null
    and r.marked_lost_at is null
    and r.loss_approved_at is null
    and nullif(btrim(coalesce(r.loss_reason, '')), '') is null
    and r.closing_approved_at is null
    and r.client_replied_at is not null
    and r.client_replied_at + interval '24 hours' < now()
    and not exists (
      select 1 from public.transactions t
      where t.client_id = r.client_id
        and t.tx_date = r.request_date
        and t.payment_status = 'SUCCESS'
        and (r.source = 'import' or t.tx_time >= r.requested_at - interval '1 minute')
    )
  order by r.client_replied_at, r.id;
end;
$$;

comment on function public.treasury_closing_queue() is
  'Database-derived. Held, approved, unreleased, unwritten, unpaid, not lost, and client_replied_at plus 24 hours is before now. Does not read closing_overdue_notified_at, so a failed notice does not hide the row and the list does not wait for the cron job. An exception stays until closing_approved_at is set. Treasury and admin only.';

revoke all on function public.treasury_closing_queue() from public, anon;
grant execute on function public.treasury_closing_queue() to authenticated;

create or replace function public.treasury_approve_closing(p_request_id bigint)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me  uuid := private.my_profile_id();
  v_req public.requests%rowtype;
  v_id  bigint;
  f     jsonb;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'მხოლოდ ხაზინას შეუძლია ამ გარიგების დასტური' using errcode = '42501';
  end if;

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  if v_req.client_reply is distinct from 'approved' or v_req.approved_rate is null then
    raise exception 'კლიენტს ჯერ არ დაუმტკიცებია კურსი' using errcode = '22023';
  end if;
  if v_req.rate_written_at is not null or v_req.payment_confirmed_at is not null then
    return 'unchanged';
  end if;
  if v_req.marked_lost_at is not null
     or v_req.loss_approved_at is not null
     or nullif(btrim(coalesce(v_req.loss_reason, '')), '') is not null then
    raise exception 'დაკარგული მოთხოვნა გაწერის რიგში არ მიდის' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.transactions t
    where t.client_id = v_req.client_id
      and t.tx_date = v_req.request_date
      and t.payment_status = 'SUCCESS'
      and (v_req.source = 'import' or t.tx_time >= v_req.requested_at - interval '1 minute')
  ) then
    return 'unchanged';
  end if;
  if v_req.rate_write_deferred is not true
     or v_req.closing_approved_at is not null then
    return 'unchanged';
  end if;
  if v_req.client_replied_at is null
     or v_req.client_replied_at + interval '24 hours' >= now() then
    raise exception '24 საათი ჯერ არ გასულა' using errcode = '22023';
  end if;
  if v_req.quote_status is distinct from 'quoted' or v_req.rate is null then
    raise exception 'ხაზინამ ჯერ კურსი არ გასცა' using errcode = '22023';
  end if;

  -- Does not write closing_exception_at, closing_exception_by, or
  -- closing_exception_reason. The first exception stays.
  update public.requests r
     set rate_write_deferred = false,
         deferred_released_at = now(),
         deferred_released_by = v_me,
         closing_approved_at = now(),
         closing_approved_by = v_me
   where r.id = p_request_id
     and r.rate_write_deferred
     and r.closing_approved_at is null
     and r.rate_written_at is null
     and r.payment_confirmed_at is null
     and r.client_reply = 'approved'
     and r.approved_rate is not null
     and r.rate is not null
     and r.quote_status = 'quoted'
     and r.client_replied_at + interval '24 hours' < now()
  returning r.id into v_id;

  if v_id is null then
    return 'unchanged';
  end if;

  begin
    f := private.request_facts(p_request_id);
    perform private.inbox_add(
      'kam', v_req.kam_id, 'deal.closing_approved', p_request_id,
      'ხაზინამ დახურვა დაადასტურა', 'Treasury approved closing',
      coalesce(f->>'client_name', '') || ': ' || coalesce(f->>'approved_rate_text', ''),
      coalesce(f->>'client_name', '') || ': ' || coalesce(f->>'approved_rate_text', '')
    );
    perform private.emit(
      'deal.closing_approved',
      p_request_id,
      v_req.kam_id,
      format('Treasury approved closing %s at %s. The agreed rate is unchanged and is on the write queue.',
             f->>'client_name', f->>'approved_rate_text'),
      format('ხაზინამ დაადასტურა დახურვა: %s, კურსი %s. შეთანხმებული კურსი იგივეა და გასაწერ რიგშია.',
             f->>'client_name', f->>'approved_rate_text'),
      f
    );
  exception when others then
    raise warning 'notification skipped: %', sqlerrm;
  end;

  return 'approved';
end;
$$;

comment on function public.treasury_approve_closing(bigint) is
  'Treasury or admin only. Moves an overdue held approval onto the write queue at the same rate, including one that already has an exception. Records who and when. Does not overwrite the first exception. Does not set rate_written_at, payment, or loss, and does not change the rate. One notice to the owning KAM. A second call returns unchanged.';

revoke all on function public.treasury_approve_closing(bigint) from public, anon;
grant execute on function public.treasury_approve_closing(bigint) to authenticated;

create or replace function public.treasury_record_closing_exception(
  p_request_id bigint,
  p_reason     text
)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me     uuid := private.my_profile_id();
  v_req    public.requests%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_id     bigint;
  f        jsonb;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'მხოლოდ ხაზინას შეუძლია ამ გარიგების დასტური' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) < 2 or length(v_reason) > 500 then
    raise exception 'ჩაწერეთ მიზეზი' using errcode = '22023';
  end if;

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  if v_req.closing_exception_at is not null
     or v_req.closing_approved_at is not null
     or v_req.rate_write_deferred is not true
     or v_req.rate_written_at is not null
     or v_req.payment_confirmed_at is not null then
    return 'unchanged';
  end if;
  if v_req.marked_lost_at is not null
     or v_req.loss_approved_at is not null
     or nullif(btrim(coalesce(v_req.loss_reason, '')), '') is not null then
    return 'unchanged';
  end if;
  if exists (
    select 1 from public.transactions t
    where t.client_id = v_req.client_id
      and t.tx_date = v_req.request_date
      and t.payment_status = 'SUCCESS'
      and (v_req.source = 'import' or t.tx_time >= v_req.requested_at - interval '1 minute')
  ) then
    return 'unchanged';
  end if;
  if v_req.client_reply is distinct from 'approved' or v_req.approved_rate is null then
    raise exception 'კლიენტს ჯერ არ დაუმტკიცებია კურსი' using errcode = '22023';
  end if;
  if v_req.client_replied_at is null
     or v_req.client_replied_at + interval '24 hours' >= now() then
    raise exception '24 საათი ჯერ არ გასულა' using errcode = '22023';
  end if;

  update public.requests r
     set closing_exception_at = now(),
         closing_exception_by = v_me,
         closing_exception_reason = v_reason
   where r.id = p_request_id
     and r.rate_write_deferred
     and r.closing_exception_at is null
     and r.closing_approved_at is null
     and r.rate_written_at is null
     and r.client_reply = 'approved'
     and r.approved_rate is not null
  returning r.id into v_id;

  if v_id is null then
    return 'unchanged';
  end if;

  begin
    f := private.request_facts(p_request_id);
    perform private.inbox_add(
      'kam', v_req.kam_id, 'deal.closing_exception', p_request_id,
      'ხაზინამ დახურვა ვერ დაადასტურა', 'Treasury could not approve closing',
      coalesce(f->>'client_name', '') || ': ' || v_reason,
      coalesce(f->>'client_name', '') || ': ' || v_reason
    );
    perform private.emit(
      'deal.closing_exception',
      p_request_id,
      v_req.kam_id,
      format('Treasury could not approve closing %s at %s. Reason: %s. The agreed rate is unchanged.',
             f->>'client_name', f->>'approved_rate_text', v_reason),
      format('ხაზინამ ვერ დაადასტურა დახურვა: %s, კურსი %s. მიზეზი: %s. შეთანხმებული კურსი იგივეა.',
             f->>'client_name', f->>'approved_rate_text', v_reason),
      f
    );
  exception when others then
    raise warning 'notification skipped: %', sqlerrm;
  end;

  return 'excepted';
end;
$$;

comment on function public.treasury_record_closing_exception(bigint, text) is
  'Treasury or admin only. Stores who, when, and why an overdue held deal cannot be closed the first time. Does not change the rate, the approval, or loss or payment fields. The row stays in the closing queue. A later approve keeps these three columns. One notice. A second call returns unchanged and does not overwrite them.';

revoke all on function public.treasury_record_closing_exception(bigint, text) from public, anon;
grant execute on function public.treasury_record_closing_exception(bigint, text) to authenticated;

-- One treasury notice when a hold becomes overdue. The queue does not
-- read closing_overdue_notified_at. Send both channels first. Stamp
-- only after both writes succeed, in this same subtransaction, so a
-- failure rolls the stamp and both writes back. A stamped row is
-- skipped. private.emit inserts a pending outbox row. It does not
-- confirm that Make.com delivered it. A row that is already released,
-- approved, or excepted is skipped.
create or replace function private.notify_closing_overdue()
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  r        record;
  v_id     bigint;
  v_sent   int;
  f        jsonb;
begin
  for r in
    select q.id
    from public.requests q
    where q.source = 'app'
      and q.rate_write_deferred
      and q.client_reply = 'approved'
      and q.approved_rate is not null
      and q.rate_written_at is null
      and q.payment_confirmed_at is null
      and q.marked_lost_at is null
      and q.loss_approved_at is null
      and nullif(btrim(coalesce(q.loss_reason, '')), '') is null
      and q.closing_approved_at is null
      and q.closing_exception_at is null
      and q.closing_overdue_notified_at is null
      and q.client_replied_at is not null
      and q.client_replied_at + interval '24 hours' < now()
      and not exists (
        select 1 from public.transactions t
        where t.client_id = q.client_id
          and t.tx_date = q.request_date
          and t.payment_status = 'SUCCESS'
          and (q.source = 'import' or t.tx_time >= q.requested_at - interval '1 minute')
      )
    order by q.id
  loop
    begin
      select q.id into v_id
      from public.requests q
      where q.id = r.id
        and q.rate_write_deferred
        and q.client_reply = 'approved'
        and q.approved_rate is not null
        and q.closing_approved_at is null
        and q.closing_exception_at is null
        and q.closing_overdue_notified_at is null
        and q.rate_written_at is null
        and q.payment_confirmed_at is null
        and q.client_replied_at + interval '24 hours' < now()
      for update;
      if v_id is not null then
      f := private.request_facts(r.id);
      perform private.inbox_add(
        'treasury', null, 'deal.closing_due', r.id,
        'დასახური გარიგება ელოდება დასტურს', 'A held deal needs closing approval',
        coalesce(f->>'kam_name', '') || ': ' || coalesce(f->>'client_name', '') || ' ' || coalesce(f->>'approved_rate_text', ''),
        coalesce(f->>'kam_name', '') || ': ' || coalesce(f->>'client_name', '') || ' ' || coalesce(f->>'approved_rate_text', '')
      );
      v_sent := private.emit(
        'deal.closing_due',
        r.id,
        (f->>'kam_id')::uuid,
        format('%s: %s has been held for 24 hours at %s and needs treasury to approve closing.',
               f->>'kam_name', f->>'client_name', f->>'approved_rate_text'),
        format('%s: %s 24 საათია დასახურია, კურსი %s. ხაზინის დასტური სჭირდება.',
               f->>'kam_name', f->>'client_name', f->>'approved_rate_text'),
        f
      );
      if coalesce(v_sent, 0) < 1 then
        raise exception 'closing outbox row was not written';
      end if;
      v_id := null;
      update public.requests q
         set closing_overdue_notified_at = now()
       where q.id = r.id
         and q.rate_write_deferred
         and q.client_reply = 'approved'
         and q.closing_approved_at is null
         and q.closing_exception_at is null
         and q.closing_overdue_notified_at is null
         and q.rate_written_at is null
         and q.payment_confirmed_at is null
         and q.client_replied_at + interval '24 hours' < now()
      returning q.id into v_id;
      if v_id is null then
        raise exception 'closing notice stamp missed';
      end if;
      end if;
    exception when others then
      raise warning 'closing notice skipped for %: %', r.id, sqlerrm;
    end;
  end loop;
end;
$$;

revoke all on function private.notify_closing_overdue() from public, anon, authenticated;

-- pg_cron is already used by this project. If this database does not have
-- it, the queue is still correct when it is read. The warning says to
-- schedule the same statement from the dashboard.
do $closing_cron$
declare
  v_jobid bigint;
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise warning 'pg_cron is not available (%). The closing queue is still derived in SQL. Schedule select private.notify_closing_overdue(); every minute so the notice fires with nobody online.', sqlerrm;
    return;
  end;
  for v_jobid in select j.jobid from cron.job j where j.jobname = 'kam-closing-overdue'
  loop
    perform cron.unschedule(v_jobid);
  end loop;
  perform cron.schedule(
    'kam-closing-overdue',
    '* * * * *',
    'select private.notify_closing_overdue()'
  );
exception when others then
  raise warning 'closing-overdue schedule was not saved (%). The closing queue is still derived in SQL. Schedule select private.notify_closing_overdue(); every minute so the notice fires with nobody online.', sqlerrm;
end
$closing_cron$;

-- Reconfirm existed only for the wrong rule that an expired quote window
-- blocked a held approval. Drop every signature. Do not recreate them.
do $drop_reconfirm$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('treasury_reconfirm_deferred', 'treasury_reconfirm_queue')
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end
$drop_reconfirm$;

drop function if exists public.treasury_reconfirm_deferred(bigint, int);
drop function if exists public.treasury_reconfirm_queue();

-- Direct table updates must not clear a hold, mark a held row written,
-- or change an agreed rate before it is written. The hold flag being
-- false does not open that rate. Security definer functions run as the
-- owner, so this guard lets them through, the same way
-- requests_guard_update does. It does not replace that trigger.
-- treasury_set_rate still refuses an agreed unwritten rate itself.
create or replace function private.guard_deferred_rate_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user is distinct from 'authenticated' then
    return new;
  end if;

  if new.rate_write_deferred is distinct from old.rate_write_deferred
     or new.deferred_released_at is distinct from old.deferred_released_at
     or new.deferred_released_by is distinct from old.deferred_released_by
     or new.closing_approved_at is distinct from old.closing_approved_at
     or new.closing_approved_by is distinct from old.closing_approved_by
     or new.closing_exception_at is distinct from old.closing_exception_at
     or new.closing_exception_by is distinct from old.closing_exception_by
     or new.closing_exception_reason is distinct from old.closing_exception_reason
     or new.closing_overdue_notified_at is distinct from old.closing_overdue_notified_at
  then
    raise exception 'გაწერის დროშა პირდაპირ არ იცვლება' using errcode = '42501';
  end if;

  if coalesce(old.rate_write_deferred, false) then
    if old.rate_written_at is null and new.rate_written_at is not null then
      raise exception 'KAM ჯერ არ გაუგზავნია ეს კურსი გასაწერად' using errcode = '22023';
    end if;
  end if;

  if coalesce(old.rate_write_deferred, false)
     or (
       old.client_reply = 'approved'
       and old.approved_rate is not null
       and old.rate_written_at is null
     ) then
    if new.rate is distinct from old.rate
       or new.approved_rate is distinct from old.approved_rate
       or new.rate_valid_until is distinct from old.rate_valid_until
       or new.quote_status is distinct from old.quote_status
       or new.client_reply is distinct from old.client_reply
       or new.client_replied_at is distinct from old.client_replied_at
    then
      raise exception 'შენახული კურსი პირდაპირ არ იცვლება' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.guard_deferred_rate_write() from public, anon, authenticated;

drop trigger if exists requests_guard_deferred_write on public.requests;
create trigger requests_guard_deferred_write
  before update on public.requests
  for each row execute function private.guard_deferred_rate_write();

-- Columns that existed only so treasury could reconfirm an expired hold.
-- Dropped after every function in this file has stopped reading them.
-- IF EXISTS keeps a database that never had them safe. No CASCADE:
-- if something outside this file still depends on a column, this stops.
alter table public.requests drop column if exists rate_reconfirm_required;
alter table public.requests drop column if exists deferred_quote_expired;
alter table public.requests drop column if exists rate_reconfirmed_at;
alter table public.requests drop column if exists rate_reconfirmed_by;
