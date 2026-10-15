-- Paste this in the Supabase SQL editor. Safe to run again.
-- Phone and desktop notifications for notes the app already writes.
-- A chat message still goes to staff_messages. A rate, a waiting request,
-- a client reply, and an approved loss still go through private.inbox_add.
-- This file only delivers those rows when the app is not in front of the person.
-- It does not add a new kind of alert, and it does not notify an analyst
-- about work they do not already receive.
--
-- After pasting, deploy the edge function send-push
-- with Enforce JWT verification turned off.
-- The token below is created here. You do not type or paste that token.
--
-- Set these in Supabase, on the send-push function, not in this file:
--   VAPID_PUBLIC_KEY
--   VAPID_PRIVATE_KEY
--   VAPID_SUBJECT   (mailto: and a real address)
-- Put the same public key in Vercel as VITE_VAPID_PUBLIC_KEY.
-- Never put the private key in Vercel. It would ship to the browser.

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise warning 'pg_net was not enabled: %', sqlerrm;
end
$$;

do $$
begin
  if not exists (select 1 from vault.secrets s where s.name = 'push_dispatch_token') then
    perform vault.create_secret(
      gen_random_uuid()::text || gen_random_uuid()::text,
      'push_dispatch_token',
      'Sent as X-Kursi-Token when a chat message or an inbox row should push'
    );
  end if;
exception when others then
  raise warning 'push token was not created: %', sqlerrm;
end
$$;

-- Only the service key can read the token. The edge function uses that key
-- to check the header. Signed-in people cannot read it.
create or replace function public.push_dispatch_secret()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select ds.decrypted_secret
  from vault.decrypted_secrets ds
  where ds.name = 'push_dispatch_token'
$$;

revoke all on function public.push_dispatch_secret() from public, anon, authenticated;
grant execute on function public.push_dispatch_secret() to service_role;

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  endpoint    text not null,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  lang        text not null default 'ka',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint push_subscriptions_lang_check check (lang in ('ka', 'en'))
);

alter table public.push_subscriptions add column if not exists user_agent text;
alter table public.push_subscriptions add column if not exists lang text not null default 'ka';
alter table public.push_subscriptions add column if not exists updated_at timestamptz not null default now();

do $$
begin
  alter table public.push_subscriptions
    add constraint push_subscriptions_lang_check check (lang in ('ka', 'en'));
exception when duplicate_object then
  null;
end
$$;

comment on table public.push_subscriptions is
  'Browsers that asked for phone or desktop notifications. One row per device. The person can change only their own rows.';

create index if not exists push_subscriptions_profile_idx
  on public.push_subscriptions (profile_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'push_subscriptions_endpoint_key'
      and conrelid = 'public.push_subscriptions'::regclass
  ) then
    alter table public.push_subscriptions
      add constraint push_subscriptions_endpoint_key unique (endpoint);
  end if;
end
$$;

alter table public.push_subscriptions enable row level security;

revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select, delete on public.push_subscriptions to service_role;

drop policy if exists push_subscriptions_select on public.push_subscriptions;
create policy push_subscriptions_select on public.push_subscriptions
  for select to authenticated
  using (profile_id = (select private.my_profile_id()));

drop policy if exists push_subscriptions_insert on public.push_subscriptions;
create policy push_subscriptions_insert on public.push_subscriptions
  for insert to authenticated
  with check (profile_id = (select private.my_profile_id()));

drop policy if exists push_subscriptions_update on public.push_subscriptions;
create policy push_subscriptions_update on public.push_subscriptions
  for update to authenticated
  using (profile_id = (select private.my_profile_id()))
  with check (profile_id = (select private.my_profile_id()));

drop policy if exists push_subscriptions_delete on public.push_subscriptions;
create policy push_subscriptions_delete on public.push_subscriptions
  for delete to authenticated
  using (profile_id = (select private.my_profile_id()));

-- The browser's endpoint belongs to whoever is signed in on that device.
-- A previous person's row for the same endpoint is replaced, because the
-- device is no longer theirs. The caller cannot choose someone else's id.
create or replace function public.save_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text,
  p_lang       text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me       uuid := private.my_profile_id();
  v_endpoint text := btrim(coalesce(p_endpoint, ''));
  v_p256dh   text := btrim(coalesce(p_p256dh, ''));
  v_auth     text := btrim(coalesce(p_auth, ''));
  v_lang     text := case when p_lang = 'en' then 'en' else 'ka' end;
  v_agent    text := nullif(left(btrim(coalesce(p_user_agent, '')), 400), '');
begin
  if v_me is null then
    raise exception 'ჯერ შედით' using errcode = '42501';
  end if;
  if v_endpoint !~ '^https://' or char_length(v_endpoint) > 2000 then
    raise exception 'მისამართი არასწორია' using errcode = '22023';
  end if;
  if v_p256dh !~ '^[A-Za-z0-9_-]{16,200}$' or v_auth !~ '^[A-Za-z0-9_-]{8,200}$' then
    raise exception 'გასაღები არასწორია' using errcode = '22023';
  end if;

  insert into public.push_subscriptions (
    profile_id, endpoint, p256dh, auth, user_agent, lang, updated_at
  ) values (
    v_me, v_endpoint, v_p256dh, v_auth, v_agent, v_lang, now()
  )
  on conflict (endpoint) do update set
    profile_id = excluded.profile_id,
    p256dh     = excluded.p256dh,
    auth       = excluded.auth,
    user_agent = excluded.user_agent,
    lang       = excluded.lang,
    updated_at = now();
end;
$$;

revoke all on function public.save_push_subscription(text, text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text, text) to authenticated;

-- Queues one push. pg_net sends it after the surrounding transaction commits,
-- so a failure here cannot roll back the chat message or the inbox row.
create or replace function private.queue_push(p_body jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if not exists (select 1 from public.push_subscriptions) then
    return;
  end if;

  select ds.decrypted_secret into v_token
  from vault.decrypted_secrets ds
  where ds.name = 'push_dispatch_token';

  if v_token is null or v_token = '' then
    raise warning 'push skipped: vault secret push_dispatch_token is not set';
    return;
  end if;

  begin
    perform net.http_post(
      url := 'https://tktqrdapdvnaznryiije.supabase.co/functions/v1/send-push',
      body := p_body,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Kursi-Token', v_token
      ),
      timeout_milliseconds := 60000
    );
  exception when others then
    raise warning 'push was not sent: %', sqlerrm;
  end;
exception when others then
  raise warning 'push skipped: %', sqlerrm;
end;
$$;

create or replace function private.push_on_inbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.queue_push(jsonb_build_object('kind', 'inbox', 'id', new.id));
  return null;
exception when others then
  raise warning 'push skipped: %', sqlerrm;
  return null;
end;
$$;

create or replace function private.push_on_chat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.queue_push(jsonb_build_object('kind', 'chat', 'id', new.id));
  return null;
exception when others then
  raise warning 'push skipped: %', sqlerrm;
  return null;
end;
$$;

revoke all on function private.queue_push(jsonb) from public, anon, authenticated;
revoke all on function private.push_on_inbox() from public, anon, authenticated;
revoke all on function private.push_on_chat() from public, anon, authenticated;

drop trigger if exists push_inbox_insert on public.user_notifications;
create trigger push_inbox_insert
  after insert on public.user_notifications
  for each row execute function private.push_on_inbox();

drop trigger if exists push_chat_insert on public.staff_messages;
create trigger push_chat_insert
  after insert on public.staff_messages
  for each row execute function private.push_on_chat();
