-- In-app notifications, and the mark treasury sets after writing an agreed
-- rate into the core system. Safe to run more than once.
-- Paste this in the Supabase SQL editor after the client-reply setup.
-- Each signed-in person only reads what is for them.
-- An admin or a manager (can_see_all) can also read every row.
-- The browser never uses the service role. Rows are written by the database.

alter table public.requests add column if not exists rate_written_at timestamptz;
alter table public.requests add column if not exists rate_written_by uuid references public.profiles (id);
comment on column public.requests.rate_written_at is
  'When treasury pressed that the agreed rate was entered in the core system.';

create table if not exists public.user_notifications (
  id           bigint generated always as identity primary key,
  audience     text not null check (audience in ('kam', 'treasury', 'manager', 'admin')),
  profile_id   uuid references public.profiles (id) on delete cascade,
  event_type   text not null,
  request_id   bigint references public.requests (id) on delete set null,
  title_ka     text not null,
  title_en     text not null,
  body_ka      text not null,
  body_en      text not null,
  created_at   timestamptz not null default now()
);

create index if not exists user_notifications_created_idx
  on public.user_notifications (created_at desc);

create table if not exists public.user_notification_reads (
  notification_id bigint not null references public.user_notifications (id) on delete cascade,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, profile_id)
);

alter table public.user_notifications enable row level security;
alter table public.user_notification_reads enable row level security;

revoke all on public.user_notifications, public.user_notification_reads from anon, authenticated;
grant select on public.user_notifications to authenticated;
grant select, insert on public.user_notification_reads to authenticated;

drop policy if exists user_notifications_read on public.user_notifications;
create policy user_notifications_read on public.user_notifications
  for select to authenticated
  using (
    profile_id = (select private.my_profile_id())
    or (profile_id is null and audience = (select private.my_role()))
    or (select private.can_see_all())
  );

drop policy if exists user_notification_reads_read on public.user_notification_reads;
create policy user_notification_reads_read on public.user_notification_reads
  for select to authenticated
  using (
    profile_id = (select private.my_profile_id())
    or (select private.can_see_all())
  );

drop policy if exists user_notification_reads_insert on public.user_notification_reads;
create policy user_notification_reads_insert on public.user_notification_reads
  for insert to authenticated
  with check (profile_id = (select private.my_profile_id()));

