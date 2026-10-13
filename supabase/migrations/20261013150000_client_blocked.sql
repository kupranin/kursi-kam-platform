-- Paste this in the Supabase SQL editor when you want the change.
-- Copy it from disk. Paste it after 33_active_reads.sql.
-- Do not re-run 1_platform.sql. Do not paste the index file.
-- Safe to paste again. It does not drop a view and does not edit
-- request_outcomes. It does not delete a deal or mark one lost.
--
-- clients.blocked is the client, not one request. Later deals for that
-- client show the same on state. Turning it on or off does not delete
-- or lose any other deal. Treasury or an admin can switch it. A KAM,
-- a manager, and an analyst can see it on a deal they can already see,
-- and cannot switch it here.

alter table public.clients
  add column if not exists blocked boolean not null default false;

comment on column public.clients.blocked is
  'Treasury or an admin marked this client blocked. Other deals stay. The flag is only a label on the client.';

create or replace function public.set_client_blocked(p_client_id text, p_blocked boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if private.my_profile_id() is null or private.my_role() not in ('treasury', 'admin') then
    raise exception 'მხოლოდ ხაზინას ან ადმინს შეუძლია კლიენტის დაბლოკვა' using errcode = '42501';
  end if;
  if p_client_id is null or p_blocked is null then
    raise exception 'კლიენტი ვერ მოიძებნა' using errcode = '22023';
  end if;

  update public.clients
     set blocked = p_blocked
   where client_id = p_client_id;

  if not found then
    raise exception 'კლიენტი ვერ მოიძებნა' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.set_client_blocked(text, boolean) is
  'Turns clients.blocked on or off. Treasury or an admin. Does not change requests.';

revoke all on function public.set_client_blocked(text, boolean) from public, anon;
grant execute on function public.set_client_blocked(text, boolean) to authenticated;

-- Ids in this list that are blocked, and only when the caller can already
-- see that client: admin, manager, and treasury see every client; an
-- analyst sees the flag on deals they can read; a KAM sees their own client.
create or replace function public.client_blocked_ids(p_ids text[])
returns table (client_id text, blocked boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.client_id, c.blocked
  from public.clients c
  where c.client_id = any (coalesce(p_ids, '{}'::text[]))
    and c.blocked
    and (
      private.my_role() in ('admin', 'manager', 'treasury', 'analyst')
      or private.is_my_client(c.client_id)
    );
$$;

comment on function public.client_blocked_ids(text[]) is
  'Blocked clients among the ids the screen already loaded. Does not list clients the caller cannot see.';

revoke all on function public.client_blocked_ids(text[]) from public, anon;
grant execute on function public.client_blocked_ids(text[]) to authenticated;
