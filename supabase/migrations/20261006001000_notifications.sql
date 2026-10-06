-- =====================================================================
-- KAM platform, migration 10: messages to Make.com, by role
--
-- Every event is written to public.notification_events (the outbox) and
-- posted to the Make.com webhook of the role it is for. Make then sends
-- it on (email, SMS or WhatsApp through Twilio). Who gets what is set in
-- public.notification_rules and can be switched on and off by admins.
--
--   treasury  request.new, request.asked_again, request.waiting_long
--   kam       rate.ready, request.sent_back, rate.expiring,
--             request.went_through, followups.daily
--   admin     sync.failed  (+ request.waiting_long, off by default)
--
-- Webhook addresses live in Vault, one per role:
--   make_webhook_treasury, make_webhook_kam, make_webhook_admin,
--   make_webhook_manager, plus make_webhook_token (sent as X-Kursi-Token)
-- A role without an address is simply skipped (status no_webhook).
-- A failing message never blocks the work that caused it.
-- =====================================================================

-- pg_net sends HTTP requests from the database, after the transaction commits
do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net is not available here: %', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------
-- 1. Where people receive messages
-- ---------------------------------------------------------------------
alter table public.profiles
  add column phone text check (phone ~ '^\+[0-9]{8,15}$'),
  add column notify_channels text[] not null default '{email}'
    check (notify_channels <@ array['email', 'sms', 'whatsapp']::text[]);
comment on column public.profiles.notify_channels is 'Where this person wants messages: email, sms, whatsapp. Make reads this from each recipient.';

-- ---------------------------------------------------------------------
-- 2. Settings
-- ---------------------------------------------------------------------
alter table public.rules
  add column app_url text check (app_url ~ '^https://'),
  add column treasury_alert_seconds int not null default 180 check (treasury_alert_seconds between 30 and 3600),
  add column expiry_warning_minutes int not null default 2 check (expiry_warning_minutes between 1 and 30);
grant update (app_url, treasury_alert_seconds, expiry_warning_minutes) on public.rules to authenticated;

create table public.notification_rules (
  event_type   text not null,
  audience     text not null check (audience in ('kam', 'treasury', 'admin', 'manager')),
  enabled      boolean not null default true,
  description  text not null,
  primary key (event_type, audience)
);
insert into public.notification_rules (event_type, audience, enabled, description) values
  ('request.new',          'treasury', true,  'A KAM asks for a rate'),
  ('request.asked_again',  'treasury', true,  'A KAM asks again after an expired rate or a send-back'),
  ('request.waiting_long', 'treasury', true,  'A request has waited longer than the alert time'),
  ('request.waiting_long', 'admin',    false, 'Same alert, copied to admins'),
  ('rate.ready',           'kam',      true,  'Treasury sent a rate'),
  ('request.sent_back',    'kam',      true,  'Treasury sent the request back, with the reason'),
  ('rate.expiring',        'kam',      true,  'A rate is about to expire and the client''s transaction hasn''t arrived'),
  ('request.went_through', 'kam',      true,  'The client''s transaction arrived'),
  ('request.went_through', 'treasury', false, 'Same news, copied to treasury'),
  ('followups.daily',      'kam',      true,  'Morning summary: reasons to give and priority A clients to call'),
  ('sync.failed',          'admin',    true,  'Transactions could not be updated from ClickHouse');
create trigger audit_notification_rules after update on public.notification_rules for each row execute function private.audit_row();

-- ---------------------------------------------------------------------
-- 3. Outbox and delivery log
-- ---------------------------------------------------------------------
create table public.notification_events (
  id              bigint generated always as identity primary key,
  event_type      text not null,
  audience        text not null,
  request_id      bigint references public.requests (id) on delete set null,
  payload         jsonb not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'sent', 'delivered', 'failed', 'no_webhook', 'no_recipients')),
  attempts        int not null default 0,
  net_request_id  bigint,
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);
create index notification_events_status_idx on public.notification_events (status, created_at);

-- marks make "once" messages go out only once
create table private.notification_marks (
  mark        text primary key,
  created_at  timestamptz not null default now()
);

alter table public.notification_rules  enable row level security;
alter table public.notification_events enable row level security;
revoke all on public.notification_rules, public.notification_events from anon, authenticated;
grant select on public.notification_rules, public.notification_events to authenticated;
grant update (enabled) on public.notification_rules to authenticated;
create policy notification_rules_admin_read on public.notification_rules for select to authenticated
  using ((select private.is_admin()));
