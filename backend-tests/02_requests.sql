\set ON_ERROR_STOP 1
-- Natali logs requests
begin;
set local role authenticated;
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.log_request('405123987','usd','gel',120000,null,'Nova LLC') as nova_req;
select public.log_request('400987123','GEL','USD',410000,null,'J Trade') as jtrade_req;
select public.log_request('1001001234','EUR','GEL',48000,null,'Giorgi B') as person_req;  -- 10-digit, should be padded
select * from public.lookup_client('405123987');
select * from public.lookup_client('12345');
commit;

-- Tatia logs two for Nova, one for her own client
begin;
set local role authenticated;
set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select public.log_request('405123987','USD','GEL',50000);
select public.log_request('405123987','USD','GEL',70000);
select public.log_request('445902117','GEL','USD',250000,null,'Batumi Port Services');
commit;

-- backdate some requests to September / yesterday (as superuser, test only)
update public.requests set request_date = '2026-09-15', requested_at = '2026-09-15 09:00+04' where client_id = '405123987' and kam_id = (select id from profiles where email='n.philauri@kursi.ge');
update public.requests set request_date = '2026-09-16', requested_at = '2026-09-16 10:00+04' where client_id = '405123987' and amount = 50000;
update public.requests set request_date = '2026-09-17', requested_at = '2026-09-17 10:00+04' where client_id = '405123987' and amount = 70000;
update public.requests set request_date = '2026-10-01', requested_at = '2026-10-01 10:00+04' where client_id = '400987123';
update public.requests set request_date = private.tbilisi_today() - 1, requested_at = now() - interval '26 hours' where client_id = '01001001234';
update public.requests set request_date = '2026-09-20', requested_at = '2026-09-20 10:00+04' where client_id = '445902117';

select client_id, name, kind from public.clients order by 1;
select id, client_id, request_date, sells_currency, gets_currency, amount from public.requests order by id;
select client_id from private.backfill_queue order by 1;
