-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Do not re-run 1_platform.sql. Not applied by this change.
-- Paste it before a KAM can save one of the new loss reasons.
--
-- Replaces the choices a KAM can mark. Does not update or delete
-- request rows. Older codes such as funds_not_received stay in
-- loss_reasons, so those rows still load. They are inactive, and a
-- new mark cannot use them.
--
-- loss_reason stays one of the eight codes. A better rate elsewhere
-- stores the place in the existing loss_reason_note: TBC, BOG,
-- Liberty, other bank, FX Hub, Cash exchange, or the typed comment.
-- Other stores its comment in that same note. No new column.
-- Treasury still approves the mark afterwards.

insert into public.loss_reasons (code, label_en, label_ka, sort_order, active) values
  ('better_rate',       'Better rate elsewhere',    'სხვაგან უკეთესი კურსი',        10, true),
  ('postponed',         'Postponed',                'გადადო',                       20, true),
  ('did_not_specify',   'Did not specify reason',   'მიზეზი არ დაუზუსტებია',        30, true),
  ('client_financial',  'Client financial issues',  'კლიენტის ფინანსური პრობლემა',  40, true),
  ('bank_blocked',      'Bank blocked transfer',    'ბანკმა გადარიცხვა დაბლოკა',    50, true),
  ('liquidity',         'Our liquidity issue',      'ჩვენი ლიკვიდობის პრობლემა',    60, true),
  ('timing',            'Our timing issue',         'ჩვენი დროის პრობლემა',         70, true),
  ('other',             'Other (specify)',          'სხვა (მიუთითეთ)',              80, true)
on conflict (code) do update
  set label_en = excluded.label_en,
      label_ka = excluded.label_ka,
      sort_order = excluded.sort_order,
      active = true;

update public.loss_reasons
   set active = false
 where code not in (
   'better_rate',
   'postponed',
   'did_not_specify',
   'client_financial',
   'bank_blocked',
   'liquidity',
   'timing',
   'other'
 );

-- The note to store, or null when the reason has no note.
-- Raises when the code is not one a KAM may mark now.
create or replace function private.loss_mark_note(p_reason text, p_detail text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(p_reason), '');
  v_detail text := nullif(btrim(p_detail), '');
begin
  if v_reason is null then
    raise exception 'მიზეზი აუცილებელია, სანამ ხაზინას გაეგზავნება' using errcode = '22023';
  end if;
  if v_reason not in (
    'better_rate',
    'postponed',
    'did_not_specify',
    'client_financial',
    'bank_blocked',
    'liquidity',
    'timing',
    'other'
  ) then
    raise exception 'მიზეზი ვერ მოიძებნა' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.loss_reasons l where l.code = v_reason and l.active
  ) then
    raise exception 'მიზეზი ვერ მოიძებნა' using errcode = '22023';
  end if;
  if v_reason = 'better_rate' and v_detail is null then
    raise exception 'უკეთესი კურსის ადგილი აუცილებელია, სანამ ხაზინას გაეგზავნება' using errcode = '22023';
  end if;
  if v_reason = 'other' and v_detail is null then
    raise exception 'სხვა მიზეზს კომენტარი სჭირდება' using errcode = '22023';
  end if;
  if length(coalesce(v_detail, '')) > 500 then
    raise exception 'კომენტარი ძალიან გრძელია' using errcode = '22023';
  end if;
  if v_reason in ('better_rate', 'other') then
    return v_detail;
  end if;
  return null;
end;
$$;

revoke all on function private.loss_mark_note(text, text) from public, anon, authenticated;

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
  v_rate_written timestamptz;
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
    r.rate_written_at,
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
    v_rate_written,
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
     or v_rate_written is not null
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

