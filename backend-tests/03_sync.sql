\set ON_ERROR_STOP 1
insert into ch.client_transactions values
 -- Nova: Sept 16 success (Tatia's request day), Sept 15 failed, big failed on Sept 20
 ('t1','2026-09-16 06:00','2026-09-16','405123987','corporate','conversion','SUCCESS',50000,0,120,100,20),
 ('t2','2026-09-15 06:00','2026-09-15','405123987','corporate','conversion','FAILED',120000,0,-5,0,-5),
 ('t3','2026-09-20 06:00','2026-09-20','405123987','corporate','conversion','FAILED',300000,10000,0,0,0),
 -- J Trade: Oct 1 nothing successful
 ('t4','2026-10-01 07:00','2026-10-01','400987123','corporate','conversion','FAILED',410000,0,0,0,0),
 -- Batumi Port: success in August only (before request) -> win-back candidate
 ('t5','2026-08-02 07:00','2026-08-02','445902117','corporate','conversion','SUCCESS',250000,0,600,600,0),
 -- person with lost leading zero coming from source, success yesterday
 ('t6', (now() at time zone 'UTC') - interval '1 day', (now() at time zone 'Asia/Tbilisi')::date - 1,'1001001234.0','individual','conversion','SUCCESS',48000*3.14,0,90,90,0),
 -- a client that is not on the platform: must not be copied
 ('t7','2026-09-18 07:00','2026-09-18','999999999','corporate','conversion','SUCCESS',1000,0,2,2,0);

-- the nightly job reads 7 days; for the test read 60 so September lands too
select private.sync_transactions(60, 'nightly');
select private.process_backfill();
select kind, ok, rows_upserted, error from private.sync_runs order by id;
select tx_id, client_id, tx_date, payment_status, abs_gel, cross_gel, total_income from public.transactions order by tx_id;

-- status corrected later at the source: t4 becomes SUCCESS
update ch.client_transactions set payment_status = 'SUCCESS' where tx_id = 't4';
select private.sync_transactions(7, 'hourly');
select tx_id, payment_status from public.transactions where tx_id = 't4';
select count(*) as audit_rows from public.audit_log;
