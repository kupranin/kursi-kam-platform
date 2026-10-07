-- Staff chat. Same text as supabase/setup/9_staff_chat.sql.

-- Paste this in the Supabase SQL editor. Safe to run again.
-- Staff chat between people who sign in (admin, manager, treasury, KAM).
-- Every message is kept. There is no edit and no delete.
-- Admin and manager can read every message, because private.can_see_all()
-- is those two roles. Treasury and KAM see only what they sent or received.
-- This does not change requests, rates, or transactions.

create table if not exists public.staff_messages (
  id           bigint generated always as identity primary key,
  sender_id    uuid not null references public.profiles (id),
  recipient_id uuid not null references public.profiles (id),
  body         text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at   timestamptz not null default now(),
  constraint staff_messages_not_self check (sender_id <> recipient_id)
);
comment on table public.staff_messages is
  'Staff-to-staff chat. The row is the record: no update, no delete. Admin and manager read all of it; everyone else reads only their own.';

create index if not exists staff_messages_sender_idx
  on public.staff_messages (sender_id, created_at desc);
create index if not exists staff_messages_recipient_idx
  on public.staff_messages (recipient_id, created_at desc);

alter table public.staff_messages enable row level security;
revoke all on public.staff_messages from anon, authenticated;
grant select, insert on public.staff_messages to authenticated;

-- A person can be picked as a recipient only when they can sign in.
-- Security definer so a KAM or treasury user can message someone whose
-- profile row they are not otherwise allowed to read.
create or replace function private.is_chat_recipient(p_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_id and p.active and p.auth_user_id is not null
  )
$$;

-- Names and roles for the picker and the thread. No email, no phone.
create or replace function public.staff_directory()
returns table (id uuid, full_name text, role text, active boolean)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.full_name, p.role, p.active
  from public.profiles p
  where (select private.my_profile_id()) is not null
    and p.auth_user_id is not null
  order by p.full_name
$$;

revoke execute on function public.staff_directory() from public, anon;
grant execute on function public.staff_directory() to authenticated;

drop policy if exists staff_messages_read on public.staff_messages;
create policy staff_messages_read on public.staff_messages
  for select to authenticated
  using (
    sender_id = (select private.my_profile_id())
    or recipient_id = (select private.my_profile_id())
    or (select private.can_see_all())
  );

drop policy if exists staff_messages_insert on public.staff_messages;
create policy staff_messages_insert on public.staff_messages
  for insert to authenticated
  with check (
    sender_id = (select private.my_profile_id())
    and sender_id <> recipient_id
    and (select private.is_chat_recipient(recipient_id))
  );

-- New private functions are executable by everyone until revoked.
-- Re-grant the helpers the policies call, including the new one.
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.my_profile_id(), private.my_role(), private.can_see_all(), private.is_admin(),
  private.can_write(), private.is_my_client(text), private.freshness_date(), private.tbilisi_today(),
  private.is_treasury(), private.is_chat_recipient(uuid)
to authenticated;

-- Live updates still follow the read rule above.
do $$
begin
  alter publication supabase_realtime add table public.staff_messages;
exception when others then
  raise notice 'Realtime publication not changed: %', sqlerrm;
end;
$$;
