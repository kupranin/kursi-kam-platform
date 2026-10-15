-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 39_push_subscriptions.sql. Do not re-run 1_platform.sql.
-- Do not delete requests. Do not insert a transactions row.
-- Does not change log_request, confirm_request_payment, or mark_request_lost.
--
-- confirm_request_payment and mark_request_lost refuse to change a mark
-- that is already saved. This function corrects that mark.
-- A KAM can correct their own request. An admin can correct any.
-- Treasury, a manager, and an analyst cannot. View-as is not a role.
--
-- The mark is payment_confirmed_at (the KAM or admin said it went through)
-- or marked_lost_at / loss_reason (they said it was lost).
-- A written rate, a SUCCESS payment, or an agreement-file win is not that
-- mark. Those still mean the deal went through, and this function will
-- not turn them into a loss. It does not set or clear rate_written_at.

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
  v_other        boolean := false;
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
    if v_reason is null then
      raise exception 'მიზეზი აუცილებელია, სანამ ხაზინას გაეგზავნება' using errcode = '22023';
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
         loss_reason_note = case when v_target = 'lost' and v_other then v_detail else null end,
         loss_approved_at = null,
         loss_approved_by = null,
         loss_approval_comment = null
   where r.id = p_request_id;
end;
$$;

revoke all on function public.correct_request_outcome(bigint, text, text, text) from public, anon;
grant execute on function public.correct_request_outcome(bigint, text, text, text) to authenticated;

comment on function public.correct_request_outcome(bigint, text, text, text) is
  'Correct a KAM or admin mark of went-through or lost. p_outcome is went_through, lost, or clear. Lost uses the same reason as mark_request_lost. A written rate or a SUCCESS payment cannot be turned into a loss. Does not change rate_written_at and does not delete the request.';
