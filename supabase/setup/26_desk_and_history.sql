-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 24_treasury_loss_comment.sql. Do not re-run 1_platform.sql.
-- If you paste 23_kam_confirm_payment.sql or 24_treasury_loss_comment.sql
-- again, paste this file once more afterwards.
-- Do not drop requests. Do not delete rows. Do not insert a transaction id.
--
-- A KAM can mark their own still-open app request as lost. An admin can
-- mark any. Treasury, a manager, and an analyst cannot. View-as is not a
-- role. The mark uses the existing loss path: the row stays open until
-- treasury or an admin approves it on Lost requests. The comment stays
-- optional and is written there, not here.
-- Success is still confirm_request_payment (payment went through). This
-- file does not change that function.
--
-- Columns first. The guard, the loss check, and both views name
-- marked_lost_at. PostgreSQL checks those as soon as they are created.

alter table public.requests add column if not exists marked_lost_at timestamptz;
alter table public.requests add column if not exists marked_lost_by uuid;

do $marked_lost_by_fkey$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.requests'::regclass
      and conname = 'requests_marked_lost_by_fkey'
  ) then
    alter table public.requests
      add constraint requests_marked_lost_by_fkey
      foreign key (marked_lost_by) references public.profiles (id) on delete set null;
  end if;
end
$marked_lost_by_fkey$;

comment on column public.requests.marked_lost_at is
  'When a KAM (their own request) or an admin marked an open app request as lost. The loss stays open until treasury or an admin approves it. Does not set rate_written_at and does not insert a transaction.';
comment on column public.requests.marked_lost_by is
  'Profile that marked the request as lost.';

-- Direct updates cannot set the mark. The function below is security
-- definer, so it runs as the owner and this guard lets it through.
create or replace function private.guard_mark_lost()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.marked_lost_at is null and new.marked_lost_by is null then
      return new;
    end if;
  elsif new.marked_lost_at is not distinct from old.marked_lost_at
     and new.marked_lost_by is not distinct from old.marked_lost_by
  then
    return new;
  end if;
  if current_user is distinct from 'authenticated' then
    return new;
  end if;
  raise exception 'Mark a request as lost from the open request list' using errcode = '42501';
end;
$$;

revoke all on function private.guard_mark_lost() from public, anon, authenticated;

drop trigger if exists requests_guard_mark_lost on public.requests;
create trigger requests_guard_mark_lost
  before insert or update on public.requests
  for each row execute function private.guard_mark_lost();

-- Same return shape as before. A KAM mark is a loss even while a better
-- rate is still waiting on treasury. A written rate, a confirmed payment,
-- a matched payment, and an agreement-file win are still not losses.
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

-- Same analyst columns as 24, including treasury_comment. Drop first so
-- the recreated view can keep that column. Request rows stay.
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
      when r.marked_lost_at is not null and r.loss_approved_at is null then 'open'
      when r.marked_lost_at is not null then 'lost'
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
where private.my_role() in ('analyst', 'admin');

comment on view public.analyst_deals is
  'Every request for an analyst or an admin. A written rate is success. A KAM or admin confirmation that the payment went through is success too. A KAM or admin mark as lost stays open until treasury approves it, then it is lost. treasury_comment is the optional note treasury or an admin wrote when approving a loss.';

revoke all on public.analyst_deals from public, anon;
grant select on public.analyst_deals to authenticated;

-- KAM: own request only. Admin: any request. A second call does nothing.
-- Does not write a loss reason. Treasury still approves on Lost requests.
create or replace function public.mark_request_lost(p_request_id bigint)
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
         marked_lost_by = v_me
   where r.id = p_request_id;
end;
$$;

revoke all on function public.mark_request_lost(bigint) from public, anon;
grant execute on function public.mark_request_lost(bigint) to authenticated;

-- Same return columns as treasury_queue already has. A marked loss, a
-- written rate, or a confirmed payment leaves the quote queue. No drop:
-- the row type did not change.
create or replace function public.treasury_queue()
returns table (
  request_id       bigint,
  asked_at         timestamptz,
  waiting_seconds  int,
  kam_name         text,
  client_id        text,
  client_name      text,
  client_kind      text,
  is_new_client    boolean,
  sells_currency   text,
  gets_currency    text,
  amount           numeric,
  note             text,
  last_rate        numeric,
  last_rate_at     timestamptz,
  standard_rate    numeric,
  nbg_rate         numeric,
  last_given_today numeric,
  gets_amount      numeric,
  client_rate      numeric,
  loss_reason_note text
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (private.is_treasury() or private.is_admin()) then
    raise exception 'Only treasury can see the rate queue' using errcode = '42501';
  end if;
  return query
  select r.id,
         r.asked_at,
         extract(epoch from now() - r.asked_at)::int,
         p.full_name,
         r.client_id,
         cl.name,
         cl.kind,
         not exists (select 1 from public.requests r2 where r2.client_id = r.client_id and r2.id <> r.id),
         r.sells_currency,
         r.gets_currency,
         r.amount,
         r.note,
         lq.rate,
         lq.created_at,
         private.standard_rate_for(r.sells_currency, r.gets_currency),
         private.nbg_rate_for(r.sells_currency, r.gets_currency),
         lt.rate,
         r.gets_amount,
         r.client_rate,
         r.loss_reason_note
  from public.requests r
  join public.clients cl on cl.client_id = r.client_id
  join public.profiles p on p.id = r.kam_id
  left join lateral (
    select q.rate, q.created_at
    from public.quotes q
    join public.requests r3 on r3.id = q.request_id
    where r3.client_id = r.client_id
      and r3.sells_currency = r.sells_currency
      and r3.gets_currency = r.gets_currency
      and q.action = 'quoted'
    order by q.created_at desc
    limit 1
  ) lq on true
  left join lateral (
    select q.rate
    from public.quotes q
    join public.requests r4 on r4.id = q.request_id
    where r4.sells_currency = r.sells_currency
      and r4.gets_currency = r.gets_currency
      and q.action = 'quoted'
      and (q.created_at at time zone 'Asia/Tbilisi')::date = private.tbilisi_today()
    order by q.created_at desc
    limit 1
  ) lt on true
  where r.quote_status = 'asking'
    and r.marked_lost_at is null
    and r.rate_written_at is null
    and r.payment_confirmed_at is null
  order by r.asked_at;
end;
$$;

revoke all on function public.treasury_queue() from public, anon;
grant execute on function public.treasury_queue() to authenticated;
