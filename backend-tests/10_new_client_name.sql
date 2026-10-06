\pset footer off
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
\echo '--- new ID without a name is refused'
do $$ begin perform public.log_request('412345678','USD','GEL',20000); raise notice 'FAIL new client without name'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
do $$ begin perform public.log_request('412345678','USD','GEL',20000,null,' x '); raise notice 'FAIL one-letter name'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
\echo '--- with a name it goes through and the name is saved'
select public.log_request('412345678','USD','GEL',20000,null,'Mestia Hotels') is not null as logged;
select name from public.clients where client_id = '412345678';
\echo '--- a known client needs no name'
select public.log_request('405123987','USD','GEL',1000) is not null as logged_known;
commit;
\echo '--- a client on file without a name must get one'
insert into public.clients (client_id) values ('499999999');
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ begin perform public.log_request('499999999','USD','GEL',1000); raise notice 'FAIL nameless client'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
select public.log_request('499999999','USD','GEL',1000,null,'Ushguli Tours') is not null as named_now;
select name from public.clients where client_id = '499999999';
commit;
