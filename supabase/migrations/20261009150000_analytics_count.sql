-- Monthly turnover count. Paste this in the Supabase SQL editor.
-- Safe to paste again. Paste it after 25_analytics_speed.sql.
-- Do not re-run 1_platform.sql. This does not delete a payment.
-- ClickHouse is not connected. No password, no query, no copy.
--
-- ბრუნვა is abs_gel + cross_gel. An empty side is zero.
-- შემოსავალი is total_income, the fee, on those same rows.
-- A payment counts when both are true:
--   its Tbilisi month is the month being viewed (tx_time, or tx_date
--   when tx_time is empty)
--   its client id, with a leading 0 restored on a 10-digit id, is the
--   client id on a request whose requested_at falls in that same month
-- One client with many payments: every payment counts.
-- The same tx_id counts once. A row with no tx_id still counts once.
-- Nothing here invents an id.
-- matched_request_id is not used. A unique day, currency, amount, or
-- minute match is not required. Currency sides are not part of this sum.
-- A payment whose tx_time is in the previous month is not in this month's
-- total, even if that client requested this month.
--
-- Why the old total was short: the upload only attaches a payment to one
-- request when that fit is unique, and the page described that attachment
-- as the rule, so most saved rows looked left out. The month total itself
-- must not depend on that attachment. The previous total also read every
-- payment before it knew who had requested that month, so a large file
-- never returned and the screen stayed empty. This total takes the
-- month's clients from requests first, then looks up only their payments.

-- Seek one client's days, after the leading-zero rule, instead of reading
-- every payment in the table.
create index if not exists transactions_norm_client_date_idx
  on public.transactions (private.normalize_client_id(client_id), tx_date);

create index if not exists requests_requested_at_idx
  on public.requests (requested_at);

-- Return type is still jsonb, so this replaces the old function in place.
create or replace function public.analytics_kpis(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'Asia/Tbilisi'
as $$
declare
  v_from date := p_from;
  v_to   date := p_to;
  v_out  jsonb;
  v_has_status boolean;
  v_ok text;
begin
  if not private.can_see_all() then
    raise exception 'Only admins and managers can see analytics' using errcode = '42501';
  end if;

  select exists (
    select 1
    from information_schema.columns col
    where col.table_schema = 'public'
      and col.table_name = 'transactions'
      and col.column_name = 'payment_status'
  )
  into v_has_status;

  -- While payment_status exists, only SUCCESS counts. Spaces and letter
  -- case are ignored. When the column is gone, every stored row counts,
  -- because only successes are imported.
  if v_has_status then
    v_ok := $ok$(upper(regexp_replace(translate(coalesce(pay.payment_status, ''), chr(160), ' '), '[[:space:]]', '', 'g')) = 'SUCCESS')$ok$;
  else
    v_ok := $ok$true$ok$;
  end if;

  execute format($q$
    with asked as materialized (
      select distinct
        private.normalize_client_id(rq.client_id) as client_id,
        date_trunc('month', (rq.requested_at at time zone 'Asia/Tbilisi'))::date as month
      from public.requests rq
      where private.normalize_client_id(rq.client_id) <> ''
        and ($1::date is null or rq.requested_at >= ($1::date::timestamp at time zone 'Asia/Tbilisi'))
        and ($2::date is null or rq.requested_at < (($2::date + 1)::timestamp at time zone 'Asia/Tbilisi'))
    ),
    raw as (
      select
        coalesce(nullif(btrim(pay.tx_id), ''), 'row:' || pay.ctid::text) as pay_key,
        asked.client_id,
        asked.month,
        coalesce(pay.abs_gel, 0) + coalesce(pay.cross_gel, 0) as gel,
        coalesce(pay.total_income, 0) as fee,
        %s as ok,
        pay.ctid as row_id
      from asked
      join public.transactions pay
        on private.normalize_client_id(pay.client_id) = asked.client_id
       and pay.tx_date >= (asked.month - 1)
       and pay.tx_date < ((asked.month + interval '1 month')::date + 1)
      where case
              when pay.tx_time is not null
                then date_trunc('month', (pay.tx_time at time zone 'Asia/Tbilisi'))::date
              else date_trunc('month', pay.tx_date)::date
            end = asked.month
    ),
    once as (
      select distinct on (src.pay_key)
        src.client_id,
        src.month,
        src.gel,
        src.fee,
        src.ok
      from raw src
      order by src.pay_key, src.ok desc, src.row_id
    ),
    totals as (
      select
        count(*) filter (where ok) as transactions,
        count(distinct client_id) filter (where ok) as clients,
        coalesce(sum(gel) filter (where ok), 0) as turnover,
        coalesce(sum(gel) filter (where not ok), 0) as turnover_not_successful,
        coalesce(sum(fee) filter (where ok), 0) as income
      from once
    ),
    month_rows as (
      select
        to_char(mth.month, 'YYYY-MM-DD') as month,
        coalesce(s.transactions, 0) as transactions,
        coalesce(s.clients, 0) as clients,
        coalesce(s.turnover, 0) as turnover,
        coalesce(s.turnover_not_successful, 0) as turnover_not_successful,
        coalesce(s.income, 0) as income
      from (select distinct asked.month from asked) mth
      left join (
        select
          month,
          count(*) filter (where ok) as transactions,
          count(distinct client_id) filter (where ok) as clients,
          coalesce(sum(gel) filter (where ok), 0) as turnover,
          coalesce(sum(gel) filter (where not ok), 0) as turnover_not_successful,
          coalesce(sum(fee) filter (where ok), 0) as income
        from once
        group by month
      ) s on s.month = mth.month
    ),
    top_rows as (
      select
        g.client_id,
        nm.client_name as name,
        g.turnover,
        g.income,
        g.transactions
      from (
        select
          client_id,
          sum(gel) filter (where ok) as turnover,
          sum(fee) filter (where ok) as income,
          count(*) filter (where ok) as transactions
        from once
        group by client_id
        having count(*) filter (where ok) > 0
        order by sum(gel) filter (where ok) desc
        limit 15
      ) g
      left join lateral (
        select cl.name as client_name
        from public.clients cl
        where private.normalize_client_id(cl.client_id) = g.client_id
        order by (cl.client_id = g.client_id) desc
        limit 1
      ) nm on true
    )
    select jsonb_build_object(
      'from', $1,
      'to', $2,
      'transactions', totals.transactions,
      'clients', totals.clients,
      'turnover', totals.turnover,
      'turnover_not_successful', totals.turnover_not_successful,
      'income', totals.income,
      'successful', totals.transactions,
      'by_month', coalesce((
        select jsonb_agg(x order by x.month) from month_rows x
      ), '[]'::jsonb),
      'top_clients', coalesce((
        select jsonb_agg(x order by x.turnover desc) from top_rows x
      ), '[]'::jsonb)
    )
    from totals
  $q$, v_ok)
  into v_out
  using v_from, v_to;

  return v_out;
end;
$$;

comment on function public.analytics_kpis(date, date) is
  'Turnover is abs_gel + cross_gel for each stored payment whose Tbilisi month is the month being viewed and whose normalized client id is on a request whose requested_at is in that same month. A previous-month payment is not included. The same tx_id counts once. matched_request_id is not used. The fee is total_income of those rows.';

revoke all on function public.analytics_kpis(date, date) from public, anon;
grant execute on function public.analytics_kpis(date, date) to authenticated;

analyze public.transactions;
analyze public.requests;
