-- =====================================================================
-- KAM platform, migration 5 of 6: syncing transactions, importing history
--
-- Two notes on querying ClickHouse through the wrapper:
--   * Date filters use ">=" only. An open bug report shows BETWEEN on a
--     foreign table can be sent to ClickHouse wrongly and silently
--     return wrong rows.
--   * Queries are built with literal values (EXECUTE format), so the
--     date and client filters run on ClickHouse instead of pulling
--     the whole table across.
-- =====================================================================

-- The one upsert statement both sync paths use. p_where is appended to
-- the ClickHouse query; it must only filter on tx_date and client_id.
create or replace function private.transactions_upsert_sql(p_where text)
returns text
language sql immutable set search_path = ''
as $$
  select format($sql$
    insert into public.transactions as t (
      tx_id, tx_time, tx_date, client_id, segment, operation_type, payment_status,
      abs_gel, cross_gel, total_income, spread_income, revaluation, synced_at
    )
    select s.tx_id,
           s.tx_time at time zone 'UTC',
           s.tx_date,
           private.normalize_client_id(s.client_id),
           s.segment,
           s.operation_type,
           s.payment_status,
           round(coalesce(s.abs_gel, 0)::numeric, 2),
           round(coalesce(s.cross_gel, 0)::numeric, 2),
           round(coalesce(s.total_income, 0)::numeric, 2),
           round(s.spread_income::numeric, 2),
           round(s.revaluation::numeric, 2),
           now()
    from ch.client_transactions s
    where %s
      and exists (select 1 from public.clients c where c.client_id = private.normalize_client_id(s.client_id))
    on conflict (tx_id) do update set
      tx_time        = excluded.tx_time,
      tx_date        = excluded.tx_date,
      client_id      = excluded.client_id,
      segment        = excluded.segment,
      operation_type = excluded.operation_type,
      payment_status = excluded.payment_status,
      abs_gel        = excluded.abs_gel,
      cross_gel      = excluded.cross_gel,
      total_income   = excluded.total_income,
      spread_income  = excluded.spread_income,
      revaluation    = excluded.revaluation,
      synced_at      = now()
    where (t.payment_status, t.abs_gel, t.cross_gel, t.total_income, t.tx_date, t.client_id)
          is distinct from
          (excluded.payment_status, excluded.abs_gel, excluded.cross_gel, excluded.total_income, excluded.tx_date, excluded.client_id)
  $sql$, p_where)
$$;

