-- =====================================================================
-- Analytics from an uploaded transaction file.
-- Paste into the Supabase SQL Editor and run once.
-- =====================================================================

-- An upload counts as fresh data, same as a sync.
create or replace function public.data_freshness()
returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select max(s.finished_at)
  from private.sync_runs s
  where s.ok and s.kind in ('hourly', 'nightly', 'manual', 'upload')
$$;

-- Rows from the Excel or CSV. Admins only. Same columns the rate
-- counting already uses: abs_gel + cross_gel is turnover, total_income
-- is income. A repeated transaction id updates the existing row.
create or replace function public.import_transactions(p_rows jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_run     bigint;
  v_before  bigint;
  v_after   bigint;
  v_upserted int;
  v_skipped  int;
begin
  if not private.is_admin() then
    raise exception 'Only admins can upload transactions' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Expected a list of transactions';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'Send at most 1000 transactions at a time';
  end if;

  insert into private.sync_runs (kind) values ('upload') returning id into v_run;

  select count(*) into v_before from public.clients;

  with raw as (
    select *
    from jsonb_to_recordset(p_rows) as x(
      tx_id text, tx_date text, client_id text, client_name text,
      segment text, operation_type text, payment_status text,
      abs_gel numeric, cross_gel numeric, total_income numeric,
      spread_income numeric, revaluation numeric
    )
  ),
  clean as (
    select nullif(trim(tx_id), '') as tx_id,
           case when tx_date ~ '^\d{4}-\d{2}-\d{2}$' then tx_date::date end as tx_date,
           private.normalize_client_id(client_id) as client_id,
           nullif(left(btrim(coalesce(client_name, '')), 200), '') as client_name,
           nullif(btrim(segment), '') as segment,
           nullif(btrim(operation_type), '') as operation_type,
           upper(nullif(btrim(payment_status), '')) as payment_status,
           round(coalesce(abs_gel, 0), 2) as abs_gel,
           round(coalesce(cross_gel, 0), 2) as cross_gel,
           round(coalesce(total_income, 0), 2) as total_income,
           round(spread_income, 2) as spread_income,
           round(revaluation, 2) as revaluation
    from raw
  ),
  good as (
    select distinct on (tx_id) *
    from clean
    where tx_id is not null
      and tx_date is not null
      and client_id <> ''
      and payment_status is not null
      and lower(coalesce(operation_type, '')) not in ('position-close-in-bank', 'fastoo', 'bitnet', 'unipay')
    order by tx_id
  ),
  added as (
    insert into public.clients as c (client_id, name)
    select g.client_id, g.client_name
    from good g
    where g.client_id ~ '^([0-9]{9}|[0-9]{11})$'
    on conflict (client_id) do update
      set name = coalesce(c.name, excluded.name)
    returning 1
  ),
  saved as (
    insert into public.transactions as t (
      tx_id, tx_time, tx_date, client_id, segment, operation_type, payment_status,
      abs_gel, cross_gel, total_income, spread_income, revaluation, synced_at
    )
    select g.tx_id,
           (g.tx_date + time '12:00') at time zone 'Asia/Tbilisi',
           g.tx_date, g.client_id, g.segment, g.operation_type, g.payment_status,
           g.abs_gel, g.cross_gel, g.total_income, g.spread_income, g.revaluation, now()
    from good g
    on conflict (tx_id) do update set
      tx_time = excluded.tx_time,
      tx_date = excluded.tx_date,
      client_id = excluded.client_id,
      segment = excluded.segment,
      operation_type = excluded.operation_type,
      payment_status = excluded.payment_status,
      abs_gel = excluded.abs_gel,
      cross_gel = excluded.cross_gel,
      total_income = excluded.total_income,
      spread_income = excluded.spread_income,
      revaluation = excluded.revaluation,
      synced_at = now()
    returning 1
  )
  select (select count(*) from saved),
         (select count(*) from clean) - (select count(*) from good)
    into v_upserted, v_skipped;

  select count(*) into v_after from public.clients;

  update private.sync_runs
     set finished_at = now(), ok = true, rows_upserted = v_upserted
   where id = v_run;

  return jsonb_build_object(
    'upserted', v_upserted,
    'skipped', v_skipped,
    'clients_added', v_after - v_before
  );
exception when others then
  update private.sync_runs
     set finished_at = now(), ok = false, error = sqlerrm
   where id = v_run;
  raise;
end;
$$;

-- Company numbers from the uploaded transactions. Same rules as the
-- Team page: turnover is abs GEL plus cross GEL, income is total income.
create or replace function public.analytics_kpis(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_from date := p_from;
  v_to   date := p_to;
begin
  if not private.can_see_all() then
    raise exception 'Only admins and managers can see analytics' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'transactions', (select count(*) from public.transactions t
                      where (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)),
    'clients', (select count(distinct t.client_id) from public.transactions t
                 where (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)),
    'turnover', coalesce((select sum(t.abs_gel + t.cross_gel) from public.transactions t
                           where (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)), 0),
    'turnover_not_successful', coalesce((select sum(t.abs_gel + t.cross_gel) from public.transactions t
                           where t.payment_status <> 'SUCCESS'
                             and (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)), 0),
    'income', coalesce((select sum(t.total_income) from public.transactions t
                         where (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)), 0),
    'successful', (select count(*) from public.transactions t
                    where t.payment_status = 'SUCCESS'
                      and (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)),
    'by_month', coalesce((
      select jsonb_agg(x order by x.month)
      from (
        select to_char(date_trunc('month', t.tx_date), 'YYYY-MM-DD') as month,
               count(*) as transactions,
               count(distinct t.client_id) as clients,
               sum(t.abs_gel + t.cross_gel) as turnover,
               coalesce(sum(t.abs_gel + t.cross_gel) filter (where t.payment_status <> 'SUCCESS'), 0) as turnover_not_successful,
               sum(t.total_income) as income
        from public.transactions t
        where (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)
        group by date_trunc('month', t.tx_date)
      ) x
    ), '[]'::jsonb),
    'top_clients', coalesce((
      select jsonb_agg(x order by x.turnover desc)
      from (
        select t.client_id, c.name,
               sum(t.abs_gel + t.cross_gel) as turnover,
               sum(t.total_income) as income,
               count(*) as transactions
        from public.transactions t
        left join public.clients c on c.client_id = t.client_id
        where (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)
        group by t.client_id, c.name
        order by sum(t.abs_gel + t.cross_gel) desc
        limit 15
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.import_transactions(jsonb), public.analytics_kpis(date, date) from public, anon;
grant execute on function public.import_transactions(jsonb), public.analytics_kpis(date, date) to authenticated;
