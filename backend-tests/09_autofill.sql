\pset footer off
\echo '--- Natali: empty field shows her recent clients'
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select client_id, name, last_sells_currency, last_gets_currency from public.search_my_clients('');
\echo '--- digits match the start of the ID; a lost leading zero still matches'
select client_id, name from public.search_my_clients('4051');
select client_id, name from public.search_my_clients('1001001');
\echo '--- letters match the name'
select client_id, name from public.search_my_clients('trade');
\echo '--- Tatia-only client is not suggested to Natali'
do $$ begin if exists (select 1 from public.search_my_clients('445')) then raise notice 'FAIL other KAM client suggested'; else raise notice 'OK other KAM client not suggested'; end if; end $$;
do $$ begin if exists (select 1 from public.search_my_clients('%')) then raise notice 'FAIL wildcard matched'; else raise notice 'OK wildcard typed as text'; end if; end $$;
commit;
\echo '--- admin sees all clients'
begin; set local role authenticated; set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select count(*) as admin_sees from public.search_my_clients('', 20);
commit;
begin; set local role anon;
do $$ begin perform public.search_my_clients('4'); raise notice 'FAIL anon'; exception when others then raise notice 'OK anon blocked: %', sqlerrm; end $$;
commit;
