\pset footer off
\echo '--- the feed loads standard and NBG rates (service key)'
begin; set local role service_role;
select public.load_reference_rates('standard', '[
  {"currency":"USD","buy":2.6750,"sell":2.7150,"as_of":"2026-10-06T07:15:00Z"},
  {"currency":"EUR","buy":3.1200,"sell":3.1650,"as_of":"2026-10-06T07:15:00Z"},
  {"currency":"GBP","buy":3.5600,"sell":3.6300,"as_of":"2026-10-06T07:15:00Z"},
  {"currency":"USD","quote_currency":"EUR","buy":0.8640,"sell":0.8700,"as_of":"2026-10-06T07:15:00Z"}
]'::jsonb) as standard_rows;
select public.load_reference_rates('nbg', '[
  {"currency":"USD","official":2.6948,"as_of":"2026-10-06T00:00:00Z"},
  {"currency":"EUR","official":3.1427,"as_of":"2026-10-06T00:00:00Z"}
]'::jsonb) as nbg_rows;
commit;

\echo '--- signed-in users cannot load rates'
begin; set local role authenticated; set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ begin perform public.load_reference_rates('standard', '[]'); raise notice 'FAIL admin loaded rates through the API'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
commit;

\echo '--- treasury sees the full rate sheet; a KAM does not'
begin; set local role authenticated; set local request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
select source, currency, quote_currency, buy, sell, official from public.treasury_rates();
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ begin perform public.treasury_rates(); raise notice 'FAIL KAM saw the rate sheet'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
select count(*) as kam_reads_rate_table from public.reference_rates;
\echo '--- Natali asks for two rates'
select public.log_request('405123987','USD','GEL',40000) as q1 \gset
select public.log_request('404551203','USD','EUR',15000,null,'Saguramo Wines') as q2 \gset
commit;

\echo '--- each queued deal carries its standard, NBG and last-given-today rate'
begin; set local role authenticated; set local request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
select client_name, sells_currency || '>' || gets_currency as direction, standard_rate, nbg_rate, last_given_today
from public.treasury_queue() where request_id in (:q1, :q2) order by request_id;
select public.treasury_quote(:q1, 2.6890) is not null as quoted;
select rate, standard_rate from public.quotes where request_id = :q1 and action = 'quoted';
commit;
