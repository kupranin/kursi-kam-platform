-- Push business clients only; other statuses are updated by hand.
-- Paste this in the Supabase SQL editor. Safe to paste again.
-- This file adds its own columns, so it can be pasted on its own.
-- Do not re-run 1_platform.sql. If you paste 17_amount_match.sql again
-- afterwards, paste this file once more so the clock-time match stays.
--
-- ClickHouse is not connected here. This does not store a password,
-- open a connection, or copy any payments. It only adds the place a
-- later push will land.
--
-- The place is public.transactions, the table analytics and the Excel
-- upload already use. A second table would count the same payment twice.
-- No payment is deleted, and the turnover numbers are not recalculated.
--
-- The sample export marks a person as client_type Individual. Only a
-- business client should be pushed. Individual, and every other type,
-- stays on the Excel upload or is corrected by an admin.
-- source tells the rows apart: clickhouse, upload, or manual.
-- A real transaction id is kept when the export has one. An empty id
-- stays empty. Nothing here invents an id.
-- Account numbers and the encrypted sender id are not stored.
--
-- The export column Create time is the payment's clock (Created At is
-- only the day). It is stored as tx_clock, a Tbilisi time of day.
-- When that clock is present, a request matches only if its time is
-- the same minute. Seconds are ignored. A file with only a date still
-- loads, tx_clock stays empty, and the match stays by day. Two payments
-- at different minutes are not the same payment.

-- Every column the rest of this file names is added here, before any
-- update, comment, or index. A comment on a missing column fails at once.
alter table public.transactions add column if not exists client_type text;
alter table public.transactions add column if not exists source text;
alter table public.transactions add column if not exists tx_clock time;
alter table public.transactions add column if not exists sells_currency text;
alter table public.transactions add column if not exists gets_currency text;
alter table public.transactions add column if not exists import_run bigint;
alter table public.transactions add column if not exists matched_request_id bigint;

-- tx_id stays unique for real ids. Rows with no id need their own key.
-- That key is not a transaction id. Existing rows are kept.
do $transactions_without_tx_id$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.transactions'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) ilike '%tx_id%'
  ) then
    alter table public.transactions drop constraint transactions_pkey;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transactions'
      and column_name = 'id'
  ) then
    alter table public.transactions
      add column id bigint generated always as identity;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.transactions'::regclass
      and contype = 'p'
  ) then
    alter table public.transactions
      add constraint transactions_pkey primary key (id);
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transactions'
      and column_name = 'tx_id'
      and is_nullable = 'NO'
  ) then
    alter table public.transactions alter column tx_id drop not null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.transactions'::regclass
      and conname = 'transactions_tx_id_key'
  ) then
    alter table public.transactions
      add constraint transactions_tx_id_key unique (tx_id);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.transactions'::regclass
      and conname = 'transactions_matched_request_fkey'
  ) then
    alter table public.transactions
      add constraint transactions_matched_request_fkey
      foreign key (matched_request_id) references public.requests (id) on delete set null;
  end if;
end
$transactions_without_tx_id$;

create unique index if not exists transactions_one_match_idx
  on public.transactions (matched_request_id)
  where matched_request_id is not null;

create index if not exists transactions_amount_import_idx
  on public.transactions (import_run, client_id, tx_date)
  where tx_id is null;

alter table public.transactions alter column source set default 'upload';

update public.transactions
   set source = 'upload'
 where source is null;

alter table public.transactions alter column source set not null;

do $clickhouse_business_source$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.transactions'::regclass
      and conname = 'transactions_source_check'
  ) then
    alter table public.transactions
      add constraint transactions_source_check
      check (source in ('clickhouse', 'manual', 'upload'));
  end if;
end
$clickhouse_business_source$;

-- The Excel upload already stores client_type in segment. Copy that
-- once, and only where client_type is still empty.
update public.transactions
   set client_type = nullif(btrim(segment), '')
 where client_type is null
   and nullif(btrim(segment), '') is not null;