create or replace function private.inbox_add(
  p_audience text,
  p_profile  uuid,
  p_event    text,
  p_request  bigint,
  p_title_ka text,
  p_title_en text,
  p_body_ka  text,
  p_body_en  text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_notifications (
    audience, profile_id, event_type, request_id, title_ka, title_en, body_ka, body_en
  ) values (
    p_audience, p_profile, p_event, p_request, p_title_ka, p_title_en, p_body_ka, p_body_en
  );
end;
$$;

revoke all on function private.inbox_add(text, uuid, text, bigint, text, text, text, text)
  from public, anon, authenticated;

create or replace function private.inbox_on_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client text;
  v_kam    text;
  v_pair   text;
  v_rate   text;
begin
  if new.source is distinct from 'app' then
    return null;
  end if;

  select coalesce(c.name, new.client_id) into v_client
  from public.clients c
  where c.client_id = new.client_id;
  v_client := coalesce(v_client, new.client_id);

  select p.full_name into v_kam from public.profiles p where p.id = new.kam_id;
  v_kam := coalesce(v_kam, 'KAM');
  v_pair := coalesce(new.sells_currency, '') || ' → ' || coalesce(new.gets_currency, '');
  v_rate := coalesce(to_char(new.rate, 'FM9990.0000'), '');

  if tg_op = 'INSERT' then
    perform private.inbox_add(
      'treasury', null, 'request.new', new.id,
      'ახალი მოთხოვნა', 'New request',
      v_kam || ': ' || v_client || ', ' || v_pair,
      v_kam || ': ' || v_client || ', ' || v_pair
    );
    return null;
  end if;

  if old.quote_status is distinct from 'asking' and new.quote_status = 'asking' then
    perform private.inbox_add(
      'treasury', null, 'request.new', new.id,
      'ახალი მოთხოვნა', 'New request',
      v_kam || ' ხელახლა იკითხა: ' || v_client || ', ' || v_pair,
      v_kam || ' asked again: ' || v_client || ', ' || v_pair
    );
  end if;

  if old.quote_status = 'asking' and new.quote_status = 'quoted' then
    perform private.inbox_add(
      'kam', new.kam_id, 'rate.quoted', new.id,
      'სახაზინომ კურსი გასცა', 'Treasury quoted',
      v_client || ': ' || v_rate,
      v_client || ': ' || v_rate
    );
  end if;

  if old.quote_status is distinct from 'declined' and new.quote_status = 'declined' then
    perform private.inbox_add(
      'kam', new.kam_id, 'treasury.declined', new.id,
      'სახაზინომ უარი თქვა', 'Treasury declined',
      v_client || ': ' || coalesce(new.decline_reason, ''),
      v_client || ': ' || coalesce(new.decline_reason, '')
    );
  end if;

  if old.client_reply is distinct from 'approved' and new.client_reply = 'approved' then
    perform private.inbox_add(
      'treasury', null, 'client.approved', new.id,
      'კლიენტმა დაამტკიცა', 'Client approved',
      v_kam || ': ' || v_client || ' ' || coalesce(to_char(new.approved_rate, 'FM9990.0000'), ''),
      v_kam || ': ' || v_client || ' ' || coalesce(to_char(new.approved_rate, 'FM9990.0000'), '')
    );
    perform private.inbox_add(
      'manager', null, 'client.approved', new.id,
      'კლიენტმა დაამტკიცა', 'Client approved',
      v_kam || ': ' || v_client || ' ' || coalesce(to_char(new.approved_rate, 'FM9990.0000'), ''),
      v_kam || ': ' || v_client || ' ' || coalesce(to_char(new.approved_rate, 'FM9990.0000'), '')
    );
  end if;

  if new.client_reply = 'better'
     and new.better_decision is null
     and (old.client_reply is distinct from 'better' or old.better_decision is not null) then
    perform private.inbox_add(
      'treasury', null, 'client.better', new.id,
      'კლიენტს უკეთესი კურსი სურს', 'Client wants a better rate',
      v_kam || ': ' || v_client || ' ' || coalesce(to_char(new.wanted_rate, 'FM9990.0000'), ''),
      v_kam || ': ' || v_client || ' ' || coalesce(to_char(new.wanted_rate, 'FM9990.0000'), '')
    );
  end if;

  if old.client_reply is distinct from 'declined' and new.client_reply = 'declined' then
    perform private.inbox_add(
      'treasury', null, 'client.declined', new.id,
      'კლიენტმა უარი თქვა', 'Client declined',
      v_client || ': ' || coalesce(new.client_decline_reason, ''),
      v_client || ': ' || coalesce(new.client_decline_reason, '')
    );
  end if;

  if tg_op = 'UPDATE'
     and old.rate_written_at is null
     and new.rate_written_at is not null then
    perform private.inbox_add(
      'kam', new.kam_id, 'rate.written', new.id,
      'კურსი გაწერილია', 'Rate is written',
      v_client || ': ' || coalesce(to_char(new.approved_rate, 'FM9990.0000'), v_rate),
      v_client || ': ' || coalesce(to_char(new.approved_rate, 'FM9990.0000'), v_rate)
    );
  end if;

  if old.client_reply = 'better'
     and old.better_decision is null
     and new.client_reply is null
     and new.quote_status = 'quoted' then
    if old.wanted_rate is not null and new.rate is not distinct from old.wanted_rate then
      perform private.inbox_add(
        'kam', new.kam_id, 'rate.quoted', new.id,
        'სახაზინომ კურსი გასცა', 'Treasury quoted',
        v_client || ': ' || v_rate,
        v_client || ': ' || v_rate
      );
    else
      perform private.inbox_add(
        'kam', new.kam_id, 'treasury.corrected', new.id,
        'სახაზინომ კურსი გაასწორა', 'Treasury corrected the rate',
        v_client || ': ' || v_rate,
        v_client || ': ' || v_rate
      );
    end if;
  end if;

  return null;
exception when others then
  raise warning 'inbox skipped: %', sqlerrm;
  return null;
end;
$$;

revoke all on function private.inbox_on_request() from public, anon, authenticated;

-- Treasury presses this after typing the agreed rate into the core system.
-- The update notifies the KAM through the inbox trigger above.
create or replace function public.treasury_mark_rate_written(p_request_id bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.my_profile_id();
  v_req public.requests%rowtype;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'მხოლოდ სახაზინოს შეუძლია ამის მონიშვნა' using errcode = '42501';
  end if;

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  if v_req.client_reply is distinct from 'approved' or v_req.approved_rate is null then
    raise exception 'კლიენტს ჯერ არ დაუმტკიცებია კურსი' using errcode = '22023';
  end if;
  if v_req.rate_written_at is not null then
    return;
  end if;

  update public.requests r
     set rate_written_at = now(),
         rate_written_by = v_me
   where r.id = p_request_id;
end;
$$;

revoke all on function public.treasury_mark_rate_written(bigint) from public, anon;
grant execute on function public.treasury_mark_rate_written(bigint) to authenticated;

drop trigger if exists inbox_request_insert on public.requests;
drop trigger if exists inbox_request_update on public.requests;

create trigger inbox_request_insert
  after insert on public.requests
  for each row execute function private.inbox_on_request();

create trigger inbox_request_update
  after update on public.requests
  for each row execute function private.inbox_on_request();

do $$
begin
  alter publication supabase_realtime add table public.user_notifications;
exception when others then
  raise notice 'Realtime publication not changed: %', sqlerrm;
end;
$$;
