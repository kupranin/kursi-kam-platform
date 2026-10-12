-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 31_treasury_deal_comment.sql. Do not re-run 1_platform.sql.
-- If you paste 21_delete_and_loss_approval.sql, 23_kam_confirm_payment.sql,
-- or 26_desk_and_history.sql again, paste this file once more afterwards.
-- Do not drop requests. Do not delete rows. Do not DROP VIEW CASCADE.
-- Do not reorder or drop columns of request_outcomes.
--
-- A KAM mark already stored as marked_lost_at or loss_reason is a loss.
-- This reads those rows as they are. It does not update them and does not
-- require them to be marked again. There is no "today only" cutoff, so a
-- mark from 7 October 2026 onward is included as soon as this paste runs.
-- It stays on treasury's lost list (დაკარგული მოთხოვნები) until treasury
-- or an admin approves it. Approving sets loss_approved_at and the deal
-- leaves that list. The row is not deleted. There is no list of past
-- approvals there. loss_open is only the loss that is still waiting.
-- On the request analysis list the same mark is already "lost", on the
-- Asia/Tbilisi day of marked_lost_at (or loss_reason_at). The bank
-- turnover screen counts payments, not these requests.
-- A written rate or payment_confirmed_at is a success, not a loss.
-- Treasury is private.my_role() = treasury. Admin is private.my_role() = admin.
-- View-as does not change that. A KAM cannot approve. An analyst cannot.

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

-- Request analysis (ანალიზი). Same columns, same order, as
-- 31_treasury_deal_comment.sql. A mark already saved on the row is lost
-- now, including one treasury has not approved. The date on that row is
-- the Asia/Tbilisi day of the mark, so 7–12 October 2026 stay in that
-- range. A written rate or a confirmed payment stays success.
create or replace view public.analyst_deals
with (security_invoker = false, security_barrier = true)
as
select
  d.id,
  d.request_date,
  d.kam_name,
  d.client_id,
  d.client_name,
  d.sells_currency,
  d.sell_amount,
  d.gets_currency,
  d.gets_amount,
  d.rate,
  d.amount_gel,
  d.gel_amount,
  d.status,
  case when d.status = 'lost' or d.rate_written or d.payment_confirmed then d.reason else null end as loss_reason,
  d.first_response_minutes,
  d.rate_write_minutes,
  d.quoted_by_name,
  d.treasury_comment,
  d.deal_comment,
  d.loss_phase
from (
  select
    r.id,
    case
      when r.rate_written_at is null
       and r.payment_confirmed_at is null
       and not w.tx_hit
       and not w.file_won
       and (
         r.marked_lost_at is not null
         or nullif(btrim(coalesce(r.loss_reason, '')), '') is not null
       )
      then coalesce(
        (r.marked_lost_at at time zone 'Asia/Tbilisi')::date,
        (r.loss_reason_at at time zone 'Asia/Tbilisi')::date,
        r.request_date
      )
      else r.request_date
    end as request_date,
    p.full_name as kam_name,
    r.client_id,
    cl.name as client_name,
    r.sells_currency,
    r.amount as sell_amount,
    r.gets_currency,
    r.gets_amount,
    coalesce(r.approved_rate, r.rate) as rate,
    coalesce(
      r.gel_amount,
      private.request_gel(
        r.sells_currency, r.gets_currency, r.amount, r.gets_amount, coalesce(r.approved_rate, r.rate)
      )
    ) as amount_gel,
    r.gel_amount,
    (r.rate_written_at is not null) as rate_written,
    (r.payment_confirmed_at is not null) as payment_confirmed,
    case
      when r.rate_written_at is not null or r.payment_confirmed_at is not null then 'success'
      when w.tx_hit or w.file_won then 'success'
      when r.marked_lost_at is not null
        or nullif(btrim(coalesce(r.loss_reason, '')), '') is not null then 'lost'
      when r.client_reply = 'better' and r.better_decision is null then 'open'
      when lc.loss_candidate and r.loss_approved_at is null then 'open'
      when lc.loss_candidate then 'lost'
      when w.file_lost then 'lost'
      when w.file_open then 'open'
      when r.request_date >= coalesce(private.freshness_date(), r.request_date) then 'open'
      else 'lost'
    end as status,
    nullif(concat_ws(
      '. ',
      nullif(btrim(coalesce(lr.label_ka, r.legacy_loss_reason)), ''),
      nullif(btrim(r.loss_reason_note), ''),
      nullif(btrim(r.client_decline_reason), ''),
      nullif(btrim(r.decline_reason), '')
    ), '') as reason,
    private.first_response_minutes(r.id, r.asked_at, r.requested_at, r.quoted_at, r.source) as first_response_minutes,
    private.rate_write_minutes(r.client_reply, r.client_replied_at, r.rate_written_at, r.source) as rate_write_minutes,
    nullif(btrim(qb.full_name), '') as quoted_by_name,
    nullif(btrim(r.loss_approval_comment), '') as treasury_comment,
    nullif(btrim(r.treasury_deal_comment), '') as deal_comment,
    case
      when r.rate_written_at is not null or r.payment_confirmed_at is not null then null
      when w.tx_hit or w.file_won then null
      when r.marked_lost_at is null
       and nullif(btrim(coalesce(r.loss_reason, '')), '') is null then null
      when r.loss_approved_at is null then 'waiting'
      else 'approved'
    end as loss_phase
  from public.requests r
  join public.clients cl on cl.client_id = r.client_id
  left join public.profiles p on p.id = r.kam_id
  left join public.profiles qb on qb.id = r.quoted_by
  left join public.loss_reasons lr on lr.code = r.loss_reason
  cross join lateral (
    select
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
  cross join lateral (
    select (
      r.source = 'app'
      and r.rate_written_at is null
      and r.payment_confirmed_at is null
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
  ) lc
) d
where private.my_role() in ('analyst', 'admin', 'treasury');

comment on view public.analyst_deals is
  'Every request for an analyst, an admin, or treasury. The analyst only reads this list. A written rate is success. A KAM or admin confirmation that the payment went through is success too. A mark already stored as marked_lost_at or loss_reason is status lost on the Asia/Tbilisi day it was marked. loss_phase is waiting until treasury approves it, then approved. treasury_comment is the optional note treasury or an admin wrote when approving a loss. deal_comment is the per-row note treasury or an admin writes on this list. An analyst can read both and cannot change them.';

revoke all on public.analyst_deals from public, anon;
grant select on public.analyst_deals to authenticated;