comment on column public.transactions.client_type is
  'Export column client_type. The sample uses Individual. A ClickHouse push is for a business client only. Individual and every other type are written by hand.';

comment on column public.transactions.source is
  'clickhouse = pushed later, business clients only. upload = the Excel or CSV file. manual = an admin set the payment status by hand. A later push must not overwrite a manual status.';

comment on column public.transactions.tx_clock is
  'Tbilisi clock from the export column Create time. Empty when the file had only a date. The match uses the minute, not the seconds. Not a time bucket.';

comment on column public.transactions.matched_request_id is
  'Set only when one payment and one request share the client, the day, the currencies, and the exact lari amount. When tx_clock is set, the minute must agree too, in Tbilisi. Empty when that is not unique.';

-- Fills client_type from the file column when the upload did not set it.
-- Rejects a ClickHouse row that is Individual or has no type.
-- Keeps a hand-set status when some other update tries to change it.
create or replace function private.prepare_transaction_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.client_type is null then
    new.client_type := nullif(btrim(new.segment), '');
  end if;

  if new.source = 'clickhouse'
     and lower(btrim(coalesce(new.client_type, ''))) in ('individual', '')
  then
    raise exception 'ClickHouse push is for business clients only. Other client types are updated by hand'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and old.source = 'manual'
     and coalesce(current_setting('kursi.allow_manual_status', true), '') is distinct from 'on'
  then
    new.payment_status := old.payment_status;
    new.source := 'manual';
  end if;

  return new;
end;
$$;

drop trigger if exists prepare_transaction_row on public.transactions;
create trigger prepare_transaction_row
  before insert or update on public.transactions
  for each row execute function private.prepare_transaction_row();

