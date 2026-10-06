\pset footer off
\pset tuples_only off
-- Make.com webhooks for treasury and KAMs; admins have none yet
insert into vault.secrets (name, secret) values
  ('make_webhook_treasury', 'https://hook.eu1.make.com/treasury-test'),
  ('make_webhook_kam',      'https://hook.eu1.make.com/kam-test'),
  ('make_webhook_token',    'shared-token-123');
update public.rules set app_url = 'https://kam.kursi.ge';
update public.profiles set phone = '+995599000111', notify_channels = '{sms,email}' where email = 'n.philauri@kursi.ge';
update public.profiles set notify_channels = '{whatsapp}', phone = '+995599000222' where email = 'dealer@kursi.ge';
delete from public.notification_events;

\echo '--- KAM asks: treasury gets request.new'
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.log_request('405123987','USD','GEL',120000,'Client wants it before noon') as n1 \gset
select public.log_request('400987123','GEL','USD',200000) as n2 \gset
commit;
select event_type, audience, status, payload->'recipients'->0->>'name' as to_whom, payload->'recipients'->0->'channels' as channels,
       payload->'message'->>'en' as en from public.notification_events where request_id = :n1;
select payload->'message'->>'ka' as ka, payload->>'link' as link from public.notification_events where request_id = :n1;
select url, headers->>'X-Kursi-Token' as token, (body->>'event_id') is not null as has_event_id from net.http_request_log order by id desc limit 1;

\echo '--- treasury answers: the KAM gets rate.ready and request.sent_back'
begin; set local role authenticated; set local request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
select public.treasury_quote(:n1, 2.6895, 15) is not null as quoted;
select public.treasury_decline(:n2, 'Amount too large');
commit;
select event_type, audience, status, payload->'recipients'->0->>'phone' as phone, payload->'message'->>'en' as en
from public.notification_events where request_id in (:n1, :n2) and audience = 'kam' order by id;

\echo '--- KAM asks again: treasury gets request.asked_again'
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.ask_again(:n2, 'Client can split it');
commit;
select event_type, payload->'message'->>'en' as en from public.notification_events where request_id = :n2 and event_type = 'request.asked_again';

\echo '--- waiting too long: one alert, even when the timer runs twice'
update public.requests set asked_at = now() - interval '4 minutes' where id = :n2;
select private.notify_timers(); select private.notify_timers();
select count(*) as waiting_alerts, max(payload->'message'->>'en') as en from public.notification_events where request_id = :n2 and event_type = 'request.waiting_long';

\echo '--- rate about to expire: one warning to the KAM'
update public.requests set rate_valid_until = now() + interval '90 seconds' where id = :n1;
select private.notify_timers(); select private.notify_timers();
select count(*) as expiry_warnings, max(payload->'message'->>'en') as en from public.notification_events where request_id = :n1 and event_type = 'rate.expiring';

\echo '--- the client''s transaction arrives: the KAM hears it went through, once'
insert into ch.client_transactions values ('n-tx-1', (now() at time zone 'UTC'), (now() at time zone 'Asia/Tbilisi')::date, '405123987', 'corporate', 'conversion', 'SUCCESS', 120000, 0, 300, 300, 0);
select private.sync_transactions(1, 'hourly'); select private.sync_transactions(1, 'hourly');
select count(*) as went_through_msgs, max(payload->'message'->>'ka') as ka from public.notification_events where request_id = :n1 and event_type = 'request.went_through';

\echo '--- a failed sync tells admins (no admin webhook yet -> no_webhook)'
insert into private.sync_runs (kind, from_date) values ('hourly', current_date) returning id as run_id \gset
update private.sync_runs set ok = false, finished_at = now(), error = 'Could not reach ClickHouse' where id = :run_id;
select event_type, audience, status, payload->'recipients'->0->>'name' as to_whom, payload->'message'->>'en' as en from public.notification_events where event_type = 'sync.failed';

\echo '--- Make answers: 200 -> delivered; 500 -> retried'
insert into net._http_response (id, status_code) select net_request_id, 200 from public.notification_events where event_type = 'request.new' and request_id = :n1;
insert into net._http_response (id, status_code, error_msg) select net_request_id, 500, '' from public.notification_events where event_type = 'rate.ready';
select private.reconcile_notifications();
select event_type, status, attempts, last_error from public.notification_events where (event_type = 'request.new' and request_id = :n1) or event_type = 'rate.ready' order by id;

\echo '--- morning summary for KAMs with follow-ups'
update public.requests set request_date = (now() at time zone 'Asia/Tbilisi')::date - 1 where id = :n2;
select private.notify_daily_followups() as digests_sent;
select private.notify_daily_followups() as digests_sent_again;
select payload->'message'->>'en' as en, payload->'message'->>'ka' as ka from public.notification_events where event_type = 'followups.daily';

\echo '--- a switched-off message is not sent'
update public.notification_rules set enabled = false where event_type = 'request.new';
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.log_request('405123987','EUR','GEL',5000) as n3 \gset
commit;
select count(*) as events_for_switched_off from public.notification_events where request_id = :n3;
update public.notification_rules set enabled = true where event_type = 'request.new';

\echo '--- if Make cannot be reached, the request still goes through'
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
returns bigint language plpgsql as $$ begin raise exception 'network down'; end $$;
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.log_request('405123987','GBP','GEL',7000) as n4 \gset
commit;
select (select count(*) from public.requests where id = :n4) as request_saved, status, last_error from public.notification_events where request_id = :n4;

\echo '--- access: admin reads the log and can send a test; KAM cannot'
begin; set local role authenticated; set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select count(*) > 0 as admin_reads_log from public.notification_events;
select public.send_test_notification('rate.ready') as test_events;
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select count(*) as kam_reads_log from public.notification_events;
do $$ begin perform public.send_test_notification('rate.ready'); raise notice 'FAIL KAM sent a test'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
do $$ begin update public.notification_rules set enabled = false; if found then raise notice 'FAIL KAM switched messages off'; else raise notice 'OK KAM cannot switch messages'; end if; end $$;
select count(*) as winback_still_works from public.winback_list();
commit;
