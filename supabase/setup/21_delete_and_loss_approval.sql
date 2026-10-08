-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 20_clickhouse_business.sql. Do not re-run 1_platform.sql.
-- If you paste 17_amount_match.sql or 18_kam_edit_delete.sql again, paste
-- this file once more afterwards. Do not drop existing requests.
--
-- Delete: a KAM can delete only a request they logged (kam_id).
-- An admin (private.is_admin(), the real role) can delete any request.
-- Manager, treasury, and analyst cannot delete. View-as is not a role.
-- The client row stays. Quotes under the request go with it. Notifications
-- and a matched payment are unlinked so they do not block the delete.
--
-- A lost app request is not final until treasury (or an admin) approves it.
-- An explanation is optional. A KAM cannot approve a loss, including their
-- own. A written rate (rate_written_at) is still a deal that went through,
-- never a loss. Client decline or treasury decline with no written rate
-- stays on this lost path. If you paste this file again, paste
-- 24_treasury_loss_comment.sql afterwards so the explanation stays optional
-- and the analyst file keeps the treasury comment column.

-- Columns first. Comments and the index come after, so a fresh paste
-- does not trip on a missing column.
alter table public.requests add column if not exists loss_approved_at timestamptz;
alter table public.requests add column if not exists loss_approved_by uuid;
alter table public.requests add column if not exists loss_approval_comment text;

do $loss_approved_by_fkey$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.requests'::regclass
      and conname = 'requests_loss_approved_by_fkey'
  ) then
    alter table public.requests
      add constraint requests_loss_approved_by_fkey
      foreign key (loss_approved_by) references public.profiles (id) on delete set null;
  end if;
end
$loss_approved_by_fkey$;

do $loss_comment_len$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.requests'::regclass
      and conname = 'requests_loss_comment_len'
  ) then
    alter table public.requests
      add constraint requests_loss_comment_len
      check (
        loss_approval_comment is null
        or char_length(loss_approval_comment) between 1 and 500
      );
  end if;
end
$loss_comment_len$;

comment on column public.requests.loss_approved_at is
  'When treasury or an admin approved a lost request. Empty until then, so the loss is not final.';
comment on column public.requests.loss_approved_by is
  'Profile that approved the loss. A KAM cannot approve their own loss.';
comment on column public.requests.loss_approval_comment is
  'Optional explanation treasury or an admin may write when approving a loss. Empty is allowed.';

create index if not exists requests_loss_approval_idx
  on public.requests (request_date desc)
  where source = 'app' and loss_approved_at is null and rate_written_at is null;

-- Who may delete. Same rule as the function below. View-as cannot widen it.
drop policy if exists requests_admin_update on public.requests;
drop policy if exists requests_admin_delete on public.requests;
drop policy if exists requests_update on public.requests;
drop policy if exists requests_delete on public.requests;

create policy requests_update on public.requests
  for update to authenticated
  using (
    (select private.is_admin())
    or (
      (select private.my_role()) = 'kam'
      and kam_id = (select private.my_profile_id())
    )
    or (select private.my_role()) = 'treasury'
  )
  with check (
    (select private.is_admin())
    or (
      (select private.my_role()) = 'kam'
      and kam_id = (select private.my_profile_id())
    )
    or (select private.my_role()) = 'treasury'
  );

create policy requests_delete on public.requests
  for delete to authenticated
  using (
    (select private.is_admin())
    or (
      (select private.my_role()) = 'kam'
      and kam_id = (select private.my_profile_id())
    )
  );

-- Direct updates cannot set the approval. The approve function is
-- security definer, so it runs as the owner and this guard lets it through.
create or replace function private.guard_loss_approval()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.loss_approved_at is not distinct from old.loss_approved_at
     and new.loss_approved_by is not distinct from old.loss_approved_by
     and new.loss_approval_comment is not distinct from old.loss_approval_comment
  then
    return new;
  end if;
  if current_user is distinct from 'authenticated' then
    return new;
  end if;
  raise exception 'Approve the loss from treasury' using errcode = '42501';
end;
$$;

revoke all on function private.guard_loss_approval() from public, anon, authenticated;

drop trigger if exists requests_guard_loss_approval on public.requests;
create trigger requests_guard_loss_approval
  before update on public.requests
  for each row execute function private.guard_loss_approval();

-- One definition of "this app request is on the lost path".
-- A written rate, a successful payment, or an agreement-file win is not a loss.
-- A better rate still waiting on treasury is not a loss yet.
-- The approve function uses this. The request list computes the same
-- rule itself, so a signed-in person does not need to call it.
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
  (b.rate_written or b.tx_hit or b.file_won) as went_through,
  case
    when b.rate_written or b.tx_hit or b.file_won then 'went_through'
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
  (b.loss_candidate and b.loss_approved_at is null) as loss_open
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
    r.loss_approved_at,
    r.loss_approved_by,
    r.loss_approval_comment,
    ap.full_name as loss_approver_name,
    w.rate_written,
    w.tx_hit,
    w.file_won,
    w.file_lost,
    w.file_open,
    (
      r.source = 'app'
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
  from public.requests r
  join public.clients c on c.client_id = r.client_id
  left join public.profiles p on p.id = r.kam_id
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
-- A written rate stays success. Same columns as before, so this replace
-- does not drop the view.
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
  case when d.status = 'lost' or d.rate_written then d.reason else null end as loss_reason,
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
    case
      when r.rate_written_at is not null then 'success'
      when w.tx_hit or w.file_won then 'success'
      when r.client_reply = 'better' and r.better_decision is null then 'open'
      when c.loss_candidate and r.loss_approved_at is null then 'open'
      when c.loss_candidate then 'lost'
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
) d
where private.my_role() in ('analyst', 'admin');

comment on view public.analyst_deals is
  'Every request for an analyst or an admin. A written rate is success. An app loss stays open until treasury or an admin approves it with a comment. That comment is included in the reason once the loss is final.';

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

create or replace function public.delete_request(p_request_id bigint)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me  uuid := private.my_profile_id();
  v_req public.requests%rowtype;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;
  if private.my_role() not in ('admin', 'kam') then
    raise exception 'Your account cannot delete requests' using errcode = '42501';
  end if;
  select * into v_req from public.requests r where r.id = p_request_id;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_req.kam_id is distinct from v_me and not private.is_admin() then
    raise exception 'This request belongs to another KAM' using errcode = '42501';
  end if;

  delete from public.quotes q where q.request_id = p_request_id;
  update public.user_notifications n set request_id = null where n.request_id = p_request_id;
  update public.notification_events e set request_id = null where e.request_id = p_request_id;
  update public.transactions t set matched_request_id = null where t.matched_request_id = p_request_id;
  delete from public.requests r where r.id = p_request_id;
end;
$$;

revoke all on function public.delete_request(bigint) from public, anon;
grant execute on function public.delete_request(bigint) to authenticated;

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
        v_comment,
        v_comment
      );
    exception when others then
      raise warning 'inbox skipped: %', sqlerrm;
    end;
  end if;
end;
$$;

revoke all on function public.approve_request_loss(bigint, text) from public, anon;
grant execute on function public.approve_request_loss(bigint, text) to authenticated;