create policy notification_rules_admin_update on public.notification_rules for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy notification_events_admin_read on public.notification_events for select to authenticated
  using ((select private.is_admin()));

-- ---------------------------------------------------------------------
-- 4. Building messages
-- ---------------------------------------------------------------------
create or replace function private.fmt_amount(p numeric) returns text
language sql immutable set search_path = ''
as $$ select to_char(round(p), 'FM999,999,999,990') $$;

create or replace function private.fmt_rate(p numeric) returns text
language sql immutable set search_path = ''
as $$ select to_char(p, 'FM9990.0000') $$;

create or replace function private.fmt_time(p timestamptz) returns text
language sql stable set search_path = ''
as $$ select to_char(p at time zone 'Asia/Tbilisi', 'HH24:MI') $$;

-- who receives a message for an audience: the KAM of the request, or everyone active in the role
create or replace function private.recipients(p_audience text, p_kam uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'profile_id', p.id,
           'name',       p.full_name,
           'email',      p.email,
           'phone',      p.phone,
           'channels',   to_jsonb(p.notify_channels)
         ) order by p.full_name), '[]'::jsonb)
  from public.profiles p
  where p.active
    and p.auth_user_id is not null
    and ((p_audience = 'kam' and p.id = p_kam) or (p_audience <> 'kam' and p.role = p_audience))
$$;

-- one outbox row per enabled audience of the event
create or replace function private.emit(
  p_event       text,
  p_request_id  bigint,
  p_kam         uuid,
  p_message_en  text,
  p_message_ka  text,
  p_data        jsonb
)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_aud    text;
  v_recips jsonb;
  v_url    text := (select r.app_url from public.rules r);
  v_n      int := 0;
begin
  for v_aud in
    select nr.audience from public.notification_rules nr where nr.event_type = p_event and nr.enabled
  loop
    v_recips := private.recipients(v_aud, p_kam);
    insert into public.notification_events (event_type, audience, request_id, payload, status)
    values (
      p_event, v_aud, p_request_id,
      jsonb_build_object(
        'event',       p_event,
        'audience',    v_aud,
        'occurred_at', now(),
        'recipients',  v_recips,
        'message',     jsonb_build_object('en', p_message_en, 'ka', p_message_ka),
        'data',        coalesce(p_data, '{}'::jsonb),
        'link',        case when v_url is not null and p_request_id is not null
                            then v_url || '/requests/' || p_request_id else v_url end
      ),
      case when jsonb_array_length(v_recips) = 0 then 'no_recipients' else 'pending' end
    );
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function private.emit_once(
  p_mark text, p_event text, p_request_id bigint, p_kam uuid, p_en text, p_ka text, p_data jsonb
)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
begin
  insert into private.notification_marks (mark) values (p_mark) on conflict (mark) do nothing;
  if not found then
    return 0;
  end if;
  return private.emit(p_event, p_request_id, p_kam, p_en, p_ka, p_data);
end;
$$;

-- request details used by several messages
create or replace function private.request_facts(p_request_id bigint)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'request_id',     r.id,
    'kam_id',         r.kam_id,
    'kam_name',       p.full_name,
    'client_id',      r.client_id,
    'client_name',    coalesce(c.name, r.client_id),
    'sells_currency', r.sells_currency,
    'gets_currency',  r.gets_currency,
    'amount',         r.amount,
    'amount_text',    private.fmt_amount(r.amount),
    'note',           r.note,
    'rate',           r.rate,
    'rate_text',      private.fmt_rate(r.rate),
    'valid_until',    r.rate_valid_until,
    'valid_until_text', private.fmt_time(r.rate_valid_until),
    'decline_reason', r.decline_reason,
    'asked_at',       r.asked_at
  )
  from public.requests r
  join public.profiles p on p.id = r.kam_id
  left join public.clients c on c.client_id = r.client_id
  where r.id = p_request_id
$$;

-- ---------------------------------------------------------------------
-- 5. Sending to Make.com
-- ---------------------------------------------------------------------
create or replace function private.dispatch(p_event_id bigint)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  e        public.notification_events%rowtype;
  v_url    text;
  v_token  text;
  v_req    bigint;
