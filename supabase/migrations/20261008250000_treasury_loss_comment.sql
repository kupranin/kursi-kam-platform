-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 23_kam_confirm_payment.sql. Do not re-run 1_platform.sql.
-- If you paste 21_delete_and_loss_approval.sql or 23_kam_confirm_payment.sql
-- again, paste this file once more afterwards.
-- Do not drop requests. Do not delete rows.
--
-- Treasury (private.is_treasury()) or an admin can approve a lost request.
-- A KAM cannot. The explanation is optional: empty is stored as null.
-- A written rate and a KAM "transaction went through" mark stay success,
-- so those rows are not losses.
--
-- The analyst file gets its own treasury comment column. Adding a column
-- means the view is dropped and created again. The role filter stays:
-- only an analyst or an admin can read it.
--
-- Columns first. The check below names loss_approval_comment, and the
-- analyst view names payment_confirmed_at. PostgreSQL checks both immediately.

alter table public.requests add column if not exists loss_approved_at timestamptz;
alter table public.requests add column if not exists loss_approved_by uuid;
alter table public.requests add column if not exists loss_approval_comment text;
alter table public.requests add column if not exists payment_confirmed_at timestamptz;
alter table public.requests add column if not exists payment_confirmed_by uuid;

alter table public.requests drop constraint if exists requests_loss_comment_len;
alter table public.requests add constraint requests_loss_comment_len
  check (
    loss_approval_comment is null
    or char_length(loss_approval_comment) between 1 and 500
  );

comment on column public.requests.loss_approval_comment is
  'Optional explanation treasury or an admin may write when approving a loss. Empty is allowed.';

create or replace function public.approve_request_loss(p_request_id bigint, p_comment text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me      uuid := private.my_profile_id();
  v_req     public.requests%rowtype;
  v_state   record;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'მხოლოდ სახაზინოს შეუძლია დანაკარგის დადასტურება' using errcode = '42501';
  end if;
  if private.my_role() = 'kam' or (not private.is_admin() and exists (
    select 1 from public.requests r where r.id = p_request_id and r.kam_id = v_me
  )) then
    raise exception 'კამ-ს არ შეუძლია საკუთარი დანაკარგის დადასტურება' using errcode = '42501';
  end if;
  if v_comment is not null and length(v_comment) > 500 then
    raise exception 'კომენტარი ძალიან გრძელია' using errcode = '22023';
  end if;

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  if v_req.kam_id = v_me and not private.is_admin() then
    raise exception 'კამ-ს არ შეუძლია საკუთარი დანაკარგის დადასტურება' using errcode = '42501';
  end if;
  if v_req.rate_written_at is not null then
    raise exception 'გაწერილი კურსი ნიშნავს, რომ გარიგება გავიდა' using errcode = '22023';
  end if;
  if v_req.payment_confirmed_at is not null then
    raise exception 'ტრანზაქცია გავიდა, ეს დანაკარგი არ არის' using errcode = '22023';
  end if;

  select s.loss_candidate, s.loss_open into v_state
  from private.request_loss_state(p_request_id) s;
  if v_state.loss_candidate is not true then
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
        'სახაზინომ დანაკარგი დაადასტურა',
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

-- New column at the end. Drop first so the extra column is allowed.
drop view if exists public.analyst_deals;
create view public.analyst_deals
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
  d.treasury_comment
from (
  select
    r.id,
    r.request_date,
    p.full_name as kam_name,
    r.client_id,
    c.name as client_name,
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
    nullif(btrim(r.loss_approval_comment), '') as treasury_comment
  from public.requests r
  join public.clients c on c.client_id = r.client_id
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
      and not (r.client_reply = 'better' and r.better_decision is null)
      and (
        r.client_reply = 'declined'
        or r.quote_status = 'declined'
        or r.request_date < coalesce(private.freshness_date(), r.request_date)
      )
    ) as loss_candidate
  ) lc
) d
where private.my_role() in ('analyst', 'admin');

comment on view public.analyst_deals is
  'Every request for an analyst or an admin. A written rate is success. A KAM or admin confirmation that the payment went through is success too. treasury_comment is the optional note treasury or an admin wrote when approving a loss. Empty when they left it blank.';

revoke all on public.analyst_deals from public, anon;
grant select on public.analyst_deals to authenticated;
