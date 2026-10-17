-- Paste this in the Supabase SQL editor after 55_loss_reasons.sql.
-- If you paste 55 again later, paste this file again afterwards.
-- Do not paste 45 again. Do not edit 49–55.
-- Safe to paste again. It does not rewrite historical rows.
-- It does not replace client_request_history (that OUT row stays as SQL 45).
-- It does not change private.request_display_class or won/lost analytics.
--
-- A row qualifies when the client approved (client_reply = approved,
-- including a held "do not write yet" approval) and a loss was recorded
-- at or after client_replied_at:
--   marked_lost_at, or a non-blank loss_reason with loss_reason_at,
--   or loss_approved_at.
-- rate_written_at may be null or set. A decline and a better-rate ask
-- do not qualify. A loss timestamp before the approval does not qualify.
--
-- The read returns one client: the flag, the count, the latest time,
-- and the request ids so history can mark those rows. It does not
-- return rates, amounts, or client_reply.
--
-- mark_request_lost may now mark a request whose rate is already written,
-- while payment_confirmed_at is still null. A payment confirmation, a
-- bank SUCCESS, and an agreement-file win still cannot be marked lost.
-- approve_request_loss may approve that same explicit mark. A written
-- rate with no loss mark is still not a loss.

create or replace function public.client_agreed_then_lost(p_client_id text)
returns table (
  agreed_then_lost boolean,
  loss_count bigint,
  latest_at timestamptz,
  latest_request_id bigint,
  request_ids bigint[]
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
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  if v_role not in ('kam', 'admin', 'manager', 'treasury') then
    raise exception 'ამ ანგარიშს კლიენტის შეჯამება არ აქვს' using errcode = '42501';
  end if;
  if v_id !~ '^([0-9]{9}|[0-9]{11})$' then
    agreed_then_lost := false;
    loss_count := 0;
    latest_at := null;
    latest_request_id := null;
    request_ids := array[]::bigint[];
    return next;
    return;
  end if;

  return query
  with hit as (
    select
      r.id,
      coalesce(r.marked_lost_at, r.loss_reason_at, r.loss_approved_at) as lost_at
    from public.requests r
    where r.client_id = v_id
      and r.client_reply = 'approved'
      and r.client_replied_at is not null
      and (
        (r.marked_lost_at is not null and r.marked_lost_at >= r.client_replied_at)
        or (
          nullif(btrim(coalesce(r.loss_reason, '')), '') is not null
          and r.loss_reason_at is not null
          and r.loss_reason_at >= r.client_replied_at
        )
        or (r.loss_approved_at is not null and r.loss_approved_at >= r.client_replied_at)
      )
  )
  select
    (count(*) > 0),
    count(*)::bigint,
    max(hit.lost_at),
    (array_agg(hit.id order by hit.lost_at desc nulls last, hit.id desc))[1],
    coalesce(array_agg(hit.id order by hit.lost_at desc nulls last, hit.id desc), array[]::bigint[])
  from hit;
end;
$$;

comment on function public.client_agreed_then_lost(text) is
  'Display mark for one client. True when the client approved and that request was later lost, whether or not the rate was written. Returns the flag, the count, the latest loss time, and the request ids. Does not change request_display_class and does not write.';

revoke all on function public.client_agreed_then_lost(text) from public, anon;
grant execute on function public.client_agreed_then_lost(text) to authenticated;

-- Same body as 55_loss_reasons.sql, except a written rate is no longer a refusal.
-- payment_confirmed_at, a bank SUCCESS, and an agreement-file win still refuse.
-- Uses private.loss_mark_note from 55. Paste 55 first.
create or replace function public.mark_request_lost(
  p_request_id bigint,
  p_reason     text,
  p_detail     text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me           uuid := private.my_profile_id();
  v_kam          uuid;
  v_marked       timestamptz;
  v_approved     timestamptz;
  v_confirmed    timestamptz;
  v_import_key   text;
  v_legacy       text;
  v_source       text;
  v_client       text;
  v_date         date;
  v_requested    timestamptz;
  v_reason       text := nullif(btrim(p_reason), '');
  v_detail       text := nullif(btrim(p_detail), '');
  v_note         text;
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  if private.my_role() is distinct from 'admin' and private.my_role() is distinct from 'kam' then
    raise exception 'მხოლოდ KAM-ს ან ადმინს შეუძლია მოთხოვნის დაკარგულად მონიშვნა' using errcode = '42501';
  end if;
  if not private.can_write() then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;

  v_note := private.loss_mark_note(v_reason, v_detail);

  select
    r.kam_id,
    r.marked_lost_at,
    r.loss_approved_at,
    r.payment_confirmed_at,
    r.import_key,
    r.legacy_status,
    r.source,
    r.client_id,
    r.request_date,
    r.requested_at
    into
    v_kam,
    v_marked,
    v_approved,
    v_confirmed,
    v_import_key,
    v_legacy,
    v_source,
    v_client,
    v_date,
    v_requested
  from public.requests r
  where r.id = p_request_id
  for update;

  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  if v_kam is distinct from v_me and not private.is_admin() then
    raise exception 'ეს მოთხოვნა სხვა KAM-ისაა' using errcode = '42501';
  end if;
  if v_source is distinct from 'app' then
    raise exception 'მხოლოდ აპის მოთხოვნა შეიძლება მოინიშნოს დაკარგულად' using errcode = '22023';
  end if;
  if v_marked is not null then
    return;
  end if;
  if v_approved is not null then
    raise exception 'ეს დანაკარგი უკვე დადასტურებულია' using errcode = '22023';
  end if;
  if v_confirmed is not null
     or (v_import_key like 'agreement:%' and v_legacy = 'შესრულდა')
     or exists (
       select 1
       from public.transactions t
       where t.payment_status = 'SUCCESS'
         and (
           (
             t.tx_id is not null
             and t.client_id = v_client
             and t.tx_date = v_date
             and t.tx_time >= v_requested - interval '1 minute'
           )
           or t.matched_request_id = p_request_id
         )
     )
  then
    raise exception 'ეს მოთხოვნა უკვე გავიდა' using errcode = '22023';
  end if;

  update public.requests r
     set marked_lost_at = now(),
         marked_lost_by = v_me,
         loss_reason = v_reason,
         loss_reason_at = now(),
         loss_reason_note = v_note
   where r.id = p_request_id;
end;
$$;

revoke all on function public.mark_request_lost(bigint, text, text) from public, anon;
grant execute on function public.mark_request_lost(bigint, text, text) to authenticated;

comment on function public.mark_request_lost(bigint, text, text) is
  'KAM or admin marks a request lost with a reason. A written rate can be marked lost until the client is notified. A payment confirmation, a bank SUCCESS, and an agreement-file win still cannot. Does not clear rate_written_at and does not change request_display_class.';

-- Treasury can approve an explicit loss mark even when the rate was written,
-- until the client has been notified. A written rate with no loss mark stays a win.
create or replace function public.approve_request_loss(p_request_id bigint, p_comment text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me      uuid := private.my_profile_id();
  v_req     public.requests%rowtype;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_loss    boolean;
  v_explicit boolean;
begin
  if v_me is null or private.my_role() not in ('treasury', 'admin') then
    raise exception 'მხოლოდ ხაზინას შეუძლია დანაკარგის დადასტურება' using errcode = '42501';
  end if;
  if private.my_role() = 'kam' then
    raise exception 'კამ-ს არ შეუძლია საკუთარი დანაკარგის დადასტურება' using errcode = '42501';
  end if;
  if v_comment is not null and length(v_comment) > 500 then
    raise exception 'კომენტარი ძალიან გრძელია' using errcode = '22023';
  end if;

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  v_explicit := v_req.marked_lost_at is not null
    or nullif(btrim(coalesce(v_req.loss_reason, '')), '') is not null;
  if v_req.rate_written_at is not null and not v_explicit then
    raise exception 'გაწერილი კურსი ნიშნავს, რომ გარიგება გავიდა' using errcode = '22023';
  end if;
  if v_req.payment_confirmed_at is not null then
    raise exception 'ტრანზაქცია გავიდა, ეს დანაკარგი არ არის' using errcode = '22023';
  end if;
  if v_req.source is distinct from 'app' then
    raise exception 'ეს მოთხოვნა დაკარგული არ არის' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.transactions t
    where t.payment_status = 'SUCCESS'
      and (
        (
          t.tx_id is not null
          and t.client_id = v_req.client_id
          and t.tx_date = v_req.request_date
          and t.tx_time >= v_req.requested_at - interval '1 minute'
        )
        or t.matched_request_id = p_request_id
      )
  ) then
    raise exception 'ეს მოთხოვნა უკვე გავიდა' using errcode = '22023';
  end if;

  v_loss := v_explicit
    or (
      v_req.rate_written_at is null
      and not (v_req.client_reply = 'better' and v_req.better_decision is null)
      and (
        v_req.client_reply = 'declined'
        or v_req.quote_status = 'declined'
        or v_req.request_date < coalesce(private.freshness_date(), v_req.request_date)
      )
    );

  if not v_loss then
    raise exception 'ეს მოთხოვნა დაკარგული არ არის' using errcode = '22023';
  end if;

  update public.requests r
     set loss_approved_at = now(),
         loss_approved_by = v_me,
         loss_approval_comment = v_comment
   where r.id = p_request_id;

  if v_req.kam_id is not null then
    begin
      perform private.inbox_add(
        'kam', v_req.kam_id, 'loss.approved', p_request_id,
        'ხაზინამ დანაკარგი დაადასტურა',
        'Treasury approved the loss',
        coalesce(v_comment, ''),
        coalesce(v_comment, '')
      );
    exception when others then
      raise warning 'inbox skipped: %', sqlerrm;
    end;
  end if;
end;
$$;

revoke all on function public.approve_request_loss(bigint, text) from public, anon;
grant execute on function public.approve_request_loss(bigint, text) to authenticated;

comment on function public.approve_request_loss(bigint, text) is
  'Treasury or an admin approves a loss. An explicit mark can be approved after the rate was written and before the client was notified. A written rate with no loss mark is still not a loss. Does not clear rate_written_at and does not change request_display_class.';
