\pset footer off
\echo '--- a client who converted this morning: a new request is not done until a new transaction'
insert into ch.client_transactions values ('am-tx', (now() at time zone 'UTC') - interval '3 hours', (now() at time zone 'Asia/Tbilisi')::date, '400987123', 'corporate', 'conversion', 'SUCCESS', 1000, 0, 2, 2, 0);
select private.sync_transactions(1, 'hourly');
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.log_request('400987123','GEL','USD',3000) as la \gset
select went_through as went_through_before, outcome from public.request_outcomes where id = :la;
commit;
insert into ch.client_transactions values ('pm-tx', (now() at time zone 'UTC') + interval '1 minute', (now() at time zone 'Asia/Tbilisi')::date, '400987123', 'corporate', 'conversion', 'SUCCESS', 3000, 0, 5, 5, 0);
select private.sync_transactions(1, 'hourly');
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select went_through as went_through_after from public.request_outcomes where id = :la;
select count(*) as imported_still_same_day from public.request_outcomes where source = 'import';
select count(*) as imported_waiting_for_treasury from public.requests where source = 'import' and quote_status = 'asking';
commit;
