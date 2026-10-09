-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 22_analytics_turnover.sql. Do not re-run 1_platform.sql.
-- If you paste 16_client_history.sql, 17_amount_match.sql, or
-- 21_delete_and_loss_approval.sql again, paste this file once more afterwards.
-- Do not delete requests. Do not insert a transactions row.
--
-- Until bank payments sync in real time, a KAM can say that a request's
-- payment actually went through. An admin can say it for any request.
-- Treasury, a manager, and an analyst cannot. View-as is not a role.
-- private.is_admin() is the real admin, including the second-factor rule.
--
-- This sets requests.payment_confirmed_at. The request outcome becomes
-- went_through (the same success as a written rate or a matched payment),
-- so the request leaves the "why didn't it go through" list. It does not
-- set rate_written_at, and it does not clear a loss reason already saved.
-- A written rate was already success. This is for rows that are still
-- missed, including ones with no written rate.
-- Turnover is unchanged: it still counts SUCCESS payments only.

alter table public.requests add column if not exists payment_confirmed_at timestamptz;
alter table public.requests add column if not exists payment_confirmed_by uuid;
alter table public.requests add column if not exists loss_approved_at timestamptz;
alter table public.requests add column if not exists loss_approved_by uuid;
alter table public.requests add column if not exists loss_approval_comment text;

do $payment_confirmed_by_fkey$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.requests'::regclass
      and conname = 'requests_payment_confirmed_by_fkey'
  ) then
    alter table public.requests
      add constraint requests_payment_confirmed_by_fkey
      foreign key (payment_confirmed_by) references public.profiles (id) on delete set null;
  end if;
end
$payment_confirmed_by_fkey$;

comment on column public.requests.payment_confirmed_at is
  'When a KAM (their own request) or an admin said the payment went through, before a bank row is synced. Outcome becomes went_through. Does not insert a transaction and does not set rate_written_at. A saved loss reason stays.';
comment on column public.requests.payment_confirmed_by is
  'Profile that confirmed the payment went through.';

-- Direct updates cannot set the confirmation. The function below is
-- security definer, so it runs as the owner and this guard lets it through.
create or replace function private.guard_payment_confirm()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.payment_confirmed_at is null and new.payment_confirmed_by is null then
      return new;
    end if;
  elsif new.payment_confirmed_at is not distinct from old.payment_confirmed_at
     and new.payment_confirmed_by is not distinct from old.payment_confirmed_by
  then
    return new;
  end if;
  if current_user is distinct from 'authenticated' then
    return new;
  end if;
  raise exception 'Say that the payment went through from Follow-ups' using errcode = '42501';
end;
$$;

revoke all on function private.guard_payment_confirm() from public, anon, authenticated;

drop trigger if exists requests_guard_payment_confirm on public.requests;
create trigger requests_guard_payment_confirm
  before insert or update on public.requests
  for each row execute function private.guard_payment_confirm();

-- A written rate, a successful payment, an agreement-file win, or a
-- KAM/admin confirmation that the payment went through is not a loss.
-- A better rate still waiting on treasury is not a loss yet.
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
    c.loss_candidate,
    (c.loss_candidate and r.loss_approved_at is null) as loss_open,
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
      and not (r.client_reply = 'better' and r.better_decision is null)
      and (
        r.client_reply = 'declined'
        or r.quote_status = 'declined'
        or r.request_date < coalesce(private.freshness_date(), r.request_date)
      )
    ) as loss_candidate
  ) c
  where r.id = p_id;
$$;

revoke all on function private.request_loss_state(bigint) from public, anon, authenticated;

-- New columns are added at the end. Replacing this view cannot reorder
-- or drop a column that is already there.
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
      and not (r.client_reply = 'better' and r.better_decision is null)
      and (
        r.client_reply = 'declined'
        or r.quote_status = 'declined'
        or r.request_date < coalesce(private.freshness_date(), r.request_date)
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

-- Analysis uses the same lost path. An unapproved app loss stays open.
-- A written rate stays success. A confirmed payment is success too, and
-- a saved loss reason stays in the reason text. Create or replace cannot
-- insert a column, so the old list is dropped first. Request rows stay.
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
  d.quoted_by_name
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
      nullif(btrim(r.decline_reason), ''),
      nullif(btrim(r.loss_approval_comment), '')
    ), '') as reason,
    private.first_response_minutes(r.id, r.asked_at, r.requested_at, r.quoted_at, r.source) as first_response_minutes,
    private.rate_write_minutes(r.client_reply, r.client_replied_at, r.rate_written_at, r.source) as rate_write_minutes,
    nullif(btrim(qb.full_name), '') as quoted_by_name
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
  'Every request for an analyst or an admin. A written rate is success. A KAM or admin confirmation that the payment went through is success too, and a saved loss reason stays visible as history. An app loss stays open until treasury or an admin approves it with a comment. That comment is included in the reason once the loss is final.';