begin
  select * into e from public.notification_events n where n.id = p_event_id for update;
  if not found or e.status not in ('pending', 'failed') then
    return;
  end if;
  select ds.decrypted_secret into v_url   from vault.decrypted_secrets ds where ds.name = 'make_webhook_' || e.audience;
  select ds.decrypted_secret into v_token from vault.decrypted_secrets ds where ds.name = 'make_webhook_token';
  if v_url is null then
    update public.notification_events n set status = 'no_webhook' where n.id = p_event_id;
    return;
  end if;
  begin
    v_req := net.http_post(
      url     := v_url,
      body    := e.payload || jsonb_build_object('event_id', e.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'X-Kursi-Token', coalesce(v_token, '')),
      timeout_milliseconds := 5000
    );
    update public.notification_events n
       set status = 'sent', attempts = n.attempts + 1, net_request_id = v_req, last_error = null
     where n.id = p_event_id;
  exception when others then
    update public.notification_events n
       set status = 'failed', attempts = n.attempts + 1, last_error = sqlerrm
     where n.id = p_event_id;
  end;
end;
$$;

create or replace function private.dispatch_new_event()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.dispatch(new.id);
  return null;
end;
$$;
create trigger dispatch_notification after insert on public.notification_events
  for each row when (new.status = 'pending') execute function private.dispatch_new_event();

-- every minute: record Make's answers, retry failures (3 attempts in total)
create or replace function private.reconcile_notifications()
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  e  record;
  r  record;
