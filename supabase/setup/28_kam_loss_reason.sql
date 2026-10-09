-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 26_desk_and_history.sql. Do not re-run 1_platform.sql.
-- If you paste 26 again later, paste this file once more afterwards.
--
-- A KAM (own request) or an admin marks a request lost only with a reason.
-- The request reaches treasury after that reason is saved. Other requires
-- a written comment. The four reasons below are inserted only when missing.

insert into public.loss_reasons (code, label_en, label_ka, sort_order) values
  ('better_rate',        'Better rate elsewhere', 'სხვაგან უკეთესი კურსი', 10),
  ('postponed',          'Postponed',             'გადადო',                20),
  ('funds_not_received', 'Funds not received',    'თანხა არ ჩაურიცხავს',   30),
  ('other',              'Other',                 'სხვა',                  90)
on conflict (code) do nothing;

drop function if exists public.mark_request_lost(bigint);

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
  v_other        boolean := false;
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
  if v_reason is null then
    raise exception 'მიზეზი აუცილებელია, სანამ სახაზინოს გაეგზავნება' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.loss_reasons l where l.code = v_reason and l.active
  ) then
    raise exception 'მიზეზი ვერ მოიძებნა' using errcode = '22023';
  end if;

  select v_reason = 'other' or lower(btrim(l.label_en)) = 'other'
    into v_other
  from public.loss_reasons l
  where l.code = v_reason;

  if v_other and v_detail is null then
    raise exception 'სხვა მიზეზს კომენტარი სჭირდება' using errcode = '22023';
  end if;
  if length(coalesce(v_detail, '')) > 500 then
    raise exception 'კომენტარი ძალიან გრძელია' using errcode = '22023';
  end if;

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
         loss_reason_note = case when v_other then v_detail else null end
   where r.id = p_request_id;
end;
$$;

revoke all on function public.mark_request_lost(bigint, text, text) from public, anon;
grant execute on function public.mark_request_lost(bigint, text, text) to authenticated;
