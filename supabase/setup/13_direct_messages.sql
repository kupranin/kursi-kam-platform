-- SMS goes to GoSMS (https://gosms.ge). WhatsApp goes to Meta.
-- Make.com and Twilio are not used. Email is not sent on this path.
--
-- Paste this whole file in the Supabase SQL editor. It is safe to run again.
-- Then store the values below. Use the real ones from each account.
--
-- GoSMS: the API key from app.gosms.ge, and the sender name they approved.
--   select vault.create_secret('your-sms-key', 'sms_api_key', 'GoSMS API key');
--   select vault.create_secret('Kursi', 'sms_sender', 'GoSMS sender name');
--
-- Meta WhatsApp Cloud API: a permanent token, and the phone number id
-- from the WhatsApp product in Meta Business settings (not the phone number itself).
--   select vault.create_secret('EAAxxxxxxxx', 'meta_whatsapp_token', 'Meta WhatsApp token');
--   select vault.create_secret('1234567890', 'meta_phone_number_id', 'Meta phone number id');
--
-- A first WhatsApp message has to use a template Meta has approved. Create one
-- template in Georgian with a single body variable, then store its name.
-- Inside 24 hours of a reply, ordinary text is used when this is left empty.
--   select vault.create_secret('kursi_notice', 'meta_template_name', 'Approved WhatsApp template');
--   select vault.create_secret('ka', 'meta_template_lang', 'Template language code');
--
-- People still choose SMS and WhatsApp on Admin → People. The text is Georgian.

create table if not exists public.notification_deliveries (
  id              bigint generated always as identity primary key,
  event_id        bigint not null references public.notification_events (id) on delete cascade,
  phone           text not null,
  channel         text not null check (channel in ('sms', 'whatsapp')),
  status          text not null default 'pending'
                  check (status in ('pending', 'sent', 'delivered', 'failed')),
  net_request_id  bigint,
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  unique (event_id, phone, channel)
);

alter table public.notification_deliveries enable row level security;
revoke all on public.notification_deliveries from anon, authenticated;
grant select on public.notification_deliveries to authenticated;
drop policy if exists notification_deliveries_admin_read on public.notification_deliveries;
create policy notification_deliveries_admin_read on public.notification_deliveries
  for select to authenticated
  using ((select private.is_admin()));

drop function if exists private.twilio_send(text, text, text);
drop function if exists private.twilio_ready();
drop function if exists private.twilio_secret(text);

create or replace function private.message_secret(p_name text)
returns text
language sql stable security definer set search_path = ''
as $$
  select ds.decrypted_secret from vault.decrypted_secrets ds where ds.name = p_name limit 1
$$;

create or replace function private.sms_ready()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.message_secret('sms_api_key') is not null
$$;

create or replace function private.whatsapp_ready()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.message_secret('meta_whatsapp_token') is not null
     and private.message_secret('meta_phone_number_id') is not null
$$;

create or replace function private.channels_ready()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.sms_ready() or private.whatsapp_ready()
$$;

-- Percent-encode one application/x-www-form-urlencoded field (UTF-8).
create or replace function private.form_encode(p_value text)
returns text
language plpgsql immutable set search_path = ''
as $$
declare
  v_bytes bytea := convert_to(coalesce(p_value, ''), 'UTF8');
  v_out text := '';
  i int;
  b int;
begin
  for i in 0 .. octet_length(v_bytes) - 1 loop
    b := get_byte(v_bytes, i);
    if b between 48 and 57
       or b between 65 and 90
       or b between 97 and 122
       or b in (45, 46, 95, 126) then
      v_out := v_out || chr(b);
    else
      v_out := v_out || '%' || upper(lpad(to_hex(b), 2, '0'));
    end if;
  end loop;
  return v_out;
end;
$$;

-- A GoSMS error body becomes one sentence. Null when this is not a GoSMS error.
create or replace function private.explain_sender_error(p_content text)
returns text
language plpgsql immutable set search_path = ''
as $$
declare
  v_code int;
  v_msg text;
  v_plain text;
begin
  if p_content is null or p_content !~ '"errorCode"' then
    return null;
  end if;
  v_code := substring(p_content from '"errorCode"\s*:\s*"?([0-9]+)')::int;
  if v_code is null then
    return null;
  end if;
  v_msg := substring(p_content from '"message"\s*:\s*"([^"]*)"');
  v_plain := case v_code
    when 100 then 'GoSMS rejected the key (error 100).'
    when 101 then 'GoSMS has not approved this sender name (error 101).'
    when 102 then 'GoSMS has no balance left (error 102).'
    when 103 then 'GoSMS rejected the fields, or the text is too long (error 103).'
    when 105 then 'GoSMS rejected the phone number (error 105).'
    else 'GoSMS error ' || v_code::text || '.'
  end;
  if v_msg is not null and v_msg <> '' then
    return v_plain || ' ' || v_msg;
  end if;
  return v_plain;
end;
$$;

-- GoSMS. The number is 995... without the plus. Georgian text is limited to 402 characters.
-- The sender name defaults to kursi.ge when Vault has no sms_sender yet.
-- net.http_post only accepts a JSON body and refuses any other content type, so the
-- form is written onto pg_net's queue instead. The body is api_key, from, to, text.
create or replace function private.sms_send(p_phone text, p_body text)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id bigint;
  v_form text;
begin
  v_form :=
       'api_key=' || private.form_encode(private.message_secret('sms_api_key'))
    || '&from='   || private.form_encode(coalesce(private.message_secret('sms_sender'), 'kursi.ge'))
    || '&to='     || private.form_encode(ltrim(p_phone, '+'))
    || '&text='   || private.form_encode(left(coalesce(p_body, ''), 402));

  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values (
    'POST',
    'https://api.gosms.ge/api/sendsms',
    jsonb_build_object('Content-Type', 'application/x-www-form-urlencoded'),
    convert_to(v_form, 'UTF8'),
    5000
  )
  returning id into v_id;

  begin
    if to_regprocedure('net.wake()') is not null then
      perform net.wake();
    end if;
  exception when others then
    null;
  end;

  return v_id;
end;
$$;

-- Meta WhatsApp Cloud API. A stored template name sends that template
-- with the message as the single body variable. Otherwise it sends text.
create or replace function private.whatsapp_send(p_phone text, p_body text)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_token    text := private.message_secret('meta_whatsapp_token');
  v_phone_id text := private.message_secret('meta_phone_number_id');
  v_template text := private.message_secret('meta_template_name');
  v_lang     text := coalesce(private.message_secret('meta_template_lang'), 'ka');
  v_to       text := ltrim(p_phone, '+');
  v_body     jsonb;
begin
  if v_template is not null and v_template <> '' then
    v_body := jsonb_build_object(
      'messaging_product', 'whatsapp',
      'to', v_to,
      'type', 'template',
      'template', jsonb_build_object(
        'name', v_template,
        'language', jsonb_build_object('code', v_lang),
        'components', jsonb_build_array(jsonb_build_object(
          'type', 'body',
          'parameters', jsonb_build_array(jsonb_build_object('type', 'text', 'text', left(p_body, 1000)))
        ))
      )
    );
  else
    v_body := jsonb_build_object(
      'messaging_product', 'whatsapp',
      'to', v_to,
      'type', 'text',
      'text', jsonb_build_object('body', left(p_body, 1000))
    );
  end if;
  return net.http_post(
    url := 'https://graph.facebook.com/v21.0/' || v_phone_id || '/messages',
    body := v_body,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 5000
  );
end;
$$;

create or replace function private.dispatch(p_event_id bigint)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  e          public.notification_events%rowtype;
  v_recip    jsonb;
  v_phone    text;
  v_channel  text;
  v_body     text;
  v_req      bigint;
  v_existing text;
  v_sent     boolean := false;
  v_failed   boolean := false;
begin
  select * into e from public.notification_events n where n.id = p_event_id for update;
  if not found or e.status not in ('pending', 'failed') then
    return;
  end if;

  if not private.channels_ready() then
    update public.notification_events n
       set status = 'no_webhook',
           last_error = 'GoSMS or Meta is not set. Add sms_api_key and sms_sender, or meta_whatsapp_token and meta_phone_number_id, in Vault.'
     where n.id = p_event_id;
    return;
  end if;

  v_body := coalesce(e.payload #>> '{message,ka}', e.payload #>> '{message,en}', '');

  for v_recip in
    select value from jsonb_array_elements(coalesce(e.payload -> 'recipients', '[]'::jsonb))
  loop
    v_phone := v_recip ->> 'phone';
    if v_phone is null or v_phone !~ '^\+[0-9]{8,15}$' then
      continue;
    end if;
    foreach v_channel in array array['sms', 'whatsapp']
    loop
      if not coalesce(v_recip -> 'channels', '[]'::jsonb) ? v_channel then
        continue;
      end if;

      select d.status into v_existing
      from public.notification_deliveries d
      where d.event_id = p_event_id and d.phone = v_phone and d.channel = v_channel;
      if v_existing = 'delivered' then
        continue;
      end if;

      if v_channel = 'sms' and not private.sms_ready() then
        insert into public.notification_deliveries (event_id, phone, channel, status, last_error)
        values (p_event_id, v_phone, v_channel, 'failed', 'GoSMS is not set. Add sms_api_key and sms_sender in Vault.')
        on conflict (event_id, phone, channel) do update
          set status = 'failed', last_error = excluded.last_error;
        v_failed := true;
        continue;
      end if;
      if v_channel = 'whatsapp' and not private.whatsapp_ready() then
        insert into public.notification_deliveries (event_id, phone, channel, status, last_error)
        values (p_event_id, v_phone, v_channel, 'failed', 'Meta WhatsApp is not set. Add meta_whatsapp_token and meta_phone_number_id in Vault.')
        on conflict (event_id, phone, channel) do update
          set status = 'failed', last_error = excluded.last_error;
        v_failed := true;
        continue;
      end if;

      begin
        v_req := case when v_channel = 'sms' then private.sms_send(v_phone, v_body) else private.whatsapp_send(v_phone, v_body) end;
        insert into public.notification_deliveries (event_id, phone, channel, status, net_request_id, last_error)
        values (p_event_id, v_phone, v_channel, 'sent', v_req, null)
        on conflict (event_id, phone, channel) do update
          set status = 'sent', net_request_id = excluded.net_request_id, last_error = null;
        v_sent := true;
      exception when others then
        insert into public.notification_deliveries (event_id, phone, channel, status, last_error)
        values (p_event_id, v_phone, v_channel, 'failed', sqlerrm)
        on conflict (event_id, phone, channel) do update
          set status = 'failed', last_error = excluded.last_error;
        v_failed := true;
      end;
    end loop;
  end loop;

  update public.notification_events n
     set attempts = n.attempts + 1,
         status = case
           when v_sent then 'sent'
           when v_failed then 'failed'
           else 'no_recipients' end,
         last_error = case
           when v_sent then null
           when v_failed then (
             select dl.last_error from public.notification_deliveries dl
             where dl.event_id = p_event_id and dl.status = 'failed'
             order by dl.id desc limit 1
           )
           else 'Nobody on this message has SMS or WhatsApp selected, or a mobile number.' end
   where n.id = p_event_id;
end;
$$;

create or replace function private.reconcile_notifications()
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  d  record;
  e  record;
  r  record;
  v_error text;
begin
  for d in
    select dl.id, dl.event_id, dl.net_request_id, dl.created_at
    from public.notification_deliveries dl
    where dl.status = 'sent' and dl.created_at > now() - interval '1 day'
  loop
    select * into r from net._http_response h where h.id = d.net_request_id;
    if found then
      if r.status_code between 200 and 299
         and coalesce(r.content, '') !~* '"Success"\s*:\s*false' then
        update public.notification_deliveries dl
           set status = 'delivered', delivered_at = now(), last_error = null
         where dl.id = d.id;
      else
        v_error := coalesce(
          private.explain_sender_error(r.content),
          nullif(r.error_msg, ''),
          left(nullif(r.content, ''), 300),
          'The sender answered with HTTP ' || coalesce(r.status_code::text, 'nothing')
        );
        update public.notification_deliveries dl
           set status = 'failed', last_error = v_error
         where dl.id = d.id;
      end if;
    elsif d.created_at < now() - interval '5 minutes' then
      update public.notification_deliveries dl
         set status = 'failed', last_error = 'No answer from the sender'
       where dl.id = d.id;
    end if;
  end loop;

  -- Messages that were already handed to Make.com before this change.
  for e in
    select n.id, n.net_request_id, n.created_at
    from public.notification_events n
    where n.status = 'sent'
      and n.net_request_id is not null
      and n.created_at > now() - interval '1 day'
      and not exists (select 1 from public.notification_deliveries dl where dl.event_id = n.id)
  loop
    select * into r from net._http_response h where h.id = e.net_request_id;
    if found then
      if r.status_code between 200 and 299 then
        update public.notification_events n set status = 'delivered', delivered_at = now() where n.id = e.id;
      else
        update public.notification_events n
           set status = 'failed',
               last_error = coalesce(nullif(r.error_msg, ''), 'The sender answered with HTTP ' || coalesce(r.status_code::text, 'nothing'))
         where n.id = e.id;
      end if;
    elsif e.created_at < now() - interval '5 minutes' then
      update public.notification_events n set status = 'failed', last_error = 'No answer from the sender' where n.id = e.id;
    end if;
  end loop;

  update public.notification_events n
     set status = 'delivered', delivered_at = coalesce(n.delivered_at, now()), last_error = null
   where n.status = 'sent'
     and exists (select 1 from public.notification_deliveries dl where dl.event_id = n.id)
     and not exists (
       select 1 from public.notification_deliveries dl
       where dl.event_id = n.id and dl.status <> 'delivered'
     );

  update public.notification_events n
     set status = 'failed',
         last_error = (
           select dl.last_error from public.notification_deliveries dl
           where dl.event_id = n.id and dl.status = 'failed'
           order by dl.id desc limit 1
         )
   where n.status = 'sent'
     and exists (select 1 from public.notification_deliveries dl where dl.event_id = n.id and dl.status = 'failed')
     and not exists (select 1 from public.notification_deliveries dl where dl.event_id = n.id and dl.status = 'sent');

  for e in
    select n.id from public.notification_events n
    where n.status = 'failed' and n.attempts < 3 and n.created_at > now() - interval '1 hour'
  loop
    perform private.dispatch(e.id);
  end loop;
end;
$$;

create or replace function public.admin_message_status()
returns table (audience text, has_webhook boolean, last_delivered_at timestamptz, failed_last_24h bigint, waiting bigint)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_admin() then
    raise exception 'Only admins can see message status' using errcode = '42501';
  end if;
  return query
  select a.aud,
         private.channels_ready(),
         (select max(n.delivered_at) from public.notification_events n where n.audience = a.aud),
         (select count(*) from public.notification_events n where n.audience = a.aud and n.status = 'failed' and n.created_at > now() - interval '1 day'),
         (select count(*) from public.notification_events n where n.audience = a.aud and n.status in ('pending', 'sent'))
  from (values ('treasury'), ('kam'), ('admin'), ('manager')) a(aud);
end;
$$;

-- The test goes to the mobile number on the admin's own People row, by SMS.
-- It does not go to Make.
create or replace function public.send_test_notification(p_event text)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me    uuid := private.my_profile_id();
  v_name  text;
  v_email text;
  v_phone text;
  v_ka    text;
begin
  if not private.is_admin() then
    raise exception 'Only admins can send test messages' using errcode = '42501';
  end if;
  if not exists (select 1 from public.notification_rules nr where nr.event_type = p_event) then
    raise exception 'Unknown message type %', p_event using errcode = '22023';
  end if;
  if not private.sms_ready() then
    raise exception 'GoSMS key is missing. Store sms_api_key in Vault first.';
  end if;

  select p.full_name, p.email, p.phone
    into v_name, v_email, v_phone
  from public.profiles p
  where p.id = v_me;

  if v_phone is null or v_phone !~ '^\+[0-9]{8,15}$' then
    raise exception 'Add your mobile on People, starting with +995, then send the test again.';
  end if;

  v_ka := '[ტესტი პლატფორმიდან] ' || p_event || '. ეს Make-ით არ იგზავნება.';

  insert into public.notification_events (event_type, audience, payload, status)
  values (
    p_event,
    'admin',
    jsonb_build_object(
      'event', p_event,
      'audience', 'admin',
      'occurred_at', now(),
      'recipients', jsonb_build_array(jsonb_build_object(
        'profile_id', v_me,
        'name', v_name,
        'email', v_email,
        'phone', v_phone,
        'channels', jsonb_build_array('sms')
      )),
      'message', jsonb_build_object(
        'en', '[Test from the platform] ' || p_event || '. This is not sent through Make.',
        'ka', v_ka
      ),
      'data', jsonb_build_object('test', true),
      'link', null
    ),
    'pending'
  );
  return 1;
end;
$$;
