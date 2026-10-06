\pset footer off
insert into auth.users values ('55555555-5555-5555-5555-555555555555','dealer@kursi.ge');
insert into public.profiles (auth_user_id,email,full_name,role) values ('55555555-5555-5555-5555-555555555555','dealer@kursi.ge','Test Dealer','treasury');

\echo '--- Natali asks for two rates'
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.log_request('405123987','USD','GEL',100000,'Wants an answer before noon') as r1 \gset
select public.log_request('400987123','GEL','USD',300000) as r2 \gset
commit;

\echo '--- treasury sees both in the queue, oldest first, with the KAM name'
begin; set local role authenticated; set local request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
select request_id = :r1 or request_id = :r2 as mine, kam_name, client_name, sells_currency, gets_currency, amount, note from public.treasury_queue() where request_id in (:r1, :r2);
\echo '--- treasury gives a rate, then cannot answer the same request twice'
select public.treasury_quote(:r1, 2.6895, 15) > now() as valid_in_future;
do $$ begin perform public.treasury_quote(currval('public.requests_id_seq') - 1, 2.70); raise notice 'FAIL quoted twice'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
do $$ begin perform public.treasury_decline(currval('public.requests_id_seq'), ''); raise notice 'FAIL decline without reason'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
select public.treasury_decline(:r2, 'Amount too large');
select count(*) as treasury_sees_requests from public.requests;
select count(*) as treasury_scorecard_rows from public.kam_month_summary('2026-09-01');
do $$ begin perform public.log_request('405123987','USD','GEL',1); raise notice 'FAIL treasury logged a request'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
select client_name, rate, quote_state from public.treasury_quotes_today();
commit;

\echo '--- Natali sees the rate and the reason'
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select id = :r1 as is_r1, quote_state, rate, decline_reason from public.request_outcomes where id in (:r1, :r2) order by id;
do $$ begin perform public.treasury_quote(currval('public.requests_id_seq'), 2.7); raise notice 'FAIL KAM gave a rate'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
do $$ begin perform public.ask_again(currval('public.requests_id_seq') - 1); raise notice 'FAIL asked again while rate valid'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
select public.ask_again(:r2, 'Client can split it in two');
select quote_state, note from public.request_outcomes where id = :r2;
select count(*) as natali_sees_quotes from public.quotes;
commit;

\echo '--- an expired rate can be asked again'
update public.requests set rate_valid_until = now() - interval '1 minute' where id = :r1;
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select quote_state from public.request_outcomes where id = :r1;
select public.ask_again(:r1);
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
select count(*) as back_in_queue from public.treasury_queue() where request_id in (:r1, :r2);
select last_rate from public.treasury_queue() where request_id = :r1;
commit;

\echo '--- others are blocked'
begin; set local role authenticated; set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$ begin perform public.treasury_queue(); raise notice 'FAIL KAM saw the queue'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
do $$ begin perform public.ask_again(currval('public.requests_id_seq')); raise notice 'FAIL Tatia asked again on Natali request'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
select count(*) as tatia_sees_natali_quotes from public.quotes;
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
do $$ begin perform public.treasury_quote(currval('public.requests_id_seq'), 2.7); raise notice 'FAIL manager gave a rate'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
commit;
begin; set local role anon;
do $$ begin perform public.treasury_queue(); raise notice 'FAIL anon'; exception when others then raise notice 'OK anon blocked: %', sqlerrm; end $$;
commit;
