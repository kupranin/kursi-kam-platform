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
