\pset footer off
\echo '--- Natali: request_outcomes (own only)'
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select id, client_name, request_date, outcome from public.request_outcomes order by id;
\echo '--- Natali: raw tables'
select count(*) as my_requests from public.requests;
select string_agg(client_id, ',' order by client_id) as my_clients from public.clients;
select string_agg(tx_id, ',' order by tx_id) as my_tx from public.transactions;
select count(*) as profiles_visible from public.profiles;
select count(*) as audit_visible from public.audit_log;
\echo '--- Natali: September summary (own row only)'
select kam_name, clients, turnover, turnover_not_successful, income, requests_judged, requests_won, win_rate_pct from public.kam_month_summary('2026-09-01');
commit;

\echo '--- Nino (admin): September portfolio and summary'
begin; set local role authenticated; set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select client_id, owner_name, requests_in_window, turnover, turnover_not_successful, income from public.month_portfolio('2026-09-01');
select kam_name, clients, turnover, turnover_not_successful, income, income_per_1m_turnover, requests_judged, requests_won, win_rate_pct from public.kam_month_summary('2026-09-01');
\echo '--- Nino: win-back list'
select client_id, client_name, owner_name, tier, last_request, last_deal, prior_turnover_gel, max_request_gel, step from public.winback_list();
commit;

\echo '--- Rati (manager) sees all, cannot write'
begin; set local role authenticated; set local request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select count(*) as requests_visible from public.requests;
do $$ begin perform public.log_request('405123987','USD','GEL',1); raise notice 'FAIL: manager could log'; exception when others then raise notice 'OK manager blocked: %', sqlerrm; end $$;
do $$ begin update public.rules set month_grace_days = 2; if found then raise notice 'FAIL: manager changed rules'; else raise notice 'OK manager cannot change rules'; end if; end $$;
commit;

\echo '--- anon gets nothing'
begin; set local role anon;
do $$ begin perform count(*) from public.requests; raise notice 'FAIL anon read'; exception when others then raise notice 'OK anon blocked: %', sqlerrm; end $$;
do $$ begin perform public.kam_month_summary('2026-09-01'); raise notice 'FAIL anon rpc'; exception when others then raise notice 'OK anon rpc blocked: %', sqlerrm; end $$;
commit;
