-- After the rate is written (rate_written_at), nobody can delete the deal.
-- A KAM can still delete their own request before that, and an admin can
-- still delete any request before that.

create or replace function private.block_delete_written_rate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.rate_written_at is not null then
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
    rate_written_at is null
    and (
      (select private.is_admin())
      or (
        (select private.my_role()) = 'kam'
        and kam_id = (select private.my_profile_id())
      )
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
  if v_req.rate_written_at is not null then
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