-- ---------------------------------------------------------------------
-- Regular sync: re-reads the last p_days days every run, so payment
-- statuses corrected after the fact are picked up too.
-- ---------------------------------------------------------------------
create or replace function private.sync_transactions(p_days int, p_kind text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_run  bigint;
  v_from date := private.tbilisi_today() - p_days;
  v_rows int;
begin
  insert into private.sync_runs (kind, from_date) values (p_kind, v_from) returning id into v_run;
  begin
    execute private.transactions_upsert_sql(format('s.tx_date >= %L::date', v_from));
    get diagnostics v_rows = row_count;
    update private.sync_runs
       set finished_at = now(), ok = true, rows_upserted = v_rows
     where id = v_run;
  exception when others then
    update private.sync_runs
       set finished_at = now(), ok = false, error = sqlerrm
     where id = v_run;
  end;
end;
$$;

-- ---------------------------------------------------------------------
-- Backfill: when a client appears on the platform for the first time,
-- fetch its last p_days of transactions.
-- ---------------------------------------------------------------------
create or replace function private.process_backfill(p_days int default 180, p_batch int default 20)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_client text;
  v_from   date := private.tbilisi_today() - p_days;
  v_rows   int;
  v_total  int := 0;
  v_run    bigint;
begin
  insert into private.sync_runs (kind, from_date) values ('backfill', v_from) returning id into v_run;
  for v_client in
    select q.client_id
    from private.backfill_queue q
    where q.done_at is null and q.attempts < 5
    order by q.queued_at
    limit p_batch
  loop
    begin
      execute private.transactions_upsert_sql(
        format('s.client_id = %L and s.tx_date >= %L::date', v_client, v_from)
      );
      get diagnostics v_rows = row_count;
      v_total := v_total + v_rows;
      update private.backfill_queue
         set done_at = now(), attempts = attempts + 1, last_error = null
       where client_id = v_client;
    exception when others then
      update private.backfill_queue
         set attempts = attempts + 1, last_error = sqlerrm
       where client_id = v_client;
    end;
  end loop;
  update private.sync_runs
     set finished_at = now(), ok = true, rows_upserted = v_total
   where id = v_run;
end;
$$;

-- ---------------------------------------------------------------------
-- One-off import of the cleaned agreement file.
-- Load the file into private.import_requests first (DEPLOY.md, part 7),
-- then: select * from private.run_history_import();
-- Safe to run again: rows already imported are skipped, and rows that
-- failed get their reason in import_error.
-- ---------------------------------------------------------------------
create or replace function private.run_history_import()
returns table (imported int, failed int)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_row       private.import_requests%rowtype;
  v_id        text;
  v_date      date;
  v_kam       uuid;
  v_sells     text;
  v_gets      text;
  v_amount    numeric;
  v_rate      numeric;
  v_req       bigint;
  v_ok        int := 0;
  v_bad       int := 0;
begin
  -- past KAMs without a login get a profile so their history has an owner
  insert into public.profiles (email, full_name, role, active)
  select distinct lower(trim(i.kam_email)), lower(trim(i.kam_email)), 'kam', true
  from private.import_requests i
  where coalesce(trim(i.kam_email), '') <> ''
  on conflict (email) do nothing;

  for v_row in
    select * from private.import_requests i
    where i.imported_request_id is null
    order by i.row_no
  loop
    begin
      v_id := private.normalize_client_id(v_row.client_id);
      if v_id !~ '^([0-9]{9}|[0-9]{11})$' then
        raise exception 'invalid client id: %', v_row.client_id;
      end if;

      v_date := case
        when v_row.request_date ~ '^\d{4}-\d{2}-\d{2}' then to_date(left(v_row.request_date, 10), 'YYYY-MM-DD')
        when v_row.request_date ~ '^\d{1,2}/\d{1,2}/\d{4}' then to_date(v_row.request_date, 'DD/MM/YYYY')
      end;
      if v_date is null then
        raise exception 'invalid date: %', v_row.request_date;
      end if;

      select p.id into v_kam from public.profiles p where p.email = lower(trim(v_row.kam_email));
      if v_kam is null then
        raise exception 'no KAM email';
      end if;

      v_sells  := nullif(upper(trim(coalesce(v_row.sells_currency, ''))), '');
      v_gets   := nullif(upper(trim(coalesce(v_row.gets_currency, ''))), '');
      if v_sells !~ '^[A-Z]{3}$' then v_sells := null; end if;
      if v_gets  !~ '^[A-Z]{3}$' then v_gets  := null; end if;
      if v_sells = v_gets then v_gets := null; end if;
      v_amount := nullif(nullif(regexp_replace(coalesce(v_row.amount, ''), '[^0-9.]', '', 'g'), ''), '.')::numeric;
      v_rate   := nullif(nullif(regexp_replace(coalesce(v_row.rate,   ''), '[^0-9.]', '', 'g'), ''), '.')::numeric;
      if v_amount <= 0 then v_amount := null; end if;
      if v_rate   <= 0 then v_rate   := null; end if;

      insert into public.clients as c (client_id, name)
      values (v_id, nullif(trim(v_row.client_name), ''))
      on conflict (client_id) do update
        set name = coalesce(c.name, excluded.name);

      insert into public.requests (
        kam_id, client_id, requested_at, request_date, sells_currency, gets_currency,
        amount, rate, source, legacy_status, legacy_loss_reason
      ) values (
        v_kam, v_id, (v_date + time '12:00') at time zone 'Asia/Tbilisi', v_date, v_sells, v_gets,
        round(v_amount, 2), v_rate, 'import', nullif(trim(v_row.legacy_status), ''), nullif(trim(v_row.legacy_loss_reason), '')
      )
      returning id into v_req;

      update private.import_requests set imported_request_id = v_req, import_error = null where row_no = v_row.row_no;
      v_ok := v_ok + 1;
    exception when others then
      update private.import_requests set import_error = sqlerrm where row_no = v_row.row_no;
      v_bad := v_bad + 1;
    end;
  end loop;

  -- fetch transaction history for every client the import brought in
  insert into private.backfill_queue (client_id)
  select c.client_id from public.clients c
  on conflict (client_id) do nothing;

  return query select v_ok, v_bad;
end;
$$;

-- ---------------------------------------------------------------------
-- Lock down: internal functions are not callable from the app, except
-- the few helpers the access rules and the outcomes view need.
-- ---------------------------------------------------------------------
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.my_profile_id(), private.my_role(), private.can_see_all(), private.is_admin(),
  private.can_write(), private.is_my_client(text), private.freshness_date(), private.tbilisi_today()
to authenticated;
