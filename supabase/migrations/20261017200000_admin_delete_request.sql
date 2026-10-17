-- Paste this in the Supabase SQL editor after 29_no_delete_written.sql.
-- Do not re-run 29 after this file. If you do, paste this file again.
-- Do not re-run 49, 50, or 51. Do not re-run 1_platform.sql.
-- Safe to paste again. The test delete below matches nothing the second time.
--
-- An admin, and only private.is_admin(), may delete any request, including
-- one with rate_written_at set. A KAM still deletes only their own request,
-- and still cannot delete a written rate. Manager, treasury, and analyst
-- are not in this bypass.
--
-- requests_block_delete_written is BEFORE DELETE, so it used to abort the
-- row before audit_requests (AFTER DELETE, private.audit_row) could write.
-- The admin path now returns the row. audit_requests is not dropped and
-- not disabled. It still stores actor_profile_id from private.my_profile_id(),
-- at, action delete, table_name requests, row_key, and old_data for the request.
--
-- The SQL editor has no auth.uid(), so private.is_admin() is false there.
-- The one-time test delete below turns off only requests_block_delete_written
-- for those rows, then turns it back on in the same statement.
-- audit_requests stays on. If it does not record every deleted row, the
-- statement raises and the delete rolls back.

create or replace function private.block_delete_written_rate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.rate_written_at is not null and not private.is_admin() then
    raise exception 'გაწერილი კურსის შემდეგ გარიგება ვერ იშლება' using errcode = '22023';
  end if;
  return old;
end;
$$;

revoke all on function private.block_delete_written_rate() from public, anon, authenticated;

drop trigger if exists requests_block_delete_written on public.requests;
create trigger requests_block_delete_written
  before delete on public.requests
  for each row
  execute function private.block_delete_written_rate();

drop policy if exists requests_admin_delete on public.requests;
drop policy if exists requests_delete on public.requests;

create policy requests_delete on public.requests
  for delete to authenticated
  using (
    (select private.is_admin())
    or (
      rate_written_at is null
      and (select private.my_role()) = 'kam'
      and kam_id = (select private.my_profile_id())
    )
  );

create or replace function public.delete_request(p_request_id bigint)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me  uuid := private.my_profile_id();
  v_req public.requests%rowtype;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;
  if private.my_role() not in ('admin', 'kam') then
    raise exception 'Your account cannot delete requests' using errcode = '42501';
  end if;
  select * into v_req from public.requests r where r.id = p_request_id;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_req.kam_id is distinct from v_me and not private.is_admin() then
    raise exception 'This request belongs to another KAM' using errcode = '42501';
  end if;
  if v_req.rate_written_at is not null and not private.is_admin() then
    raise exception 'გაწერილი კურსის შემდეგ გარიგება ვერ იშლება' using errcode = '22023';
  end if;

  delete from public.quotes q where q.request_id = p_request_id;
  update public.user_notifications n set request_id = null where n.request_id = p_request_id;
  update public.notification_events e set request_id = null where e.request_id = p_request_id;
  update public.transactions t set matched_request_id = null where t.matched_request_id = p_request_id;
  delete from public.requests r where r.id = p_request_id;
end;
$$;

revoke all on function public.delete_request(bigint) from public, anon;
grant execute on function public.delete_request(bigint) to authenticated;

-- One-time test delete. Screen client_name is public.clients.name.
-- Known deal, not part of the predicate: 17 Oct 2026 about 18:30 Asia/Tbilisi,
-- sells USD 2000, gets GEL, rate 2.20000, bank TBC, KAM Nino Kuprashvili.
-- Every app request with this normalized client id and this exact name is removed.
-- A different client id is kept. An import for this client is kept. The client row stays.
do $delete_test_requests$
declare
  v_ids    bigint[];
  v_before bigint;
  v_n      int;
  v_audit  int;
begin
  select coalesce(array_agg(r.id), '{}'::bigint[])
    into v_ids
  from public.requests r
  join public.clients c on c.client_id = r.client_id
  where private.normalize_client_id(r.client_id) = '61001077711'
    and c.name = 'Test Test'
    and r.source = 'app';

  if cardinality(v_ids) = 0 then
    raise notice 'No app request matched normalized client id 61001077711 and client name Test Test.';
    return;
  end if;

  select coalesce(max(a.id), 0) into v_before from public.audit_log a;

  alter table public.requests disable trigger requests_block_delete_written;

  delete from public.quotes q
  where q.request_id = any (v_ids);

  update public.user_notifications n
     set request_id = null
   where n.request_id = any (v_ids);

  update public.notification_events e
     set request_id = null
   where e.request_id = any (v_ids);

  update public.transactions t
     set matched_request_id = null
   where t.matched_request_id = any (v_ids);

  delete from public.requests r
  using public.clients c
  where r.id = any (v_ids)
    and c.client_id = r.client_id
    and private.normalize_client_id(r.client_id) = '61001077711'
    and c.name = 'Test Test'
    and r.source = 'app';

  get diagnostics v_n = row_count;

  select count(*)::int into v_audit
  from public.audit_log a
  where a.id > v_before
    and a.action = 'delete'
    and a.table_name = 'requests'
    and a.row_key in (select u.id::text from unnest(v_ids) as u(id));

  alter table public.requests enable trigger requests_block_delete_written;

  if v_n <> cardinality(v_ids) then
    raise exception 'Test delete stopped: matched % app requests and deleted %.', cardinality(v_ids), v_n;
  end if;
  if v_audit <> v_n then
    raise exception 'Test delete stopped: audit_log recorded % of % deleted requests.', v_audit, v_n;
  end if;

  raise notice 'Deleted % app request(s) for client 61001077711 named Test Test: %.', v_n, v_ids;
exception
  when others then
    begin
      alter table public.requests enable trigger requests_block_delete_written;
    exception
      when others then
        raise notice 'Could not re-enable requests_block_delete_written: %', sqlerrm;
    end;
    raise;
end
$delete_test_requests$;

select r.id, r.client_id, c.name as client_name, r.source, r.rate_written_at
from public.requests r
join public.clients c on c.client_id = r.client_id
where private.normalize_client_id(r.client_id) = '61001077711'
  and c.name = 'Test Test'
order by r.id;

select a.at, a.actor_profile_id, a.action, a.table_name, a.row_key,
       (a.old_data is not null) as has_request
from public.audit_log a
where a.action = 'delete'
  and a.table_name = 'requests'
  and private.normalize_client_id(a.old_data ->> 'client_id') = '61001077711'
  and a.old_data ->> 'source' = 'app'
  and a.at > now() - interval '5 minutes'
order by a.id;