revoke all on public.analyst_deals from public, anon;
grant select on public.analyst_deals to authenticated;

-- These two read every column of request_outcomes. Replace them after the
-- view so the extra columns still fit.
create or replace function public.set_loss_reason(
  p_request_id bigint,
  p_reason     text,
  p_detail     text default null
)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me      uuid := private.my_profile_id();
  v_row     public.request_outcomes%rowtype;
  v_other   boolean := false;
  v_detail  text := nullif(trim(p_detail), '');
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
  if p_reason is not null and not exists (
    select 1 from public.loss_reasons l where l.code = p_reason and l.active
  ) then
    raise exception 'Unknown reason' using errcode = '22023';
  end if;
  if length(coalesce(v_detail, '')) > 500 then
    raise exception 'The reason is too long' using errcode = '22023';
  end if;

  if p_reason is not null then
    select p_reason = 'other' or lower(trim(l.label_en)) = 'other'
      into v_other
    from public.loss_reasons l
    where l.code = p_reason;
  end if;

  update public.requests r
     set loss_reason = p_reason,
         loss_reason_at = case when p_reason is null then null else now() end,
         loss_reason_note = case when v_other then v_detail else null end
   where r.id = p_request_id;
end;
$$;

revoke all on function public.set_loss_reason(bigint, text, text) from public, anon;
grant execute on function public.set_loss_reason(bigint, text, text) to authenticated;

create or replace function public.ask_again(p_request_id bigint, p_note text default null)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me  uuid := private.my_profile_id();
  v_row public.request_outcomes%rowtype;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot ask for rates' using errcode = '42501';
  end if;
  select * into v_row from public.request_outcomes o where o.id = p_request_id;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_row.kam_id <> v_me and not private.is_admin() then
    raise exception 'This request belongs to another KAM' using errcode = '42501';
  end if;
  if v_row.went_through then
    raise exception 'This request already went through' using errcode = '22023';
  end if;
  if v_row.quote_state not in ('expired', 'declined') then
    raise exception 'You can ask again once the rate has expired or treasury has sent it back' using errcode = '22023';
  end if;
  if v_row.client_reply = 'approved' then
    raise exception 'კლიენტმა უკვე დაამტკიცა ეს კურსი' using errcode = '22023';
  end if;
  if v_row.client_reply = 'better' and v_row.better_decision is null then
    raise exception 'სახაზინო ჯერ პასუხობს კურსს, რომელიც კლიენტს სურს' using errcode = '22023';
  end if;
  update public.requests r
     set quote_status = 'asking', asked_at = now(), rate = null, rate_valid_until = null,
         decline_reason = null, quoted_by = null, quoted_at = null,
         note = coalesce(nullif(trim(p_note), ''), r.note),
         client_reply = null, approved_rate = null, wanted_rate = null,
         better_decision = null, given_rate = null, client_decline_reason = null,
         client_replied_at = null, better_decided_at = null, better_decided_by = null,
         loss_approved_at = null, loss_approved_by = null, loss_approval_comment = null
   where r.id = p_request_id;
end;
$$;

revoke all on function public.ask_again(bigint, text) from public, anon;
grant execute on function public.ask_again(bigint, text) to authenticated;

