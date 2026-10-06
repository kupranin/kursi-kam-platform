-- =====================================================================
-- Kursi.ge Business KAM platform: part 2, connect ClickHouse
-- Run after clickhouse/setup.sql on ClickHouse and after storing the Vault secret (DEPLOY.md, step 6).
-- Made from supabase/migrations 400, 600
-- =====================================================================


-- =====================================================================
-- KAM platform, migration 4 of 6: connection to ClickHouse
--
-- Before running:
--   1. The data team has run clickhouse/setup.sql on ClickHouse.
--   2. The connection string is stored in Vault (DEPLOY.md, part 6).
--      It is never written in this file, so no password ends up in git.
-- =====================================================================

create extension if not exists wrappers with schema extensions;

do $$
begin
  if not exists (select 1 from pg_foreign_data_wrapper where fdwname = 'clickhouse_wrapper') then
    create foreign data wrapper clickhouse_wrapper
      handler click_house_fdw_handler
      validator click_house_fdw_validator;
  end if;
end;
$$;

do $$
declare
  v_key uuid;
begin
  select s.id into v_key from vault.secrets s where s.name = 'clickhouse_kam_platform';
  if v_key is null then
    raise exception 'Vault secret "clickhouse_kam_platform" not found. Create it first (DEPLOY.md, part 6).';
  end if;
  if not exists (select 1 from pg_foreign_server where srvname = 'clickhouse_kam') then
    execute format(
      'create server clickhouse_kam foreign data wrapper clickhouse_wrapper options (conn_string_id %L)',
      v_key
    );
  end if;
end;
$$;

-- The foreign table lives in its own schema, which the API never exposes:
-- foreign tables have no row-level security, so users must not reach them.
create schema if not exists ch;
revoke all on schema ch from public, anon, authenticated;

create foreign table ch.client_transactions (
  tx_id           text,
  tx_time         timestamp,          -- UTC
  tx_date         date,               -- Tbilisi calendar date
  client_id       text,               -- already normalised on the ClickHouse side
  segment         text,
  operation_type  text,
  payment_status  text,
  abs_gel         double precision,
  cross_gel       double precision,
  total_income    double precision,
  spread_income   double precision,
  revaluation     double precision
)
server clickhouse_kam
options (table 'kam_client_transactions');

revoke all on all tables in schema ch from public, anon, authenticated;


-- =====================================================================
-- KAM platform, migration 6 of 6: schedules
-- Times are UTC. Tbilisi is UTC+4 all year, so 23:00 UTC = 03:00 Tbilisi.
-- Running this again updates the jobs instead of duplicating them.
-- =====================================================================

create extension if not exists pg_cron;

-- every hour: the last 2 days (so "Today's requests" stays current)
select cron.schedule('kam-sync-hourly',  '5 * * * *',   $$select private.sync_transactions(2, 'hourly')$$);

-- every night at 03:00 Tbilisi: the last 7 days (catches late status corrections)
select cron.schedule('kam-sync-nightly', '0 23 * * *',  $$select private.sync_transactions(7, 'nightly')$$);

-- every 5 minutes: history for clients new to the platform
select cron.schedule('kam-backfill',     '*/5 * * * *', $$select private.process_backfill()$$);

-- weekly: keep 90 days of sync logs
select cron.schedule('kam-sync-cleanup', '30 0 * * 0',  $$delete from private.sync_runs where started_at < now() - interval '90 days'$$);