create or replace function public.correct_request_outcome(
  p_request_id bigint,
  p_outcome    text,
  p_reason     text default null,
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
  v_source       text;
  v_confirmed    timestamptz;
  v_marked       timestamptz;
  v_loss_reason  text;
  v_rate_written timestamptz;
  v_import_key   text;
  v_legacy       text;
  v_client       text;
  v_date         date;
  v_requested    timestamptz;
  v_target       text := nullif(btrim(p_outcome), '');
  v_reason       text := nullif(btrim(p_reason), '');
  v_detail       text := nullif(btrim(p_detail), '');
  v_note         text := null;
  v_lost         boolean := false;
  v_system       boolean := false;
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  if private.my_role() is distinct from 'admin' and private.my_role() is distinct from 'kam' then
    raise exception 'მხოლოდ KAM-ს ან ადმინს შეუძლია სტატუსის გასწორება' using errcode = '42501';
  end if;
  if not private.can_write() then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;
  if v_target is distinct from 'went_through'
     and v_target is distinct from 'lost'
     and v_target is distinct from 'clear' then
    raise exception 'სტატუსი ვერ მოიძებნა' using errcode = '22023';
  end if;

  select
    r.kam_id,
    r.source,
    r.payment_confirmed_at,
    r.marked_lost_at,
    r.loss_reason,
    r.rate_written_at,
    r.import_key,
    r.legacy_status,
    r.client_id,
    r.request_date,
    r.requested_at
    into
    v_kam,
    v_source,
    v_confirmed,
    v_marked,
    v_loss_reason,
    v_rate_written,
    v_import_key,
    v_legacy,
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
    raise exception 'მხოლოდ აპის მოთხოვნის სტატუსი შეიძლება გასწორდეს' using errcode = '22023';
  end if;

  v_lost := v_marked is not null or nullif(btrim(coalesce(v_loss_reason, '')), '') is not null;
  if v_confirmed is null and not v_lost then
    raise exception 'ეს სტატუსი KAM-მა ან ადმინმა არ მონიშნა' using errcode = '22023';
  end if;

  v_system := v_rate_written is not null
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
    );

  if v_target = 'lost' and (v_system or v_rate_written is not null) then
    raise exception 'წარმატებული გადახდა ან გაწერილი კურსი ამ სტატუსს ადგენს. დაკარგულად ვერ შეიცვლება' using errcode = '22023';
  end if;
  if v_target = 'clear' and v_system and not v_lost then
    raise exception 'წარმატებული გადახდა ან გაწერილი კურსი ამ სტატუსს ადგენს' using errcode = '22023';
  end if;

  if v_target = 'lost' then
    v_note := private.loss_mark_note(v_reason, v_detail);
  end if;

  update public.requests r
     set payment_confirmed_at = case
           when v_target = 'went_through' and not v_system then coalesce(r.payment_confirmed_at, now())
           when v_target = 'went_through' then r.payment_confirmed_at
           else null
         end,
         payment_confirmed_by = case
           when v_target = 'went_through' and not v_system then coalesce(r.payment_confirmed_by, v_me)
           when v_target = 'went_through' then r.payment_confirmed_by
           else null
         end,
         marked_lost_at = case when v_target = 'lost' then now() else null end,
         marked_lost_by = case when v_target = 'lost' then v_me else null end,
         loss_reason = case when v_target = 'lost' then v_reason else null end,
         loss_reason_at = case when v_target = 'lost' then now() else null end,
         loss_reason_note = case when v_target = 'lost' then v_note else null end,
         loss_approved_at = null,
         loss_approved_by = null,
         loss_approval_comment = null
   where r.id = p_request_id;
end;
$$;

revoke all on function public.correct_request_outcome(bigint, text, text, text) from public, anon;
grant execute on function public.correct_request_outcome(bigint, text, text, text) to authenticated;

comment on function public.correct_request_outcome(bigint, text, text, text) is
  'Correct a KAM or admin mark of went-through or lost. p_outcome is went_through, lost, or clear. Lost uses the same reason as mark_request_lost. A better rate elsewhere stores the place in loss_reason_note. A written rate or a SUCCESS payment cannot be turned into a loss. Does not change rate_written_at and does not delete the request.';

create or replace function public.set_loss_reason(
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
  v_me      uuid := private.my_profile_id();
  v_row     public.request_outcomes%rowtype;
  v_reason  text := nullif(btrim(p_reason), '');
  v_detail  text := nullif(btrim(p_detail), '');
  v_note    text := null;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;
  select * into v_row from public.request_outcomes o where o.id = p_request_id;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_row.kam_id <> v_me and not private.is_admin() then
    raise exception 'This request belongs to another KAM' using errcode = '42501';
  end if;
  if v_row.outcome <> 'did_not_go_through' then
    raise exception 'Only requests that did not go through need a reason' using errcode = '22023';
  end if;
  if v_reason is not null then
    v_note := private.loss_mark_note(v_reason, v_detail);
  end if;

  update public.requests r
     set loss_reason = v_reason,
         loss_reason_at = case when v_reason is null then null else now() end,
         loss_reason_note = case when v_reason is null then null else v_note end
   where r.id = p_request_id;
end;
$$;

revoke all on function public.set_loss_reason(bigint, text, text) from public, anon;
grant execute on function public.set_loss_reason(bigint, text, text) to authenticated;