-- KAM: own request only. Admin: any request. No bank transaction id.
-- A second call after it is already confirmed does nothing.
-- Does not clear loss_reason, loss_reason_note, or the loss approval.
create or replace function public.confirm_request_payment(p_request_id bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me           uuid := private.my_profile_id();
  v_kam          uuid;
  v_confirmed    timestamptz;
  v_rate_written timestamptz;
  v_import_key   text;
  v_legacy       text;
  v_client       text;
  v_date         date;
  v_source       text;
  v_requested    timestamptz;
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  if private.my_role() is distinct from 'admin' and private.my_role() is distinct from 'kam' then
    raise exception 'მხოლოდ KAM-ს ან ადმინს შეუძლია თქვას, რომ ტრანზაქცია გავიდა' using errcode = '42501';
  end if;
  if not private.can_write() then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;

  select
    r.kam_id,
    r.payment_confirmed_at,
    r.rate_written_at,
    r.import_key,
    r.legacy_status,
    r.client_id,
    r.request_date,
    r.source,
    r.requested_at
    into
    v_kam,
    v_confirmed,
    v_rate_written,
    v_import_key,
    v_legacy,
    v_client,
    v_date,
    v_source,
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
  if v_confirmed is not null then
    return;
  end if;
  if v_rate_written is not null
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
             and (v_source = 'import' or t.tx_time >= v_requested - interval '1 minute')
           )
           or t.matched_request_id = p_request_id
         )
     )
  then
    raise exception 'ეს მოთხოვნა უკვე გავიდა' using errcode = '22023';
  end if;

  update public.requests r
     set payment_confirmed_at = now(),
         payment_confirmed_by = v_me
   where r.id = p_request_id;
end;
$$;

revoke all on function public.confirm_request_payment(bigint) from public, anon;
grant execute on function public.confirm_request_payment(bigint) to authenticated;

