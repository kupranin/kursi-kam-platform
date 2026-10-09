-- Faster analytics turnover, and a day-by-day finish for a large upload.
-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 24_treasury_loss_comment.sql.
-- Do not re-run 1_platform.sql.
--
-- ბრუნვა is abs_gel + cross_gel. შემოსავალი is total_income, the fee.
-- A payment counts when payment_status is SUCCESS (any letter case)
-- and that client has a request in the same calendar month.
-- The month is the Tbilisi date already stored on the row.
-- A missing bank transaction id does not drop the row.
-- matched_request_id is not required for this total.
-- A 10-digit client id is given a leading 0, on the payment and on the request.
--
-- The upload still saves every row first. Attaching one payment to one
-- request (same client, same day, same currencies, same lari amount to
-- the cent, and the same minute when a clock time exists) stays a
-- separate step. If that fit is not unique, the row is kept and not attached.
-- Finishing one day at a time is what lets a million-row file complete.
-- An earlier upload of that same day, with no bank id and not a hand-set
-- status, is replaced so the day is not counted twice. A row that has a
-- bank id is not removed.

-- The turnover read filters on the client, the day, and the status.
create index if not exists transactions_client_date_status_idx
  on public.transactions (client_id, tx_date, payment_status);

-- Same filter after the leading-zero rule, so the month total can seek
-- one client's days instead of reading every payment.
create index if not exists transactions_norm_client_date_idx
  on public.transactions (private.normalize_client_id(client_id), tx_date);

-- The upload skips a hand-set row. This keeps that check small.
create index if not exists transactions_manual_day_idx
  on public.transactions (client_id, tx_date)
  where source = 'manual';

