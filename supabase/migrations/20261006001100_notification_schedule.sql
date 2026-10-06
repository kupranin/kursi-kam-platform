-- =====================================================================
-- KAM platform, migration 11: notification schedules (needs pg_cron)
-- Times are UTC. Tbilisi is UTC+4, so 05:30 UTC = 09:30 Tbilisi.
-- =====================================================================

create extension if not exists pg_cron;

-- every minute: waiting-too-long and about-to-expire messages
select cron.schedule('kam-notify-timers',    '* * * * *',  $$select private.notify_timers()$$);

-- every minute: record Make's answers and retry failed messages
select cron.schedule('kam-notify-reconcile', '* * * * *',  $$select private.reconcile_notifications()$$);

-- every working day at 09:30 Tbilisi: KAM follow-up summary
select cron.schedule('kam-notify-daily',     '30 5 * * 1-5', $$select private.notify_daily_followups()$$);

-- weekly: keep 90 days of delivered messages and 30 days of marks
select cron.schedule('kam-notify-cleanup',   '45 0 * * 0', $$
  delete from public.notification_events where created_at < now() - interval '90 days';
  delete from private.notification_marks where created_at < now() - interval '30 days';
$$);
