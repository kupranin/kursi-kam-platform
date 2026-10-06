\pset footer off
update public.requests set created_at = created_at - interval '2 hours';
begin; set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.set_loss_reason(1, 'better_rate');
select public.log_request('405123987','USD','GEL',999) as typo_id \gset
select public.delete_request(:typo_id);
select count(*) as typo_left from public.requests where id = :typo_id;
do $$ begin perform public.delete_request(1); raise notice 'FAIL deleted old request'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
select public.set_winback_step('405123987', 'called', 'Will call back Friday') is not null as step_saved;
do $$ begin perform public.set_winback_step('445902117', 'called'); raise notice 'FAIL step on Tatia client'; exception when others then raise notice 'OK: %', sqlerrm; end $$;
do $$ begin perform public.log_request('12345','USD','GEL',1); exception when others then raise notice 'OK: %', sqlerrm; end $$;
do $$ begin perform public.log_request('405123987','USD','USD',1); exception when others then raise notice 'OK: %', sqlerrm; end $$;
do $$ begin perform public.log_request('405123987','USD','GEL',0); exception when others then raise notice 'OK: %', sqlerrm; end $$;
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select client_id, step from public.winback_list();
select count(*) as tatia_sees_actions_on_shared_client from public.winback_actions;
commit;
\echo '--- admin can delete any request; audit records who'
begin; set local role authenticated; set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.delete_request(6);
commit;
select action, table_name, row_key, (select full_name from public.profiles p where p.id = a.actor_profile_id) as actor
from public.audit_log a where actor_profile_id is not null and table_name <> 'rules' order by id;