alter table private.sync_runs add column if not exists upload_finished_on date;

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
begin
  if not private.can_see_all() then
    raise exception 'Only admins and managers can see analytics' using errcode = '42501';
  end if;

  with req as (
    select distinct
      private.normalize_client_id(r.client_id) as client_id,
      date_trunc('month', r.request_date)::date as month
    from public.requests r
    where private.normalize_client_id(r.client_id) <> ''
      and (v_from is null or r.request_date >= v_from)
      and (v_to is null or r.request_date <= v_to)
  ),
  joined as materialized (
    select
      req.client_id,
      req.month,
      coalesce(tx.abs_gel, 0) + coalesce(tx.cross_gel, 0) as gel,
      coalesce(tx.total_income, 0) as fee,
      upper(btrim(coalesce(tx.payment_status, ''))) = 'SUCCESS' as ok
    from req
    join public.transactions tx
      on private.normalize_client_id(tx.client_id) = req.client_id
     and tx.tx_date >= req.month
     and tx.tx_date < (req.month + interval '1 month')::date
    where (v_from is null or tx.tx_date >= v_from)
      and (v_to is null or tx.tx_date <= v_to)
  ),
  totals as (
    select
      count(*) filter (where ok) as transactions,
      count(distinct client_id) filter (where ok) as clients,
      coalesce(sum(gel) filter (where ok), 0) as turnover,
      coalesce(sum(gel) filter (where not ok), 0) as turnover_not_successful,
      coalesce(sum(fee) filter (where ok), 0) as income
    from joined
  ),
  month_rows as (
    select
      to_char(m.month, 'YYYY-MM-DD') as month,
      coalesce(s.transactions, 0) as transactions,
      coalesce(s.clients, 0) as clients,
      coalesce(s.turnover, 0) as turnover,
      coalesce(s.turnover_not_successful, 0) as turnover_not_successful,
      coalesce(s.income, 0) as income
    from (select distinct req.month from req) m
    left join (
      select
        month,
        count(*) filter (where ok) as transactions,
        count(distinct client_id) filter (where ok) as clients,
        coalesce(sum(gel) filter (where ok), 0) as turnover,
        coalesce(sum(gel) filter (where not ok), 0) as turnover_not_successful,
        coalesce(sum(fee) filter (where ok), 0) as income
      from joined
      group by month
    ) s on s.month = m.month
  ),
  top_rows as (
    select
      g.client_id,
      cl.name,
      g.turnover,
      g.income,
      g.transactions
    from (
      select
        client_id,
        sum(gel) filter (where ok) as turnover,
        sum(fee) filter (where ok) as income,
        count(*) filter (where ok) as transactions
      from joined
      group by client_id
      having count(*) filter (where ok) > 0
      order by sum(gel) filter (where ok) desc
      limit 15
    ) g
    left join public.clients cl on cl.client_id = g.client_id
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
  'Turnover estimate: abs_gel + cross_gel of SUCCESS payments whose normalized client id is on a request in the same Tbilisi month. The fee is total_income of those same rows. A bank transaction id is not required.';

revoke all on function public.analytics_kpis(date, date) from public, anon;
grant execute on function public.analytics_kpis(date, date) to authenticated;

-- One calendar day of an amount upload. The page calls this again until
-- pending is false. Each call stays small enough to finish.
create or replace function public.finish_transaction_upload(p_run bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set timezone = 'Asia/Tbilisi'
as $$
declare
  v_day       date;
  v_matched   int := 0;
  v_ambiguous int := 0;
  v_left      int := 0;
  r           record;
  f           jsonb;
begin
  if not private.is_admin() then
    raise exception 'Only admins can upload transactions' using errcode = '42501';
  end if;
  if p_run is null or not exists (
    select 1 from private.sync_runs s where s.id = p_run and s.kind = 'upload'
  ) then
    raise exception 'Upload run not found';
  end if;

  select min(t.tx_date)
    into v_day
  from public.transactions t
  where t.import_run = p_run
    and t.tx_id is null
    and t.tx_date > coalesce(
      (select s.upload_finished_on from private.sync_runs s where s.id = p_run),
      '-infinity'::date
    );

  if v_day is null then
    update private.sync_runs
       set finished_at = coalesce(finished_at, now()),
           ok = true
     where id = p_run;
    return jsonb_build_object(
      'matched', 0,
      'ambiguous', 0,
      'pending', false,
      'days_left', 0
    );
  end if;

  -- Earlier amount-upload of this same day only. A bank id stays.
  -- A hand-set status stays. This is so a repeated file is not counted twice.
  delete from public.transactions prev
   where prev.tx_id is null
     and prev.source is distinct from 'manual'
     and prev.import_run is distinct from p_run
     and prev.tx_date = v_day;

  update public.transactions pay
     set matched_request_id = null
   where pay.import_run = p_run
     and pay.tx_id is null
     and pay.tx_date = v_day
     and pay.source is distinct from 'manual'
     and pay.matched_request_id is not null;

  with pays as (
    select t.id,
           t.client_id,
           t.tx_date,
           t.tx_clock,
           t.sells_currency,
           t.gets_currency,
           case
             when t.sells_currency = 'GEL' or t.gets_currency = 'GEL' then
               case when t.abs_gel > 0 and t.cross_gel = 0 then round(t.abs_gel, 2) end
             when t.sells_currency is not null and t.gets_currency is not null then
               case when t.cross_gel > 0 and t.abs_gel = 0 then round(t.cross_gel, 2) end
           end as file_gel
    from public.transactions t
    where t.import_run = p_run
      and t.tx_date = v_day
      and t.tx_id is null
      and t.payment_status = 'SUCCESS'
      and t.source is distinct from 'manual'
  ),
  pairs as (
    select src.id as pay_id, rq.id as request_id
    from pays src
    join public.requests rq
      on rq.client_id = src.client_id
     and rq.request_date = src.tx_date
     and upper(rq.sells_currency) = src.sells_currency
     and upper(rq.gets_currency) = src.gets_currency
     and round(coalesce(
           rq.gel_amount,
           private.request_gel(
             rq.sells_currency, rq.gets_currency, rq.amount, rq.gets_amount,
             coalesce(rq.approved_rate, rq.rate)
           )
         ), 2) = src.file_gel
     and (
       src.tx_clock is null
       or date_trunc('minute', (rq.requested_at at time zone 'Asia/Tbilisi'))
          = date_trunc('minute', (src.tx_date + src.tx_clock))
     )
    where src.file_gel is not null
      and src.sells_currency is not null
      and src.gets_currency is not null
  ),
  pay_n as (
    select pay_id, count(*) as n from pairs group by pay_id
  ),
  req_n as (
    select request_id, count(*) as n from pairs group by request_id
  ),
  unique_pairs as (
    select pair.pay_id, pair.request_id
    from pairs pair
    join pay_n pn on pn.pay_id = pair.pay_id and pn.n = 1
    join req_n rn on rn.request_id = pair.request_id and rn.n = 1
  ),
  ambiguous_pays as (
    select distinct pair.pay_id
    from pairs pair
    join pay_n pn on pn.pay_id = pair.pay_id
    join req_n rn on rn.request_id = pair.request_id
    where pn.n > 1 or rn.n > 1
  ),
  updated as (
    update public.transactions tx
       set matched_request_id = u.request_id
      from unique_pairs u
     where tx.id = u.pay_id
       and tx.import_run = p_run
       and tx.tx_date = v_day
       and tx.tx_id is null
       and tx.source is distinct from 'manual'
    returning tx.id
  )
  select (select count(*) from updated),
         (select count(*) from ambiguous_pays)
    into v_matched, v_ambiguous;

  begin
    for r in
      select q.id, q.kam_id
      from public.requests q
      join public.transactions pay on pay.matched_request_id = q.id
      where pay.import_run = p_run
        and pay.tx_date = v_day
        and pay.tx_id is null
        and pay.payment_status = 'SUCCESS'
        and q.quote_status = 'quoted'
        and q.source = 'app'
    loop
      f := private.request_facts(r.id);
      perform private.emit_once(
        'went:' || r.id, 'request.went_through', r.id, r.kam_id,
        format('%s''s transaction arrived: the request at %s went through.', f->>'client_name', f->>'rate_text'),
        format('%s-ის ტრანზაქცია შემოვიდა: მოთხოვნა %s კურსით შესრულდა.', f->>'client_name', f->>'rate_text'),
        f
      );
    end loop;
  exception when others then
    raise warning 'notification skipped: %', sqlerrm;
  end;

  update private.sync_runs
     set upload_finished_on = v_day
   where id = p_run;

  select count(distinct t.tx_date)
    into v_left
  from public.transactions t
  where t.import_run = p_run
    and t.tx_id is null
    and t.tx_date > v_day;

  if v_left = 0 then
    update private.sync_runs
       set finished_at = now(),
           ok = true
     where id = p_run;
  end if;

  return jsonb_build_object(
    'matched', v_matched,
    'ambiguous', v_ambiguous,
    'pending', v_left > 0,
    'days_left', v_left
  );
end;
$$;

comment on function public.finish_transaction_upload(bigint) is
  'Attaches one day of an amount upload to requests, then returns how many days are left. Does not invent a transaction id.';

revoke all on function public.finish_transaction_upload(bigint) from public, anon;
grant execute on function public.finish_transaction_upload(bigint) to authenticated;

analyze public.transactions;
analyze public.requests;
