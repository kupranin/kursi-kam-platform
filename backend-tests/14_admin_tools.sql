\pset footer off
begin; set local role authenticated; set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select (public.admin_sync_status()->'runs'->0->>'kind') is not null as has_runs, public.admin_sync_status()->>'backfill_waiting' as backfill_waiting;
select (public.admin_sync_now()->>'freshness') is not null as synced_now;
select audience, has_webhook, failed_last_24h, waiting from public.admin_message_status();
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ begin perform public.admin_sync_now(); raise notice 'FAIL KAM started a sync'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
do $$ begin perform public.admin_message_status(); raise notice 'FAIL KAM read message status'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
select public.data_freshness() is not null as kam_sees_freshness;
commit;
