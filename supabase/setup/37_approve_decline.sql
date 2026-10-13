-- Paste this in the Supabase SQL editor. Safe to run again.
-- Only replaces approve_request_loss. It does not change the analysis view.
-- A client decline is a loss even when the KAM did not choose a reason.
-- That is why Mikheil Tsitsishvili showed "ეს მოთხოვნა დაკარგული არ არის".

create or replace function public.approve_request_loss(p_request_id bigint, p_comment text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me      uuid := private.my_profile_id();
  v_req     public.requests%rowtype;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_loss    boolean;
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
  if v_req.rate_written_at is not null then
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

  v_loss := v_req.marked_lost_at is not null
    or nullif(btrim(coalesce(v_req.loss_reason, '')), '') is not null
    or (
      not (v_req.client_reply = 'better' and v_req.better_decision is null)
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
