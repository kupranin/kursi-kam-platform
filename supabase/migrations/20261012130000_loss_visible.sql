-- A same-day KAM loss stays visible until treasury or an admin approves it.
-- Same statements as supabase/setup/32_loss_visible.sql.

create or replace function private.request_loss_state(p_id bigint)
returns table (
  loss_candidate boolean,
  loss_open boolean,
  approver_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    flag.loss_candidate,
    (flag.loss_candidate and r.loss_approved_at is null) as loss_open,
    ap.full_name
  from public.requests r
  left join public.profiles ap on ap.id = r.loss_approved_by
  cross join lateral (
    select
      (r.rate_written_at is not null) as rate_written,
      exists (
        select 1
        from public.transactions t
        where t.payment_status = 'SUCCESS'
          and (
            (
              t.tx_id is not null
              and t.client_id = r.client_id
              and t.tx_date = r.request_date
              and (r.source = 'import' or t.tx_time >= r.requested_at - interval '1 minute')
            )
            or t.matched_request_id = r.id
          )
      ) as tx_hit,
      (r.import_key like 'agreement:%' and r.legacy_status = 'შესრულდა') as file_won
  ) w
  cross join lateral (
    select (
      r.source = 'app'
      and r.payment_confirmed_at is null
      and not w.rate_written
      and not w.tx_hit
      and not w.file_won
      and (
        r.marked_lost_at is not null
        or nullif(btrim(coalesce(r.loss_reason, '')), '') is not null
        or (
          not (r.client_reply = 'better' and r.better_decision is null)
          and (
            r.client_reply = 'declined'
            or r.quote_status = 'declined'
            or r.request_date < coalesce(private.freshness_date(), r.request_date)
          )
        )
      )
    ) as loss_candidate
  ) flag
  where r.id = p_id;
$$;

revoke all on function private.request_loss_state(bigint) from public, anon, authenticated;

-- Output columns stay in the same order. marked_lost is only used inside
-- the case, so the view list does not grow.
create or replace view public.request_outcomes
with (security_invoker = true)
as
select
  b.id,
  b.kam_id,
  b.kam_name,
  b.client_id,
  b.client_name,
  b.client_kind,
  b.requested_at,
  b.request_date,
  b.sells_currency,
  b.gets_currency,
  b.amount,
  b.rate,
  b.note,
  b.loss_reason,
  b.loss_reason_at,
  b.source,
  (b.rate_written or b.payment_confirmed or b.tx_hit or b.file_won) as went_through,
  case
    when b.rate_written or b.payment_confirmed or b.tx_hit or b.file_won then 'went_through'
    when b.marked_lost and b.loss_approved_at is null then 'waiting'
    when b.marked_lost then 'did_not_go_through'
    when b.client_reply = 'better' and b.better_decision is null then 'waiting'
    when b.loss_candidate and b.loss_approved_at is null then 'waiting'
    when b.loss_candidate then 'did_not_go_through'
    when b.file_lost then 'did_not_go_through'
    when b.file_open then 'waiting'
    when b.request_date >= coalesce(private.freshness_date(), b.request_date) then 'waiting'
    else 'did_not_go_through'
  end as outcome,
  b.asked_at,
  b.quote_status,
  b.rate_valid_until,
  b.quoted_at,
  b.decline_reason,
  case
    when b.quote_status = 'quoted' and b.rate_valid_until is not null and b.rate_valid_until < now() then 'expired'
    else b.quote_status
  end as quote_state,
  b.gets_amount,
  b.client_rate,
  b.loss_reason_note,
  b.client_reply,
  b.approved_rate,
  b.wanted_rate,
  b.better_decision,
  b.given_rate,
  b.client_decline_reason,
  b.client_replied_at,
  b.better_decided_at,
  b.bank,
  b.rate_written_at,
  b.loss_approved_at,
  b.loss_approved_by,
  b.loss_approval_comment,
  b.loss_approver_name,
  (b.loss_candidate and b.loss_approved_at is null) as loss_open,
  b.payment_confirmed_at,
  b.payment_confirmed_by
from (
  select
    r.id,
    r.kam_id,
    p.full_name as kam_name,
    r.client_id,
    c.name as client_name,
    c.kind as client_kind,
    r.requested_at,
    r.request_date,
    r.sells_currency,
    r.gets_currency,
    r.amount,
    r.rate,
    r.note,
    r.loss_reason,
    r.loss_reason_at,
    r.source,
    r.asked_at,
    r.quote_status,
    r.rate_valid_until,
    r.quoted_at,
    r.decline_reason,
    r.gets_amount,
    r.client_rate,
    r.loss_reason_note,
    r.client_reply,
    r.approved_rate,
    r.wanted_rate,
    r.better_decision,
    r.given_rate,
    r.client_decline_reason,
    r.client_replied_at,
    r.better_decided_at,
    case
      when r.banks is not null and cardinality(r.banks) > 0 then (
        select string_agg(x, ', ' order by array_position(array['TBC', 'BOG', 'Liberty']::text[], x))
        from (
          select distinct btrim(u.x) as x
          from unnest(r.banks) as u(x)
        ) s
        where x in ('TBC', 'BOG', 'Liberty')
      )
      else r.bank
    end as bank,
    r.rate_written_at,
    r.payment_confirmed_at,
    r.payment_confirmed_by,
    r.loss_approved_at,
    r.loss_approved_by,
    r.loss_approval_comment,
    ap.full_name as loss_approver_name,
    (r.marked_lost_at is not null) as marked_lost,
    w.rate_written,
    w.payment_confirmed,
    w.tx_hit,
    w.file_won,
    w.file_lost,
    w.file_open,
    (
      r.source = 'app'
      and not w.rate_written
      and not w.payment_confirmed
      and not w.tx_hit
      and not w.file_won
      and (
        r.marked_lost_at is not null
        or nullif(btrim(coalesce(r.loss_reason, '')), '') is not null
        or (
          not (r.client_reply = 'better' and r.better_decision is null)
          and (
            r.client_reply = 'declined'
            or r.quote_status = 'declined'
            or r.request_date < coalesce(private.freshness_date(), r.request_date)
          )
        )
      )
    ) as loss_candidate
  from public.requests r
  join public.clients c on c.client_id = r.client_id
  left join public.profiles p on p.id = r.kam_id
  left join public.profiles ap on ap.id = r.loss_approved_by
  cross join lateral (
    select
      (r.rate_written_at is not null) as rate_written,
      (r.payment_confirmed_at is not null) as payment_confirmed,
      exists (
        select 1
        from public.transactions t
        where t.payment_status = 'SUCCESS'
          and (
            (
              t.tx_id is not null
              and t.client_id = r.client_id
              and t.tx_date = r.request_date
              and (r.source = 'import' or t.tx_time >= r.requested_at - interval '1 minute')
            )
            or t.matched_request_id = r.id
          )
      ) as tx_hit,
      (r.import_key like 'agreement:%' and r.legacy_status = 'შესრულდა') as file_won,
      (r.import_key like 'agreement:%' and r.legacy_status in (
          'არ შესრულდა',
          'ბანკმა გააჩერა ტრანზაქცია',
          'აღარ დასჭირდა და გააუქმა',
          'უარი თქვა, მცირედი განსხვავების გამო ბანკში ურჩევნოდა კონვერტაცია'
      )) as file_lost,
      (r.import_key like 'agreement:%' and (
          r.legacy_status is null
          or r.legacy_status in (
          'შესრულდა ნაწილობრივ',
          'შეთანხმებულია და გაწერეთ კურსი'
          )
      )) as file_open
  ) w
) b;


revoke all on public.request_outcomes from anon;
grant select on public.request_outcomes to authenticated;

-- Treasury or an admin, by the real database role. A KAM cannot approve.
-- The comment is optional. This does not delete the row and does not
-- clear rate_written_at.
create or replace function public.approve_request_loss(p_request_id bigint, p_comment text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me      uuid := private.my_profile_id();
  v_req     public.requests%rowtype;
  v_state   record;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_marked  boolean;
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

  v_marked := v_req.marked_lost_at is not null
    or nullif(btrim(coalesce(v_req.loss_reason, '')), '') is not null;

  select s.loss_candidate, s.loss_open into v_state
  from private.request_loss_state(p_request_id) s;

  if not v_marked and coalesce(v_state.loss_candidate, false) is not true then
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
