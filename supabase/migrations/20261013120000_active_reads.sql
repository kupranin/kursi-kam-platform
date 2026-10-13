-- Same statements as supabase/setup/33_active_reads.sql.
-- Do not apply this until it is approved. Applying the setup file in the
-- SQL editor is the intended path. This migration is the matching history.
-- It does not edit public.request_outcomes.

-- Do not paste this until you have approved it.
-- Paste it after 32_loss_visible.sql. Do not re-run 1_platform.sql.
-- Do not drop public.request_outcomes. Do not change its columns or its body.
-- Do not drop SECURITY DEFINER on analyst_deals or request_rate_names.
-- Do not drop requests. Do not delete rows.
--
-- This adds a narrower read for open cards. It does not change who can
-- quote, write a rate, mark a loss, or approve a loss.
--
-- Security (same as PHASE2_PERFORMANCE_CHANGES.md):
-- request_active is security invoker. The signed-in user's RLS applies.
-- requests_read: a KAM sees kam_id = their profile, admin/manager see all
-- (can_see_all), treasury sees all (is_treasury). An analyst matches none
-- of those, so an analyst gets no rows. A KAM does not see another KAM.
-- The client join is the same inner join as request_outcomes, so a hidden
-- client still hides the row. Profile names follow profiles_read (yourself
-- or admin/manager). This does not grant new profile rows.
-- desk_day_rows and request_went_through_ids are security invoker and
-- read request_outcomes, so they cannot see more rows than that view
-- already allows. A KAM does not receive another KAM's ids. An analyst
-- receives none.
--
-- request_active does not read transactions. went_through, outcome, and
-- loss_open from payment matching stay on request_outcomes.
-- request_went_through_ids returns only ids that request_outcomes already
-- marks went_through, for the ids the caller passed. It does not copy the
-- payment rule into the app.
--
-- desk_day_rows is the OR of the old rate-desk day slices, deduped, with
-- no row cap. A cap on the combined set could drop a row one of the old
-- slices would still have returned.
--   source = app and request_date = p_today
--   source = app and quoted_at >= p_start
--   source = app and asked_at >= p_start
--   source = app and client_replied_at >= p_start
--   source = app and rate_written_at >= p_start
--   source = app and rate_valid_until >= p_start
--   source = app and loss_reason_at >= p_start
--   or id = any (p_also_ids), any source
-- p_start is midnight Asia/Tbilisi for p_today, computed in the app
-- (tbilisiDayStart). There is no upper bound, same as the old .gte slices.
-- The app still applies onDeskToday. One row that matches several arms
-- is returned once.

create or replace view public.request_active
with (security_invoker = true)
as
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
  r.gets_amount,
  r.client_rate,
  r.rate,
  r.note,
  r.loss_reason,
  r.loss_reason_at,
  r.loss_reason_note,
  r.source,
  r.asked_at,
  r.quote_status,
  r.rate_valid_until,
  r.quoted_at,
  r.decline_reason,
  case
    when r.quote_status = 'quoted' and r.rate_valid_until is not null and r.rate_valid_until < now() then 'expired'
    else r.quote_status
  end as quote_state,
  r.client_reply,
  r.approved_rate,
  r.wanted_rate,
  r.better_decision,
  r.given_rate,
  r.client_decline_reason,
  r.client_replied_at,
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
  r.marked_lost_at,
  r.import_key,
  r.legacy_status
from public.requests r
join public.clients c on c.client_id = r.client_id
left join public.profiles p on p.id = r.kam_id
left join public.profiles ap on ap.id = r.loss_approved_by;

comment on view public.request_active is
  'Open-card columns from requests, clients, and profiles. Security invoker, so requests_read applies. Does not read transactions and does not replace request_outcomes.';

revoke all on public.request_active from public, anon;
grant select on public.request_active to authenticated;

-- One read for the rate desk's today list. Same OR as the old slices.
-- Security invoker: no broader than request_outcomes.
create or replace function public.desk_day_rows(
  p_today date,
  p_start timestamptz,
  p_also_ids bigint[]
)
returns table (
  id bigint,
  kam_name text,
  client_id text,
  client_name text,
  sells_currency text,
  gets_currency text,
  amount numeric,
  gets_amount numeric,
  client_rate numeric,
  rate numeric,
  approved_rate numeric,
  given_rate numeric,
  quote_status text,
  quote_state text,
  decline_reason text,
  client_reply text,
  client_decline_reason text,
  better_decision text,
  requested_at timestamptz,
  request_date date,
  asked_at timestamptz,
  quoted_at timestamptz,
  client_replied_at timestamptz,
  rate_valid_until timestamptz,
  rate_written_at timestamptz,
  outcome text,
  went_through boolean,
  loss_open boolean,
  loss_reason text,
  loss_reason_at timestamptz,
  loss_reason_note text,
  loss_approved_at timestamptz,
  loss_approval_comment text,
  loss_approver_name text,
  payment_confirmed_at timestamptz,
  bank text,
  note text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    o.id,
    o.kam_name,
    o.client_id,
    o.client_name,
    o.sells_currency,
    o.gets_currency,
    o.amount,
    o.gets_amount,
    o.client_rate,
    o.rate,
    o.approved_rate,
    o.given_rate,
    o.quote_status,
    o.quote_state,
    o.decline_reason,
    o.client_reply,
    o.client_decline_reason,
    o.better_decision,
    o.requested_at,
    o.request_date,
    o.asked_at,
    o.quoted_at,
    o.client_replied_at,
    o.rate_valid_until,
    o.rate_written_at,
    o.outcome,
    o.went_through,
    o.loss_open,
    o.loss_reason,
    o.loss_reason_at,
    o.loss_reason_note,
    o.loss_approved_at,
    o.loss_approval_comment,
    o.loss_approver_name,
    o.payment_confirmed_at,
    o.bank,
    o.note
  from public.request_outcomes o
  where o.id = any (coalesce(p_also_ids, '{}'::bigint[]))
     or (
       o.source = 'app'
       and (
         o.request_date = p_today
         or o.quoted_at >= p_start
         or o.asked_at >= p_start
         or o.client_replied_at >= p_start
         or o.rate_written_at >= p_start
         or o.rate_valid_until >= p_start
         or o.loss_reason_at >= p_start
       )
     );
$$;

comment on function public.desk_day_rows(date, timestamptz, bigint[]) is
  'Today on the rate desk: the old slice OR, deduped, no row cap. Security invoker over request_outcomes. Does not change that view.';

revoke all on function public.desk_day_rows(date, timestamptz, bigint[]) from public, anon;
grant execute on function public.desk_day_rows(date, timestamptz, bigint[]) to authenticated;

-- Ids the outcomes view already counts as went through, including a
-- successful payment match. The caller passes the open-card ids. Only id
-- comes back. Security invoker: requests_read still applies, so a KAM
-- cannot read another KAM's id and an analyst gets no rows.
create or replace function public.request_went_through_ids(p_ids bigint[])
returns table (id bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select o.id
  from public.request_outcomes o
  where o.id = any (coalesce(p_ids, '{}'::bigint[]))
    and o.went_through;
$$;

comment on function public.request_went_through_ids(bigint[]) is
  'Subset of the given ids that request_outcomes marks went_through. Security invoker. Id only. Does not change that view.';

revoke all on function public.request_went_through_ids(bigint[]) from public, anon;
grant execute on function public.request_went_through_ids(bigint[]) to authenticated;
