-- Analytics turnover estimate. Paste this in the Supabase SQL editor.
-- Safe to paste again. Paste it after 21_delete_and_loss_approval.sql.
-- Do not re-run 1_platform.sql. If you paste 3_analytics.sql again,
-- paste this file once more afterwards.
--
-- This replaces analytics_kpis only. It does not delete a payment or a
-- request, and it does not change the unique amount match that marks
-- one request as went through. A bank transaction id is not required.
-- matched_request_id is not required.
--
-- ბრუნვა counts a payment only when both are true:
--   payment_status is SUCCESS, in any letter case
--   the payment's client id (sender id, stored as client_id), normalized
--   the same way as a request client id (a 10-digit id gets a leading 0),
--   is the client id on a request in the same calendar month
-- The request month and the payment month both have to fall in the month
-- selected on Analytics. A successful March payment counts when that
-- client has a request in March. A successful March payment for a client
-- with no request in March does not count.
-- The amount is still abs_gel + cross_gel. The fee (total_income,
-- შემოსავალი) is summed on those same rows, not on every payment.
-- The month table and the biggest-clients table use this same set.
-- A payment that is not SUCCESS stays out of ბრუნვა. For a client who
-- does have a request that month, that payment's abs_gel + cross_gel
-- is the "არ გავიდა" figure only.

create or replace function public.analytics_kpis(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_from date := p_from;
  v_to   date := p_to;
  v_out  jsonb;
begin
  if not private.can_see_all() then
    raise exception 'Only admins and managers can see analytics' using errcode = '42501';
  end if;

  with request_months as (
    select distinct
      private.normalize_client_id(r.client_id) as client_id,
      date_trunc('month', r.request_date)::date as month
    from public.requests r
    where private.normalize_client_id(r.client_id) <> ''
      and (v_from is null or r.request_date >= v_from)
      and (v_to is null or r.request_date <= v_to)
  ),
  linked as (
    select
      n.client_id,
      n.month,
      n.abs_gel,
      n.cross_gel,
      n.total_income,
      n.ok
    from (
      select
        private.normalize_client_id(t.client_id) as client_id,
        date_trunc('month', t.tx_date)::date as month,
        t.abs_gel,
        t.cross_gel,
        t.total_income,
        upper(btrim(coalesce(t.payment_status, ''))) = 'SUCCESS' as ok
      from public.transactions t
      where (v_from is null or t.tx_date >= v_from)
        and (v_to is null or t.tx_date <= v_to)
    ) n
    where n.client_id <> ''
      and exists (
        select 1
        from request_months rm
        where rm.client_id = n.client_id
          and rm.month = n.month
      )
  ),
  totals as (
    select
      count(*) filter (where ok) as transactions,
      count(distinct client_id) filter (where ok) as clients,
      coalesce(sum(abs_gel + cross_gel) filter (where ok), 0) as turnover,
      coalesce(sum(abs_gel + cross_gel) filter (where not ok), 0) as turnover_not_successful,
      coalesce(sum(total_income) filter (where ok), 0) as income
    from linked
  ),
  month_rows as (
    select
      to_char(m.month, 'YYYY-MM-DD') as month,
      coalesce(s.transactions, 0) as transactions,
      coalesce(s.clients, 0) as clients,
      coalesce(s.turnover, 0) as turnover,
      coalesce(s.turnover_not_successful, 0) as turnover_not_successful,
      coalesce(s.income, 0) as income
    from (select distinct rm.month from request_months rm) m
    left join (
      select
        month,
        count(*) filter (where ok) as transactions,
        count(distinct client_id) filter (where ok) as clients,
        coalesce(sum(abs_gel + cross_gel) filter (where ok), 0) as turnover,
        coalesce(sum(abs_gel + cross_gel) filter (where not ok), 0) as turnover_not_successful,
        coalesce(sum(total_income) filter (where ok), 0) as income
      from linked
      group by month
    ) s on s.month = m.month
  ),
  top_rows as (
    select
      c.client_id,
      cl.name,
      sum(c.abs_gel + c.cross_gel) as turnover,
      sum(c.total_income) as income,
      count(*) as transactions
    from linked c
    left join public.clients cl on cl.client_id = c.client_id
    where c.ok
    group by c.client_id, cl.name
    order by sum(c.abs_gel + c.cross_gel) desc
    limit 15
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
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
  into v_out
  from totals;

  return v_out;
end;
$$;

comment on function public.analytics_kpis(date, date) is
  'Turnover estimate: abs_gel + cross_gel of SUCCESS payments whose normalized client id is on a request in the same month. The fee is total_income of those same rows.';

revoke all on function public.analytics_kpis(date, date) from public, anon;
grant execute on function public.analytics_kpis(date, date) to authenticated;