create or replace function public.client_request_history(
  p_client_id text,
  p_exclude_id bigint default null
)
returns table (
  id              bigint,
  request_date    date,
  requested_at    timestamptz,
  kam_name        text,
  sells_currency  text,
  gets_currency   text,
  amount          numeric,
  gets_amount     numeric,
  rate            numeric,
  outcome         text,
  bank            text,
  total_count     bigint
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me uuid := private.my_profile_id();
  v_id text := private.normalize_client_id(p_client_id);
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  if v_id !~ '^([0-9]{9}|[0-9]{11})$' then
    return;
  end if;

  return query
  with matched as (
    select
      r.id,
      r.request_date,
      r.requested_at,
      p.full_name as kam_name,
      r.sells_currency,
      r.gets_currency,
      r.amount,
      r.gets_amount,
      case
        when r.client_reply = 'approved' and r.approved_rate > 0 then r.approved_rate
        when r.rate > 0 then r.rate
        else null
      end as rate,
      case
        when w.rate_written or w.payment_confirmed or w.tx_hit or w.file_won then 'went_through'
        when w.file_lost then 'did_not_go_through'
        when w.file_open then 'waiting'
        when r.request_date >= coalesce(private.freshness_date(), r.request_date) then 'waiting'
        else 'did_not_go_through'
      end as outcome,
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
      end as bank
    from public.requests r
    left join public.profiles p on p.id = r.kam_id
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
    where r.client_id = v_id
      and r.request_date >= (private.tbilisi_today() - interval '6 months')::date
      and (p_exclude_id is null or r.id <> p_exclude_id)
      and (
        r.source = 'app'
        or r.import_key like 'agreement:%'
      )
  )
  select
    m.id,
    m.request_date,
    m.requested_at,
    m.kam_name,
    m.sells_currency,
    m.gets_currency,
    m.amount,
    m.gets_amount,
    m.rate,
    m.outcome,
    m.bank,
    count(*) over ()::bigint as total_count
  from matched m
  order by m.requested_at desc, m.id desc
  limit 50;
end;
$$;

comment on function public.client_request_history(text, bigint) is
  'One client, last 6 months in Tbilisi, every KAM. Agreement-file rows and requests typed in the app. At most 50, newest first. A written rate, or a confirmation that the payment went through, is went_through. Does not list any other client. Does not insert a payment.';

revoke execute on function public.client_request_history(text, bigint) from public, anon;
grant execute on function public.client_request_history(text, bigint) to authenticated;

-- Follow-ups win-back list. A client whose latest request has a written
-- rate, or a confirmation that the payment went through, has gone through,
-- so they leave this list even with no transaction row.
create or replace function private.winback_for(p_kam uuid, p_all boolean)
returns table (
  client_id           text,
  client_name         text,
  client_kind         text,
  owner_id            uuid,
  owner_name          text,
  tier                text,
  last_request        date,
  last_deal           date,
  prior_turnover_gel  numeric,
  max_request_gel     numeric,
  last_reason         text,
  step                text,
  step_at             timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me    uuid := p_kam;
  v_all   boolean := p_all;
  v_today date := private.tbilisi_today();
  v_fresh date;
  v_rules public.rules%rowtype;
begin
  v_fresh := coalesce(private.freshness_date(), v_today);
  select * into v_rules from public.rules limit 1;

  return query
  with o as (
    select * from private.owners(v_today - v_rules.winback_window_days, v_today)
  ),
  latest as (
    select distinct on (r.client_id)
           r.client_id, r.request_date, r.import_key, r.legacy_status, r.rate_written_at, r.payment_confirmed_at
    from public.requests r
    where r.client_id in (select o.client_id from o)
    order by r.client_id, r.request_date desc, r.requested_at desc, r.id desc
  ),
  last_ok as (
    select t.client_id, max(t.tx_date) as last_deal
    from public.transactions t
    where t.payment_status = 'SUCCESS' and t.client_id in (select o.client_id from o)
    group by t.client_id
  ),
  cand as (
    select o.client_id, o.owner_id, lt.request_date as last_request, lk.last_deal
    from o
    join latest lt on lt.client_id = o.client_id
    left join last_ok lk on lk.client_id = o.client_id
    where lt.request_date < v_fresh
      and lt.rate_written_at is null
      and lt.payment_confirmed_at is null
      and (lk.last_deal is null or lk.last_deal < lt.request_date)
      -- A completed, partial, or still-open agreement row is not a lost client.
      -- A written rate, or a confirmation that the payment went through, is a success, so that client leaves this list.
      -- "Did not go through" still is, unless a successful payment is on or after that day.
      -- Requests typed in the app keep the payment rule when the rate was not written.
      and (
        lt.import_key is null
        or lt.import_key not like 'agreement:%'
        or coalesce(lt.legacy_status, '') in (
          'არ შესრულდა',
          'ბანკმა გააჩერა ტრანზაქცია',
          'აღარ დასჭირდა და გააუქმა',
          'უარი თქვა, მცირედი განსხვავების გამო ბანკში ურჩევნოდა კონვერტაცია'
        )
      )
  ),
  sizes as (
    select cd.client_id,
           (select coalesce(sum(t.abs_gel + t.cross_gel), 0)
              from public.transactions t
             where t.client_id = cd.client_id
               and t.payment_status = 'SUCCESS'
               and t.tx_date >= cd.last_request - 180
               and t.tx_date <  cd.last_request) as prior_turnover_gel,
           (select round(max(case when r.sells_currency = 'GEL' then r.amount
                                  when r.gets_currency  = 'GEL' then r.amount * r.rate end), 2)
              from public.requests r
             where r.client_id = cd.client_id
               and r.request_date >= v_today - v_rules.winback_window_days) as max_request_gel
    from cand cd
  ),
  latest_reason as (
    select distinct on (r.client_id) r.client_id, r.loss_reason
    from public.requests r
    where r.client_id in (select cd.client_id from cand cd)
    order by r.client_id, r.requested_at desc
  ),
  latest_step as (
    select distinct on (w.client_id) w.client_id, w.step, w.created_at
    from public.winback_actions w
    where w.client_id in (select cd.client_id from cand cd)
    order by w.client_id, w.created_at desc
  ),
  scored as (
    select cd.*, s.prior_turnover_gel, s.max_request_gel,
           greatest(s.prior_turnover_gel, coalesce(s.max_request_gel, 0)) as size_gel
    from cand cd
    join sizes s on s.client_id = cd.client_id
  )
  select sc.client_id,
         cl.name,
         cl.kind,
         sc.owner_id,
         p.full_name,
         case when sc.size_gel >= v_rules.tier_a_min_gel then 'A'
              when sc.size_gel >= v_rules.tier_b_min_gel then 'B'
              else 'C' end,
         sc.last_request,
         sc.last_deal,
         sc.prior_turnover_gel,
         sc.max_request_gel,
         lr.loss_reason,
         coalesce(ls.step, 'not_contacted'),
         ls.created_at
  from scored sc
  join public.clients cl  on cl.client_id = sc.client_id
  join public.profiles p  on p.id = sc.owner_id
  left join latest_reason lr on lr.client_id = sc.client_id
  left join latest_step  ls on ls.client_id = sc.client_id
  where v_all or sc.owner_id = v_me
  order by 6, sc.size_gel desc;
end;
$$;

revoke all on function private.winback_for(uuid, boolean) from public, anon, authenticated;