-- Attaches one payment that has no transaction id. Same client, day,
-- currencies, and lari amount. When tx_clock is set, the request's
-- minute in Tbilisi must be the same. A payment with no clock still
-- matches by day. If more than one request or payment fits, this row
-- stays unattached. Other payments are left as they are.
create or replace function private.attach_payment_by_amount(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client text;
  v_date date;
  v_sells text;
  v_gets text;
  v_status text;
  v_tx text;
  v_clock time;
  v_gel numeric;
  v_pay_n int;
  v_req_n int;
  v_request bigint;
begin
  select t.client_id,
         t.tx_date,
         upper(btrim(t.sells_currency)),
         upper(btrim(t.gets_currency)),
         t.payment_status,
         t.tx_id,
         t.tx_clock,
         case
           when upper(btrim(t.sells_currency)) = 'GEL'
             or upper(btrim(t.gets_currency)) = 'GEL' then
             case when t.abs_gel > 0 and t.cross_gel = 0 then round(t.abs_gel, 2) end
           when nullif(btrim(t.sells_currency), '') is not null
            and nullif(btrim(t.gets_currency), '') is not null then
             case when t.cross_gel > 0 and t.abs_gel = 0 then round(t.cross_gel, 2) end
         end
    into v_client, v_date, v_sells, v_gets, v_status, v_tx, v_clock, v_gel
  from public.transactions t
  where t.id = p_id;

  if not found then
    return;
  end if;

  if v_tx is not null
     or v_status is distinct from 'SUCCESS'
     or v_gel is null
     or v_sells is null
     or v_gets is null
  then
    update public.transactions
       set matched_request_id = null
     where id = p_id
       and matched_request_id is not null;
    return;
  end if;

  select count(*), min(rq.id)
    into v_req_n, v_request
  from public.requests rq
  where rq.client_id = v_client
    and rq.request_date = v_date
    and upper(btrim(rq.sells_currency)) = v_sells
    and upper(btrim(rq.gets_currency)) = v_gets
    and round(coalesce(
          rq.gel_amount,
          private.request_gel(
            rq.sells_currency, rq.gets_currency, rq.amount, rq.gets_amount,
            coalesce(rq.approved_rate, rq.rate)
          )
        ), 2) = v_gel
    and (
      v_clock is null
      or date_trunc('minute', (rq.requested_at at time zone 'Asia/Tbilisi'))
         = date_trunc('minute', (v_date + v_clock))
    );

  if v_req_n = 1 then
    select count(*)
      into v_pay_n
    from public.transactions t
    join public.requests rq on rq.id = v_request
    where t.tx_id is null
      and t.payment_status = 'SUCCESS'
      and t.client_id = v_client
      and t.tx_date = v_date
      and upper(btrim(t.sells_currency)) = v_sells
      and upper(btrim(t.gets_currency)) = v_gets
      and case
            when upper(btrim(t.sells_currency)) = 'GEL'
              or upper(btrim(t.gets_currency)) = 'GEL' then
              case when t.abs_gel > 0 and t.cross_gel = 0 then round(t.abs_gel, 2) end
            else
              case when t.cross_gel > 0 and t.abs_gel = 0 then round(t.cross_gel, 2) end
          end = v_gel
      and (
        t.tx_clock is null
        or date_trunc('minute', (rq.requested_at at time zone 'Asia/Tbilisi'))
           = date_trunc('minute', (t.tx_date + t.tx_clock))
      );
  else
    v_pay_n := 0;
  end if;

  if v_pay_n = 1 and v_req_n = 1 then
    begin
      update public.transactions
         set matched_request_id = v_request
       where id = p_id
         and matched_request_id is distinct from v_request;
    exception
      when unique_violation then
        update public.transactions
           set matched_request_id = null
         where id = p_id
           and matched_request_id is not null;
    end;
  else
    update public.transactions
       set matched_request_id = null
     where id = p_id
       and matched_request_id is not null;
  end if;
end;
$$;

-- Admin only. Changes the payment status of one row and marks it manual.
-- Does not invent a transaction id. A KAM, treasury, or an analyst cannot
-- call it. It does not list other payments.
create or replace function public.set_transaction_status(
  p_id bigint,
  p_payment_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := upper(btrim(coalesce(p_payment_status, '')));
begin
  if not private.is_admin() then
    raise exception 'Only an admin can update a transaction status' using errcode = '42501';
  end if;
  if v_status = '' or char_length(v_status) > 40 then
    raise exception 'Payment status is missing' using errcode = '22023';
  end if;

  perform set_config('kursi.allow_manual_status', 'on', true);

  update public.transactions
     set payment_status = v_status,
         source = 'manual'
   where id = p_id;

  if not found then
    raise exception 'Transaction not found' using errcode = 'P0002';
  end if;

  perform private.attach_payment_by_amount(p_id);
end;
$$;

comment on function public.set_transaction_status(bigint, text) is
  'Admin only. Sets one payment status by hand and marks the row manual. Does not invent a transaction id and does not connect ClickHouse.';

-- Replaces the upload parser from 17_amount_match.sql so a clock time
-- is kept. The upload function calls this one, so remove that first.
-- Adding tx_clock changes the result columns, so the old function is dropped.
drop function if exists public.import_transactions(jsonb);
drop function if exists public.import_transactions(jsonb, bigint, boolean);
drop function if exists private.clean_import_rows(jsonb);

create or replace function private.clean_import_rows(p_rows jsonb)
returns table (
  tx_id text,
  tx_date date,
  tx_clock time,
  client_id text,
  client_name text,
  segment text,
  operation_type text,
  payment_status text,
  abs_gel numeric,
  cross_gel numeric,
  total_income numeric,
  spread_income numeric,
  revaluation numeric,
  sells_currency text,
  gets_currency text
)
language sql stable set search_path = ''
as $$
  select nullif(trim(x.tx_id), ''),
         case when x.tx_date ~ '^\d{4}-\d{2}-\d{2}$' then x.tx_date::date end,
         case
           when btrim(coalesce(x.tx_clock, '')) ~ '^\d{1,2}:\d{2}(:\d{2})?$'
           then btrim(x.tx_clock)::time
         end,
         private.normalize_client_id(x.client_id),
         nullif(left(btrim(coalesce(x.client_name, '')), 200), ''),
         nullif(btrim(x.segment), ''),
         nullif(btrim(x.operation_type), ''),
         upper(nullif(btrim(x.payment_status), '')),
         round(coalesce(x.abs_gel, 0), 2),
         round(coalesce(x.cross_gel, 0), 2),
         round(coalesce(x.total_income, 0), 2),
         round(x.spread_income, 2),
         round(x.revaluation, 2),
         case when upper(btrim(coalesce(x.sells_currency, ''))) ~ '^[A-Z]{3}$'
              then upper(btrim(x.sells_currency)) end,
         case when upper(btrim(coalesce(x.gets_currency, ''))) ~ '^[A-Z]{3}$'
              then upper(btrim(x.gets_currency)) end
  from jsonb_to_recordset(p_rows) as x(
    tx_id text, tx_date text, tx_clock text, client_id text, client_name text,
    segment text, operation_type text, payment_status text,
    abs_gel numeric, cross_gel numeric, total_income numeric,
    spread_income numeric, revaluation numeric,
    sells_currency text, gets_currency text
  )
$$;

revoke all on function private.clean_import_rows(jsonb) from public, anon, authenticated;

-- Drop the one-argument form so PostgREST does not see two uploads.
drop function if exists public.import_transactions(jsonb);
drop function if exists public.import_transactions(jsonb, bigint, boolean);

-- Same upload as 17_amount_match.sql, plus the clock.
-- A row with tx_clock matches a request only at that minute in Tbilisi.
-- A row with no clock still matches by day. A manual row is not replaced.
create or replace function public.import_transactions(
  p_rows jsonb,
  p_run bigint default null,
  p_finish boolean default false
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_run        bigint;
  v_before     bigint;
  v_after      bigint;
  v_upserted   int := 0;
  v_skipped    int := 0;
  v_clients    int := 0;
  v_matched    int := 0;
  v_ambiguous  int := 0;
  v_touch      int := 0;
  v_amount     boolean;
  r            record;
  f            jsonb;
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

  v_amount := not exists (
    select 1 from private.clean_import_rows(p_rows) c where c.tx_id is not null
  );

  if v_amount and p_finish and p_run is null then
    raise exception 'Upload run not found';
  end if;

  if v_amount and p_run is not null then
    select s.id into v_run
    from private.sync_runs s
    where s.id = p_run and s.kind = 'upload';
    if v_run is null then
      raise exception 'Upload run not found';
    end if;
  elsif not (v_amount and jsonb_array_length(p_rows) = 0) then
    insert into private.sync_runs (kind) values ('upload') returning id into v_run;
  end if;

  if jsonb_array_length(p_rows) > 0 then
    select count(*) into v_before from public.clients;

    if v_amount then
      with good as (
        select c.*
        from private.clean_import_rows(p_rows) c
        where c.tx_id is null
          and c.tx_date is not null
          and c.client_id <> ''
          and c.payment_status is not null
          and lower(coalesce(c.operation_type, '')) not in
              ('position-close-in-bank', 'fastoo', 'bitnet', 'unipay')
          and not exists (
            select 1
            from public.transactions m
            where m.source = 'manual'
              and m.client_id = c.client_id
              and m.tx_date = c.tx_date
              and m.sells_currency is not distinct from c.sells_currency
              and m.gets_currency is not distinct from c.gets_currency
              and m.abs_gel = round(coalesce(c.abs_gel, 0), 2)
              and m.cross_gel = round(coalesce(c.cross_gel, 0), 2)
              and to_char(m.tx_clock, 'HH24:MI') is not distinct from to_char(c.tx_clock, 'HH24:MI')
          )
      ),
      added as (
        insert into public.clients as cl (client_id, name)
        select distinct on (g.client_id) g.client_id, g.client_name
        from good g
        where g.client_id ~ '^([0-9]{9}|[0-9]{11})$'
        order by g.client_id, g.client_name nulls last
        on conflict (client_id) do update
          set name = coalesce(cl.name, excluded.name)
        returning 1
      ),
      saved as (
        insert into public.transactions (
          tx_id, tx_time, tx_date, tx_clock, client_id, segment, operation_type, payment_status,
          abs_gel, cross_gel, total_income, spread_income, revaluation, synced_at,
          sells_currency, gets_currency, import_run
        )
        select null,
               (g.tx_date + coalesce(g.tx_clock, time '12:00')) at time zone 'Asia/Tbilisi',
               g.tx_date, g.tx_clock, g.client_id, g.segment, g.operation_type, g.payment_status,
               g.abs_gel, g.cross_gel, g.total_income, g.spread_income, g.revaluation, now(),
               g.sells_currency, g.gets_currency, v_run
        from good g
        returning 1
      )
      select (select count(*) from saved),
             (select count(*) from private.clean_import_rows(p_rows)) - (select count(*) from good),
             (select count(*) from added)
        into v_upserted, v_skipped, v_touch;
    else
      with good as (
        select distinct on (c.tx_id) c.*
        from private.clean_import_rows(p_rows) c
        where c.tx_id is not null
          and c.tx_date is not null
          and c.client_id <> ''
          and c.payment_status is not null
          and lower(coalesce(c.operation_type, '')) not in
              ('position-close-in-bank', 'fastoo', 'bitnet', 'unipay')
        order by c.tx_id
      ),
      added as (
        insert into public.clients as cl (client_id, name)
        select distinct on (g.client_id) g.client_id, g.client_name
        from good g
        where g.client_id ~ '^([0-9]{9}|[0-9]{11})$'
        order by g.client_id, g.client_name nulls last
        on conflict (client_id) do update
          set name = coalesce(cl.name, excluded.name)
        returning 1
      ),
      saved as (
        insert into public.transactions as t (
          tx_id, tx_time, tx_date, tx_clock, client_id, segment, operation_type, payment_status,
          abs_gel, cross_gel, total_income, spread_income, revaluation, synced_at,
          sells_currency, gets_currency
        )
        select g.tx_id,
               (g.tx_date + coalesce(g.tx_clock, time '12:00')) at time zone 'Asia/Tbilisi',
               g.tx_date, g.tx_clock, g.client_id, g.segment, g.operation_type, g.payment_status,
               g.abs_gel, g.cross_gel, g.total_income, g.spread_income, g.revaluation, now(),
               g.sells_currency, g.gets_currency
        from good g
        on conflict (tx_id) do update set
          tx_time = excluded.tx_time,
          tx_date = excluded.tx_date,
          tx_clock = excluded.tx_clock,
          client_id = excluded.client_id,
          segment = excluded.segment,
          operation_type = excluded.operation_type,
          payment_status = excluded.payment_status,
          abs_gel = excluded.abs_gel,
          cross_gel = excluded.cross_gel,
          total_income = excluded.total_income,
          spread_income = excluded.spread_income,
          revaluation = excluded.revaluation,
          synced_at = now(),
          sells_currency = coalesce(excluded.sells_currency, t.sells_currency),
          gets_currency = coalesce(excluded.gets_currency, t.gets_currency)
        where t.source is distinct from 'manual'
        returning 1
      )
      select (select count(*) from saved),
             (select count(*) from private.clean_import_rows(p_rows)) - (select count(*) from good),
             (select count(*) from added)
        into v_upserted, v_skipped, v_touch;
    end if;

    select count(*) into v_after from public.clients;
    v_clients := v_after - v_before;
  end if;

  if v_amount and p_finish then
    delete from public.transactions prev
    where prev.tx_id is null
      and prev.source is distinct from 'manual'
      and prev.import_run is distinct from v_run
      and prev.tx_date in (
        select n.tx_date
        from public.transactions n
        where n.import_run = v_run and n.tx_id is null
      );

    update public.transactions pay
       set matched_request_id = null
     where pay.import_run = v_run
       and pay.tx_id is null
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
      where t.import_run = v_run
        and t.tx_id is null
        and t.payment_status = 'SUCCESS'
        and t.source is distinct from 'manual'
    ),
    pairs as (
      select p.id as pay_id, rq.id as request_id
      from pays p
      join public.requests rq
        on rq.client_id = p.client_id
       and rq.request_date = p.tx_date
       and upper(rq.sells_currency) = p.sells_currency
       and upper(rq.gets_currency) = p.gets_currency
       and round(coalesce(
             rq.gel_amount,
             private.request_gel(
               rq.sells_currency, rq.gets_currency, rq.amount, rq.gets_amount,
               coalesce(rq.approved_rate, rq.rate)
             )
           ), 2) = p.file_gel
       and (
         p.tx_clock is null
         or date_trunc('minute', (rq.requested_at at time zone 'Asia/Tbilisi'))
            = date_trunc('minute', (p.tx_date + p.tx_clock))
       )
      where p.file_gel is not null
        and p.sells_currency is not null
        and p.gets_currency is not null
    ),
    pay_n as (
      select pay_id, count(*) as n from pairs group by pay_id
    ),
    req_n as (
      select request_id, count(*) as n from pairs group by request_id
    ),
    unique_pairs as (
      select p.pay_id, p.request_id
      from pairs p
      join pay_n pn on pn.pay_id = p.pay_id and pn.n = 1
      join req_n rn on rn.request_id = p.request_id and rn.n = 1
    ),
    ambiguous_pays as (
      select distinct p.pay_id
      from pairs p
      join pay_n pn on pn.pay_id = p.pay_id
      join req_n rn on rn.request_id = p.request_id
      where pn.n > 1 or rn.n > 1
    ),
    updated as (
      update public.transactions t
         set matched_request_id = u.request_id
        from unique_pairs u
       where t.id = u.pay_id
         and t.import_run = v_run
         and t.tx_id is null
         and t.source is distinct from 'manual'
      returning t.id
    )
    select (select count(*) from updated),
           (select count(*) from ambiguous_pays)
      into v_matched, v_ambiguous;

    begin
      for r in
        select q.id, q.kam_id
        from public.requests q
        join public.transactions pay on pay.matched_request_id = q.id
        where pay.import_run = v_run
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
  end if;

  if v_run is not null then
    if v_amount and not p_finish then
      update private.sync_runs
         set rows_upserted = coalesce(rows_upserted, 0) + v_upserted
       where id = v_run;
    else
      update private.sync_runs
         set finished_at = now(),
             ok = true,
             rows_upserted = coalesce(rows_upserted, 0) + v_upserted
       where id = v_run;
    end if;
  end if;

  return jsonb_build_object(
    'upserted', v_upserted,
    'skipped', v_skipped,
    'clients_added', v_clients,
    'run_id', case when v_amount then v_run end,
    'matched', v_matched,
    'ambiguous', v_ambiguous
  );
exception when others then
  if v_run is not null then
    update private.sync_runs
       set finished_at = now(), ok = false, error = sqlerrm
     where id = v_run;
  end if;
  raise;
end;
$$;

revoke all on function private.prepare_transaction_row() from public, anon, authenticated;
revoke all on function private.attach_payment_by_amount(bigint) from public, anon, authenticated;
revoke all on function private.clean_import_rows(jsonb) from public, anon, authenticated;
revoke all on function public.set_transaction_status(bigint, text) from public, anon;
revoke all on function public.import_transactions(jsonb, bigint, boolean) from public, anon;
grant execute on function public.set_transaction_status(bigint, text) to authenticated;
grant execute on function public.import_transactions(jsonb, bigint, boolean) to authenticated;