begin
  for e in
    select n.id, n.net_request_id, n.created_at
    from public.notification_events n
    where n.status = 'sent' and n.created_at > now() - interval '1 day'
  loop
    select * into r from net._http_response h where h.id = e.net_request_id;
    if found then
      if r.status_code between 200 and 299 then
        update public.notification_events n set status = 'delivered', delivered_at = now() where n.id = e.id;
      else
        update public.notification_events n
           set status = 'failed',
               last_error = coalesce(nullif(r.error_msg, ''), 'Make answered with HTTP ' || coalesce(r.status_code::text, 'nothing'))
         where n.id = e.id;
      end if;
    elsif e.created_at < now() - interval '5 minutes' then
      update public.notification_events n set status = 'failed', last_error = 'No answer from Make' where n.id = e.id;
    end if;
  end loop;

  for e in
    select n.id from public.notification_events n
    where n.status = 'failed' and n.attempts < 3 and n.created_at > now() - interval '1 hour'
  loop
    perform private.dispatch(e.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. What triggers a message
-- ---------------------------------------------------------------------

-- requests: new, rate ready, sent back, asked again
create or replace function private.notify_request_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  f jsonb;
begin
  begin
    if new.source <> 'app' then
      return null;
    end if;
    f := private.request_facts(new.id);

    if tg_op = 'INSERT' then
      perform private.emit('request.new', new.id, new.kam_id,
        format('New rate request from %s: %s sells %s %s for %s.%s',
               f->>'kam_name', f->>'client_name', f->>'sells_currency', f->>'amount_text', f->>'gets_currency',
               coalesce(' Note: ' || (f->>'note'), '')),
        format('ახალი მოთხოვნა კურსზე, %s: %s ყიდის %s %s-ს, სანაცვლოდ იღებს %s-ს.%s',
               f->>'kam_name', f->>'client_name', f->>'amount_text', f->>'sells_currency', f->>'gets_currency',
               coalesce(' შენიშვნა: ' || (f->>'note'), '')),
        f);

    elsif old.quote_status = 'asking' and new.quote_status = 'quoted' then
      perform private.emit('rate.ready', new.id, new.kam_id,
        format('Rate for %s: %s. Sells %s %s for %s. Valid until %s.',
               f->>'client_name', f->>'rate_text', f->>'sells_currency', f->>'amount_text', f->>'gets_currency', f->>'valid_until_text'),
        format('%s-ის კურსი: %s. ყიდის %s %s-ს, იღებს %s-ს. მოქმედებს %s-მდე.',
               f->>'client_name', f->>'rate_text', f->>'amount_text', f->>'sells_currency', f->>'gets_currency', f->>'valid_until_text'),
        f);

    elsif old.quote_status = 'asking' and new.quote_status = 'declined' then
      perform private.emit('request.sent_back', new.id, new.kam_id,
        format('Treasury sent back %s (sells %s %s for %s): %s',
               f->>'client_name', f->>'sells_currency', f->>'amount_text', f->>'gets_currency', f->>'decline_reason'),
        format('სახაზინო სამსახურმა დააბრუნა მოთხოვნა: %s (ყიდის %s %s-ს, იღებს %s-ს). მიზეზი: %s',
               f->>'client_name', f->>'amount_text', f->>'sells_currency', f->>'gets_currency', f->>'decline_reason'),
        f);

    elsif old.quote_status in ('quoted', 'declined') and new.quote_status = 'asking' then
      perform private.emit('request.asked_again', new.id, new.kam_id,
        format('%s asks again: %s sells %s %s for %s.%s',
               f->>'kam_name', f->>'client_name', f->>'sells_currency', f->>'amount_text', f->>'gets_currency',
               coalesce(' Note: ' || (f->>'note'), '')),
        format('ხელახალი მოთხოვნა, %s: %s ყიდის %s %s-ს, სანაცვლოდ იღებს %s-ს.%s',
               f->>'kam_name', f->>'client_name', f->>'amount_text', f->>'sells_currency', f->>'gets_currency',
               coalesce(' შენიშვნა: ' || (f->>'note'), '')),
        f);
    end if;
  exception when others then
    raise warning 'notification skipped: %', sqlerrm;
  end;
  return null;
end;
$$;
create trigger notify_request_insert after insert on public.requests
  for each row execute function private.notify_request_change();
create trigger notify_request_status after update of quote_status on public.requests
  for each row when (old.quote_status is distinct from new.quote_status)
  execute function private.notify_request_change();

-- transactions: the client's transaction arrived for a quoted request
create or replace function private.notify_transaction()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  r  record;
  f  jsonb;
begin
  begin
    if new.payment_status <> 'SUCCESS' then
      return null;
    end if;
    for r in
      select q.id, q.kam_id from public.requests q
      where q.client_id = new.client_id and q.request_date = new.tx_date
        and q.quote_status = 'quoted' and q.source = 'app'
    loop
      f := private.request_facts(r.id);
      perform private.emit_once('went:' || r.id, 'request.went_through', r.id, r.kam_id,
        format('%s''s transaction arrived: the request at %s went through.', f->>'client_name', f->>'rate_text'),
        format('%s-ის ტრანზაქცია შემოვიდა: მოთხოვნა %s კურსით შესრულდა.', f->>'client_name', f->>'rate_text'),
        f || jsonb_build_object('tx_id', new.tx_id));
    end loop;
  exception when others then
    raise warning 'notification skipped: %', sqlerrm;
  end;
  return null;
end;
$$;
create trigger notify_transaction after insert or update of payment_status on public.transactions
  for each row execute function private.notify_transaction();

-- sync runs: tell admins when an hourly or nightly sync fails
create or replace function private.notify_sync_failed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_fresh text := coalesce(private.fmt_time(public.data_freshness()), 'never');
begin
  begin
    perform private.emit('sync.failed', null, null,
      format('Transaction sync failed at %s: %s. The platform shows data from %s.',
             private.fmt_time(new.started_at), coalesce(new.error, 'unknown error'), v_fresh),
      format('ტრანზაქციების განახლება ვერ მოხერხდა %s-ზე: %s. პლატფორმაზე ჩანს %s-ის მონაცემები.',
             private.fmt_time(new.started_at), coalesce(new.error, 'უცნობი შეცდომა'), v_fresh),
      jsonb_build_object('run_id', new.id, 'kind', new.kind, 'error', new.error, 'data_from', public.data_freshness()));
  exception when others then
    raise warning 'notification skipped: %', sqlerrm;
  end;
  return null;
end;
$$;
create trigger notify_sync_failed after update of ok on private.sync_runs
  for each row when (new.ok = false and old.ok is distinct from false and new.kind in ('hourly', 'nightly'))
  execute function private.notify_sync_failed();

-- every minute: requests waiting too long, rates about to expire
create or replace function private.notify_timers()
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_rules public.rules%rowtype;
  r       record;
  f       jsonb;
  v_min   int;
begin
  select * into v_rules from public.rules limit 1;

  for r in
    select q.id, q.kam_id, q.asked_at from public.requests q
    where q.quote_status = 'asking' and q.source = 'app'
      and q.asked_at < now() - make_interval(secs => v_rules.treasury_alert_seconds)
  loop
    f := private.request_facts(r.id);
    v_min := greatest(1, floor(extract(epoch from now() - r.asked_at) / 60))::int;
    perform private.emit_once('wait:' || r.id || ':' || extract(epoch from r.asked_at)::bigint,
      'request.waiting_long', r.id, r.kam_id,
      format('%s has waited %s min for a rate (%s, sells %s %s for %s).',
             f->>'client_name', v_min, f->>'kam_name', f->>'sells_currency', f->>'amount_text', f->>'gets_currency'),
      format('%s კურსს %s წუთია ელოდება (%s, ყიდის %s %s-ს, იღებს %s-ს).',
             f->>'client_name', v_min, f->>'kam_name', f->>'amount_text', f->>'sells_currency', f->>'gets_currency'),
      f || jsonb_build_object('waiting_minutes', v_min));
  end loop;

  for r in
    select q.id, q.kam_id, q.rate_valid_until from public.requests q
    where q.quote_status = 'quoted' and q.source = 'app'
      and q.rate_valid_until > now()
      and q.rate_valid_until <= now() + make_interval(mins => v_rules.expiry_warning_minutes)
      and not exists (
        select 1 from public.transactions t
        where t.client_id = q.client_id and t.tx_date = q.request_date and t.payment_status = 'SUCCESS'
      )
  loop
    f := private.request_facts(r.id);
    perform private.emit_once('exp:' || r.id || ':' || extract(epoch from r.rate_valid_until)::bigint,
      'rate.expiring', r.id, r.kam_id,
      format('Rate %s for %s expires at %s. The client''s transaction hasn''t arrived yet.',
             f->>'rate_text', f->>'client_name', f->>'valid_until_text'),
      format('%s-ის კურსი %s იწურება %s-ზე. კლიენტის ტრანზაქცია ჯერ არ შემოსულა.',
             f->>'client_name', f->>'rate_text', f->>'valid_until_text'),
      f);
  end loop;
end;
$$;

-- win-back list for any KAM (used by the morning summary; the app keeps using winback_list)
create or replace function private.winback_for(p_kam uuid, p_all boolean)
returns table (
  client_id           text,
  client_name         text,
  client_kind         text,
  owner_id            uuid,
  owner_name          text,
  tier                text,
  last_request        date,
  last_deal           date,
  prior_turnover_gel  numeric,
  max_request_gel     numeric,
  last_reason         text,
  step                text,
  step_at             timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me    uuid := p_kam;
  v_all   boolean := p_all;
  v_today date := private.tbilisi_today();
  v_fresh date;
  v_rules public.rules%rowtype;
begin
  v_fresh := coalesce(private.freshness_date(), v_today);
  select * into v_rules from public.rules limit 1;

  return query
  with o as (
    select * from private.owners(v_today - v_rules.winback_window_days, v_today)
  ),
  last_req as (
    select r.client_id, max(r.request_date) as last_request
    from public.requests r
    where r.client_id in (select o.client_id from o)
    group by r.client_id
  ),
  last_ok as (
    select t.client_id, max(t.tx_date) as last_deal
    from public.transactions t
    where t.payment_status = 'SUCCESS' and t.client_id in (select o.client_id from o)
    group by t.client_id
  ),
  cand as (
    select o.client_id, o.owner_id, lr.last_request, lk.last_deal
    from o
    join last_req lr on lr.client_id = o.client_id
    left join last_ok lk on lk.client_id = o.client_id
    where lr.last_request < v_fresh                       -- a request from today may still go through
      and (lk.last_deal is null or lk.last_deal < lr.last_request)
  ),
  sizes as (
    select cd.client_id,
           (select coalesce(sum(t.abs_gel + t.cross_gel), 0)
              from public.transactions t
             where t.client_id = cd.client_id
               and t.payment_status = 'SUCCESS'
               and t.tx_date >= cd.last_request - 180
               and t.tx_date <  cd.last_request) as prior_turnover_gel,
           (select round(max(case when r.sells_currency = 'GEL' then r.amount
                                  when r.gets_currency  = 'GEL' then r.amount * r.rate end), 2)
              from public.requests r
             where r.client_id = cd.client_id
               and r.request_date >= v_today - v_rules.winback_window_days) as max_request_gel
    from cand cd
  ),
  latest_reason as (
    select distinct on (r.client_id) r.client_id, r.loss_reason
    from public.requests r
    where r.client_id in (select cd.client_id from cand cd)
    order by r.client_id, r.requested_at desc
  ),
  latest_step as (
    select distinct on (w.client_id) w.client_id, w.step, w.created_at
    from public.winback_actions w
    where w.client_id in (select cd.client_id from cand cd)
    order by w.client_id, w.created_at desc
  ),
  scored as (
    select cd.*, s.prior_turnover_gel, s.max_request_gel,
           greatest(s.prior_turnover_gel, coalesce(s.max_request_gel, 0)) as size_gel
    from cand cd
    join sizes s on s.client_id = cd.client_id
  )
  select sc.client_id,
         cl.name,
         cl.kind,
         sc.owner_id,
         p.full_name,
         case when sc.size_gel >= v_rules.tier_a_min_gel then 'A'
              when sc.size_gel >= v_rules.tier_b_min_gel then 'B'
              else 'C' end,
         sc.last_request,
         sc.last_deal,
         sc.prior_turnover_gel,
         sc.max_request_gel,
         lr.loss_reason,
         coalesce(ls.step, 'not_contacted'),
         ls.created_at
  from scored sc
  join public.clients cl  on cl.client_id = sc.client_id
  join public.profiles p  on p.id = sc.owner_id
  left join latest_reason lr on lr.client_id = sc.client_id
  left join latest_step  ls on ls.client_id = sc.client_id
  where v_all or sc.owner_id = v_me
  order by 6, sc.size_gel desc;
end;
$$;

create or replace function public.winback_list()
returns table (
  client_id           text,
  client_name         text,
  client_kind         text,
  owner_id            uuid,
  owner_name          text,
  tier                text,
  last_request        date,
  last_deal           date,
  prior_turnover_gel  numeric,
  max_request_gel     numeric,
  last_reason         text,
  step                text,
  step_at             timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_me uuid := private.my_profile_id();
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  return query select * from private.winback_for(v_me, private.can_see_all());
end;
$$;

-- every morning: what each KAM should follow up on
create or replace function private.notify_daily_followups()
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  k          record;
  v_reasons  int;
  v_calls    int;
  v_today    date := private.tbilisi_today();
  v_sent     int := 0;
begin
  for k in
    select p.id, p.full_name from public.profiles p
    where p.active and p.role = 'kam' and p.auth_user_id is not null
  loop
    select count(*) into v_reasons
    from public.request_outcomes o
    where o.kam_id = k.id and o.outcome = 'did_not_go_through' and o.loss_reason is null
      and o.request_date >= v_today - 7;
    select count(*) into v_calls
    from private.winback_for(k.id, false) w
    where w.tier = 'A' and w.step = 'not_contacted';
    if v_reasons + v_calls = 0 then
      continue;
    end if;
    v_sent := v_sent + private.emit_once('digest:' || k.id || ':' || v_today, 'followups.daily', null, k.id,
      concat('Good morning, ', split_part(k.full_name, ' ', 1), '.',
             case when v_reasons > 0 then format(' Requests that need a reason: %s.', v_reasons) end,
             case when v_calls > 0 then format(' Priority A clients to call: %s.', v_calls) end),
      concat('დილა მშვიდობისა, ', split_part(k.full_name, ' ', 1), '!',
             case when v_reasons > 0 then format(' მიზეზი სჭირდება %s მოთხოვნას.', v_reasons) end,
             case when v_calls > 0 then format(' დასარეკია A პრიორიტეტის %s კლიენტი.', v_calls) end),
      jsonb_build_object('requests_needing_reason', v_reasons, 'priority_a_to_call', v_calls));
  end loop;
  return v_sent;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Admin: send a sample message, to set up and test a Make scenario
-- ---------------------------------------------------------------------
create or replace function public.send_test_notification(p_event text)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me   uuid := private.my_profile_id();
  v_data jsonb := jsonb_build_object(
    'test', true, 'request_id', 0, 'kam_name', 'Test KAM', 'client_id', '400000000', 'client_name', 'Test client',
    'sells_currency', 'USD', 'gets_currency', 'GEL', 'amount', 100000, 'amount_text', '100,000',
    'rate', 2.6900, 'rate_text', '2.6900', 'valid_until_text', '12:00', 'decline_reason', 'Amount too large');
begin
  if not private.is_admin() then
    raise exception 'Only admins can send test messages' using errcode = '42501';
  end if;
  if not exists (select 1 from public.notification_rules nr where nr.event_type = p_event) then
    raise exception 'Unknown message type %', p_event using errcode = '22023';
  end if;
  return private.emit(p_event, null, v_me,
    '[Test] ' || p_event || ': this is how this message arrives. Test client sells USD 100,000 for GEL, rate 2.6900.',
    '[ტესტი] ' || p_event || ': ასე მოვა ეს გზავნილი. Test client ყიდის 100,000 USD-ს, კურსი 2.6900.',
    v_data);
end;
$$;

revoke execute on function public.send_test_notification(text), public.winback_list() from public, anon;
grant execute on function public.send_test_notification(text), public.winback_list() to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.my_profile_id(), private.my_role(), private.can_see_all(), private.is_admin(),
  private.can_write(), private.is_my_client(text), private.freshness_date(), private.tbilisi_today(),
  private.is_treasury()
to authenticated;
