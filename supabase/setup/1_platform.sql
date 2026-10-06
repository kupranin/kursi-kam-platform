-- =====================================================================
-- Kursi.ge Business KAM platform: part 1, the platform (run once)
-- Paste into Supabase > SQL Editor and run. Enable pg_cron and pg_net first.
-- Made from supabase/migrations 100, 200, 300, 500, 700, 800, 900, 1000, 1100, 1200, 1300
-- =====================================================================


-- =====================================================================
-- KAM platform, migration 1 of 6: core tables
--
-- Everything the platform stores lives here. Transactions are a synced
-- copy of ClickHouse (migration 5 fills them); every other table is
-- owned by the platform.
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------
-- People who use the platform (and past KAMs from the imported history)
-- One row per person. auth_user_id links to the login; a row without a
-- login (e.g. a past KAM) can own history but cannot sign in.
-- ---------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique references auth.users (id) on delete set null,
  email         text not null unique check (email = lower(email)),
  full_name     text not null,
  role          text not null check (role in ('admin', 'manager', 'kam')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
comment on table public.profiles is
  'One row per person. Roles: admin = everything incl. users and rules; manager = sees everything, changes nothing; kam = own requests, clients and win-back list.';

-- ---------------------------------------------------------------------
-- Clients, keyed by their identification code, stored as text so that
-- 11-digit personal IDs keep their leading zero.
-- ---------------------------------------------------------------------
create table public.clients (
  client_id        text primary key check (client_id ~ '^([0-9]{9}|[0-9]{11})$'),
  name             text check (length(name) <= 200),
  kind             text generated always as (case when length(client_id) = 9 then 'company' else 'person' end) stored,
  assigned_kam_id  uuid references public.profiles (id),
  created_at       timestamptz not null default now(),
  created_by       uuid references public.profiles (id)
);
comment on column public.clients.assigned_kam_id is
  'Optional fixed owner. When set it overrides the "most requests in the month" ownership rule.';

-- ---------------------------------------------------------------------
-- Reasons a KAM can give when a request did not go through.
-- Editable by admins; codes never change once used.
-- ---------------------------------------------------------------------
create table public.loss_reasons (
  code        text primary key check (code ~ '^[a-z_]{2,40}$'),
  label_en    text not null,
  label_ka    text not null,
  sort_order  int  not null default 0,
  active      boolean not null default true
);

insert into public.loss_reasons (code, label_en, label_ka, sort_order) values
  ('better_rate',        'Better rate elsewhere', 'სხვაგან უკეთესი კურსი', 10),
  ('postponed',          'Postponed',             'გადადო',                20),
  ('funds_not_received', 'Funds not received',    'თანხა არ ჩაურიცხავს',   30),
  ('other',              'Other',                 'სხვა',                  90);

-- ---------------------------------------------------------------------
-- Rate requests: what KAMs log, replacing the agreement file.
-- There is deliberately NO status column. Whether a request went
-- through is decided from transactions (see public.request_outcomes).
-- ---------------------------------------------------------------------
create table public.requests (
  id                  bigint generated always as identity primary key,
  kam_id              uuid not null references public.profiles (id),
  client_id           text not null references public.clients (client_id),
  requested_at        timestamptz not null default now(),
  request_date        date not null default ((now() at time zone 'Asia/Tbilisi')::date),
  sells_currency      text check (sells_currency ~ '^[A-Z]{3}$'),
  gets_currency       text check (gets_currency ~ '^[A-Z]{3}$'),
  amount              numeric(18,2) check (amount > 0),
  rate                numeric(18,6) check (rate > 0),
  note                text check (length(note) <= 500),
  loss_reason         text references public.loss_reasons (code),
  loss_reason_at      timestamptz,
  source              text not null default 'app' check (source in ('app', 'import')),
  legacy_status       text,   -- the old self-reported status, kept for reference only
  legacy_loss_reason  text,   -- free-text reason from the old file
  created_at          timestamptz not null default now(),
  constraint requests_currencies_differ check (sells_currency <> gets_currency),
  constraint requests_app_rows_complete check (
    source = 'import'
    or (sells_currency is not null and gets_currency is not null and amount is not null and rate is not null)
  )
);
create index requests_client_date_idx on public.requests (client_id, request_date);
create index requests_kam_date_idx    on public.requests (kam_id, request_date);
create index requests_date_idx        on public.requests (request_date);

-- ---------------------------------------------------------------------
-- Transactions: synced copy of the ClickHouse view (read-only for users).
-- Only transactions of clients that exist in public.clients are kept.
-- ---------------------------------------------------------------------
create table public.transactions (
  tx_id           text primary key,
  tx_time         timestamptz not null,
  tx_date         date not null,          -- Tbilisi calendar date
  client_id       text not null,
  segment         text,
  operation_type  text,
  payment_status  text not null,          -- 'SUCCESS' counts as went through
  abs_gel         numeric(18,2) not null default 0,
  cross_gel       numeric(18,2) not null default 0,
  total_income    numeric(18,2) not null default 0,  -- already includes cross income
  spread_income   numeric(18,2),
  revaluation     numeric(18,2),
  synced_at       timestamptz not null default now()
);
create index transactions_client_date_idx on public.transactions (client_id, tx_date);
create index transactions_date_idx        on public.transactions (tx_date);

-- ---------------------------------------------------------------------
-- Win-back follow-up log. Append-only; the latest row per client is
-- its current next step.
-- ---------------------------------------------------------------------
create table public.winback_actions (
  id          bigint generated always as identity primary key,
  client_id   text not null references public.clients (client_id),
  step        text not null check (step in ('not_contacted', 'called', 'meeting_set', 'converted', 'not_interested')),
  note        text check (length(note) <= 500),
  created_at  timestamptz not null default now(),
  created_by  uuid not null references public.profiles (id)
);
create index winback_actions_client_idx on public.winback_actions (client_id, created_at desc);

-- ---------------------------------------------------------------------
-- Counting rules (exactly one row). Only admins can change them, and
-- every change is written to the audit log.
-- ---------------------------------------------------------------------
create table public.rules (
  id                      boolean primary key default true check (id),
  month_grace_days        int check (month_grace_days between 0 and 10),
  winback_window_days     int not null default 92 check (winback_window_days between 7 and 365),
  tier_a_min_gel          numeric(18,2) not null default 200000,
  tier_b_min_gel          numeric(18,2) not null default 50000,
  admin_requires_mfa      boolean not null default false,
  request_delete_minutes  int not null default 15 check (request_delete_minutes between 0 and 1440),
  updated_at              timestamptz not null default now(),
  updated_by              uuid references public.profiles (id),
  constraint rules_tiers_ordered check (tier_a_min_gel >= tier_b_min_gel)
);
comment on column public.rules.month_grace_days is
  'Requests made this many days into the next month still count toward the month''s portfolio. NULL = not decided yet (treated as 0).';
comment on column public.rules.tier_a_min_gel is
  'PLACEHOLDER value: confirm the A/B/C thresholds before go-live.';
insert into public.rules default values;

-- ---------------------------------------------------------------------
-- Audit log: who changed what, and when. Written only by triggers and
-- by the admin-users function; nobody can edit or delete it.
-- ---------------------------------------------------------------------
create table public.audit_log (
  id                bigint generated always as identity primary key,
  at                timestamptz not null default now(),
  actor_profile_id  uuid,
  action            text not null,
  table_name        text,
  row_key           text,
  old_data          jsonb,
  new_data          jsonb
);
create index audit_log_at_idx on public.audit_log (at desc);

-- ---------------------------------------------------------------------
-- Internal bookkeeping (not reachable through the API)
-- ---------------------------------------------------------------------
create table private.sync_runs (
  id             bigint generated always as identity primary key,
  kind           text not null,             -- hourly | nightly | backfill
  from_date      date,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  ok             boolean,
  rows_upserted  int,
  error          text
);

create table private.backfill_queue (
  client_id  text primary key,
  queued_at  timestamptz not null default now(),
  done_at    timestamptz,
  attempts   int not null default 0,
  last_error text
);

-- Staging table for the one-off import of the cleaned agreement file
create table private.import_requests (
  row_no              int primary key,
  request_date        text,
  client_id           text,
  client_name         text,
  kam_email           text,
  sells_currency      text,
  gets_currency       text,
  amount              text,
  rate                text,
  legacy_status       text,
  legacy_loss_reason  text,
  imported_request_id bigint,
  import_error        text
);


-- =====================================================================
-- KAM platform, migration 2 of 6: who can see and change what
--
-- Default is deny. Signed-out visitors (anon) get nothing. Signed-in
-- users get only what the row-level policies below allow, and most
-- writes go through the functions in migration 3, which check the
-- caller themselves.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper functions used by the policies
-- ---------------------------------------------------------------------
create or replace function private.my_profile_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select p.id
  from public.profiles p
  where p.auth_user_id = (select auth.uid()) and p.active
$$;

create or replace function private.my_role()
returns text
language sql stable security definer set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.auth_user_id = (select auth.uid()) and p.active
$$;

-- admin or manager: may read everything
create or replace function private.can_see_all()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(private.my_role() in ('admin', 'manager'), false)
$$;

-- admin, and (if the rule is switched on) signed in with a second factor
create or replace function private.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(private.my_role() = 'admin', false)
     and (
       not (select r.admin_requires_mfa from public.rules r)
       or coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
     )
$$;

-- may write: KAMs and admins (managers are read-only)
create or replace function private.can_write()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(private.my_role() in ('admin', 'kam'), false)
$$;

-- client is in the caller's book: they logged a request for it, or it is assigned to them
create or replace function private.is_my_client(p_client_id text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
           select 1 from public.requests r
           where r.client_id = p_client_id and r.kam_id = private.my_profile_id()
         )
      or exists (
           select 1 from public.clients c
           where c.client_id = p_client_id and c.assigned_kam_id = private.my_profile_id()
         )
$$;

-- Postgres lets everyone execute new functions unless revoked, and a
-- per-schema default cannot undo that. So every migration that adds
-- functions to private ends with an explicit lock-down like this one.
revoke execute on all functions in schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function
  private.my_profile_id(), private.my_role(), private.can_see_all(),
  private.is_admin(), private.can_write(), private.is_my_client(text)
to authenticated;

-- ---------------------------------------------------------------------
-- Table privileges (row-level policies narrow these further)
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;

grant select on
  public.profiles, public.clients, public.requests, public.transactions,
  public.winback_actions, public.loss_reasons, public.rules, public.audit_log
to authenticated;

grant update (name, assigned_kam_id) on public.clients to authenticated;    -- admins only, see policy
grant update, delete on public.requests to authenticated;                   -- admins only, see policy
grant insert, update on public.loss_reasons to authenticated;               -- admins only, see policy
grant update (month_grace_days, winback_window_days, tier_a_min_gel, tier_b_min_gel,
              admin_requires_mfa, request_delete_minutes)
  on public.rules to authenticated;                                         -- admins only, see policy

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.clients         enable row level security;
alter table public.requests        enable row level security;
alter table public.transactions    enable row level security;
alter table public.winback_actions enable row level security;
alter table public.loss_reasons    enable row level security;
alter table public.rules           enable row level security;
alter table public.audit_log       enable row level security;

-- profiles: yourself, or everyone if you can see all
create policy profiles_read on public.profiles for select to authenticated
  using (auth_user_id = (select auth.uid()) or (select private.can_see_all()));

-- clients: the ones in your book, or all
create policy clients_read on public.clients for select to authenticated
  using ((select private.can_see_all()) or private.is_my_client(client_id));
create policy clients_admin_update on public.clients for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- requests: your own, or all
create policy requests_read on public.requests for select to authenticated
  using (kam_id = (select private.my_profile_id()) or (select private.can_see_all()));
create policy requests_admin_update on public.requests for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy requests_admin_delete on public.requests for delete to authenticated
  using ((select private.is_admin()));

-- transactions: those of clients in your book, or all
create policy transactions_read on public.transactions for select to authenticated
  using ((select private.can_see_all()) or private.is_my_client(client_id));

-- win-back log: for clients in your book, or all
create policy winback_read on public.winback_actions for select to authenticated
  using ((select private.can_see_all()) or private.is_my_client(client_id));

-- loss reasons and rules: everyone signed in reads; admins change
create policy loss_reasons_read on public.loss_reasons for select to authenticated using (true);
create policy loss_reasons_admin_insert on public.loss_reasons for insert to authenticated
  with check ((select private.is_admin()));
create policy loss_reasons_admin_update on public.loss_reasons for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

create policy rules_read on public.rules for select to authenticated using (true);
create policy rules_admin_update on public.rules for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- audit log: admins only, read-only for everyone
create policy audit_admin_read on public.audit_log for select to authenticated
  using ((select private.is_admin()));

-- ---------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------
create or replace function private.audit_row()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
begin
  if tg_op = 'UPDATE' and v_old = v_new then
    return new;
  end if;
  insert into public.audit_log (actor_profile_id, action, table_name, row_key, old_data, new_data)
  values (
    private.my_profile_id(),
    lower(tg_op),
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'client_id', v_row ->> 'code'),
    v_old,
    v_new
  );
  return coalesce(new, old);
end;
$$;

create trigger audit_profiles        after insert or update or delete on public.profiles        for each row execute function private.audit_row();
create trigger audit_clients         after insert or update or delete on public.clients         for each row execute function private.audit_row();
create trigger audit_requests        after insert or update or delete on public.requests        for each row execute function private.audit_row();
create trigger audit_winback_actions after insert                     on public.winback_actions for each row execute function private.audit_row();
create trigger audit_loss_reasons    after insert or update or delete on public.loss_reasons    for each row execute function private.audit_row();
create trigger audit_rules           after update                     on public.rules           for each row execute function private.audit_row();

-- stamp who last changed the rules
create or replace function private.stamp_rules()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := private.my_profile_id();
  return new;
end;
$$;
create trigger stamp_rules before update on public.rules for each row execute function private.stamp_rules();


-- =====================================================================
-- KAM platform, migration 3 of 6: counting rules and app functions
--
-- The definitions live here, once, so every screen and every export
-- gives the same number:
--   turnover  = abs_gel + cross_gel, every payment status
--               (the not-successful part is reported separately)
--   income    = total_income, every payment status, nothing added on top
--   went through = a SUCCESS transaction from the same client on the
--               same Tbilisi date as the request
--   owner     = the KAM with the most requests for the client in the
--               window (ties go to the latest), unless assigned_kam_id is set
--   portfolio = clients with a request from the 1st of the month up to
--               month end + rules.month_grace_days
-- =====================================================================

-- ---------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------
create or replace function private.tbilisi_today()
returns date
language sql stable set search_path = ''
as $$ select (now() at time zone 'Asia/Tbilisi')::date $$;

-- Restores IDs that lost formatting on the way: strips spaces and a
-- trailing ".0", and puts back the leading zero of a 10-digit personal ID.
create or replace function private.normalize_client_id(p_raw text)
returns text
language sql immutable set search_path = ''
as $$
  select case when v ~ '^[0-9]{10}$' then '0' || v else v end
  from (select regexp_replace(regexp_replace(coalesce(p_raw, ''), '\s', '', 'g'), '\.0+$', '') as v) s
$$;

-- When transactions were last synced successfully
create or replace function public.data_freshness()
returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select max(s.finished_at)
  from private.sync_runs s
  where s.ok and s.kind in ('hourly', 'nightly')
$$;

create or replace function private.freshness_date()
returns date
language sql stable security definer set search_path = ''
as $$ select (public.data_freshness() at time zone 'Asia/Tbilisi')::date $$;

-- ---------------------------------------------------------------------
-- Request outcomes. Respects row-level security of the caller.
--   went_through        a same-day SUCCESS transaction exists
--   waiting             no such transaction yet, and the day is not
--                       fully synced (normally: today)
--   did_not_go_through  the day is over and synced, nothing went through
-- ---------------------------------------------------------------------
create or replace view public.request_outcomes
with (security_invoker = true)
as
select
  r.id,
  r.kam_id,
  p.full_name  as kam_name,
  r.client_id,
  c.name       as client_name,
  c.kind       as client_kind,
  r.requested_at,
  r.request_date,
  r.sells_currency,
  r.gets_currency,
  r.amount,
  r.rate,
  r.note,
  r.loss_reason,
  r.loss_reason_at,
  r.source,
  w.went_through,
  case
    when w.went_through then 'went_through'
    when r.request_date >= coalesce(private.freshness_date(), r.request_date) then 'waiting'
    else 'did_not_go_through'
  end as outcome
from public.requests r
join public.clients c on c.client_id = r.client_id
left join public.profiles p on p.id = r.kam_id
cross join lateral (
  select exists (
    select 1
    from public.transactions t
    where t.client_id = r.client_id
      and t.tx_date = r.request_date
      and t.payment_status = 'SUCCESS'
  ) as went_through
) w;

revoke all on public.request_outcomes from anon;
grant select on public.request_outcomes to authenticated;

-- ---------------------------------------------------------------------
-- Ownership: one owner per client for a date window (internal)
-- ---------------------------------------------------------------------
create or replace function private.owners(p_from date, p_to date)
returns table (client_id text, owner_id uuid, requests_in_window bigint)
language sql stable security definer set search_path = ''
as $$
  with counts as (
    select r.client_id, r.kam_id, count(*) as n, max(r.requested_at) as last_at
    from public.requests r
    where r.request_date >= p_from and r.request_date <= p_to
    group by r.client_id, r.kam_id
  ),
  ranked as (
    select k.client_id, k.kam_id,
           row_number() over (partition by k.client_id order by k.n desc, k.last_at desc) as rn,
           sum(k.n) over (partition by k.client_id) as total_n
    from counts k
  )
  select rk.client_id, coalesce(cl.assigned_kam_id, rk.kam_id), rk.total_n::bigint
  from ranked rk
  join public.clients cl on cl.client_id = rk.client_id
  where rk.rn = 1
$$;

-- ---------------------------------------------------------------------
-- Portfolio of a month: one row per client with its owner and its
-- calendar-month turnover and income. KAMs get their own clients only.
-- ---------------------------------------------------------------------
create or replace function public.month_portfolio(p_month date)
returns table (
  client_id                text,
  client_name              text,
  client_kind              text,
  owner_id                 uuid,
  owner_name               text,
  requests_in_window       bigint,
  turnover                 numeric,
  turnover_not_successful  numeric,
  income                   numeric,
  transactions             bigint
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_from  date := date_trunc('month', p_month)::date;
  v_to    date := (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date;
  v_grace int;
  v_me    uuid := private.my_profile_id();
  v_all   boolean := private.can_see_all();
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  select coalesce(r.month_grace_days, 0) into v_grace from public.rules r;

  return query
  with o as (
    select * from private.owners(v_from, v_to + v_grace)
  ),
  tx as (
    select t.client_id,
           sum(t.abs_gel + t.cross_gel) as turnover,
           coalesce(sum(t.abs_gel + t.cross_gel) filter (where t.payment_status <> 'SUCCESS'), 0) as turnover_ns,
           sum(t.total_income) as income,
           count(*) as n
    from public.transactions t
    where t.tx_date >= v_from and t.tx_date <= v_to
      and t.client_id in (select o.client_id from o)
    group by t.client_id
  )
  select o.client_id, c.name, c.kind, o.owner_id, p.full_name, o.requests_in_window,
         coalesce(tx.turnover, 0), coalesce(tx.turnover_ns, 0), coalesce(tx.income, 0), coalesce(tx.n, 0)::bigint
  from o
  join public.clients c  on c.client_id = o.client_id
  join public.profiles p on p.id = o.owner_id
  left join tx on tx.client_id = o.client_id
  where v_all or o.owner_id = v_me
  order by coalesce(tx.turnover, 0) desc;
end;
$$;

-- ---------------------------------------------------------------------
-- Scorecard of a month, one row per KAM. Portfolio figures follow the
-- owner; request figures follow the KAM who logged the request.
-- ---------------------------------------------------------------------
create or replace function public.kam_month_summary(p_month date)
returns table (
  kam_id                   uuid,
  kam_name                 text,
  clients                  bigint,
  turnover                 numeric,
  turnover_not_successful  numeric,
  income                   numeric,
  income_per_1m_turnover   numeric,
  requests_judged          bigint,
  requests_won             bigint,
  win_rate_pct             numeric
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to   date := (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date;
  v_me   uuid := private.my_profile_id();
  v_all  boolean := private.can_see_all();
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;

  return query
  with port as (
    select mp.owner_id as kid,
           count(*) as n_clients,
           sum(mp.turnover) as t,
           sum(mp.turnover_not_successful) as tns,
           sum(mp.income) as inc
    from public.month_portfolio(p_month) mp
    group by mp.owner_id
  ),
  req as (
    select o.kam_id as kid,
           count(*) filter (where o.outcome <> 'waiting') as judged,
           count(*) filter (where o.outcome = 'went_through') as won
    from public.request_outcomes o
    where o.request_date >= v_from and o.request_date <= v_to
    group by o.kam_id
  ),
  ids as (
    select port.kid from port
    union
    select req.kid from req
  )
  select ids.kid,
         p.full_name,
         coalesce(port.n_clients, 0)::bigint,
         coalesce(port.t, 0),
         coalesce(port.tns, 0),
         coalesce(port.inc, 0),
         case when coalesce(port.t, 0) > 0 then round(port.inc / port.t * 1000000, 0) end,
         coalesce(req.judged, 0)::bigint,
         coalesce(req.won, 0)::bigint,
         case when coalesce(req.judged, 0) > 0 then round(req.won::numeric / req.judged * 100, 1) end
  from ids
  join public.profiles p on p.id = ids.kid
  left join port on port.kid = ids.kid
  left join req  on req.kid  = ids.kid
  where v_all or ids.kid = v_me
  order by coalesce(port.t, 0) desc;
end;
$$;

-- ---------------------------------------------------------------------
-- Win-back list: clients who asked for a rate within the window and
-- have not had a successful transaction since their last request.
-- A client drops off the list on its own once a transaction arrives.
-- ---------------------------------------------------------------------
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
#variable_conflict use_column
declare
  v_me    uuid := private.my_profile_id();
  v_all   boolean := private.can_see_all();
  v_today date := private.tbilisi_today();
  v_fresh date;
  v_rules public.rules%rowtype;
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
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

-- ---------------------------------------------------------------------
-- The signed-in person
-- ---------------------------------------------------------------------
create or replace function public.my_profile()
returns table (id uuid, full_name text, email text, role text)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.full_name, p.email, p.role
  from public.profiles p
  where p.auth_user_id = (select auth.uid()) and p.active
$$;

-- ---------------------------------------------------------------------
-- Client lookup for the request form: name only, nothing else
-- ---------------------------------------------------------------------
create or replace function public.lookup_client(p_client_id text)
returns table (client_id text, valid boolean, known boolean, name text, kind text)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id text := private.normalize_client_id(p_client_id);
begin
  if private.my_profile_id() is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  return query
  select v_id,
         v_id ~ '^([0-9]{9}|[0-9]{11})$',
         c.client_id is not null,
         c.name,
         case when length(v_id) = 9 then 'company' when length(v_id) = 11 then 'person' end
  from (select 1) d
  left join public.clients c on c.client_id = v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Log a request (the only way requests are created from the app)
-- ---------------------------------------------------------------------
create or replace function public.log_request(
  p_client_id      text,
  p_sells_currency text,
  p_gets_currency  text,
  p_amount         numeric,
  p_rate           numeric,
  p_note           text default null,
  p_client_name    text default null
)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me         uuid := private.my_profile_id();
  v_id         text := private.normalize_client_id(p_client_id);
  v_sells      text := upper(trim(coalesce(p_sells_currency, '')));
  v_gets       text := upper(trim(coalesce(p_gets_currency, '')));
  v_new        boolean;
  v_request_id bigint;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot log requests' using errcode = '42501';
  end if;
  if v_id !~ '^([0-9]{9}|[0-9]{11})$' then
    raise exception 'Check the ID: companies have 9 digits, people 11' using errcode = '22023';
  end if;
  if v_sells !~ '^[A-Z]{3}$' or v_gets !~ '^[A-Z]{3}$' or v_sells = v_gets then
    raise exception 'Choose two different currencies' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter the amount' using errcode = '22023';
  end if;
  if p_rate is null or p_rate <= 0 then
    raise exception 'Enter the rate you offered' using errcode = '22023';
  end if;
  -- a client we don't know yet (or know without a name) must come with a name
  if not exists (select 1 from public.clients c where c.client_id = v_id and c.name is not null)
     and length(coalesce(trim(p_client_name), '')) < 2 then
    raise exception 'New client: enter the client''s name' using errcode = '22023';
  end if;

  insert into public.clients (client_id, name, created_by)
  values (v_id, nullif(trim(p_client_name), ''), v_me)
  on conflict (client_id) do nothing;
  v_new := found;

  if not v_new and nullif(trim(p_client_name), '') is not null then
    update public.clients c set name = trim(p_client_name)
    where c.client_id = v_id and c.name is null;
  end if;

  -- a client new to the platform: fetch its recent transaction history
  if v_new then
    insert into private.backfill_queue (client_id) values (v_id)
    on conflict (client_id) do update set done_at = null, queued_at = now();
  end if;

  insert into public.requests (kam_id, client_id, sells_currency, gets_currency, amount, rate, note)
  values (v_me, v_id, v_sells, v_gets, round(p_amount, 2), p_rate, nullif(trim(p_note), ''))
  returning id into v_request_id;

  return v_request_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Give (or clear, with null) the reason a request did not go through
-- ---------------------------------------------------------------------
create or replace function public.set_loss_reason(p_request_id bigint, p_reason text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me  uuid := private.my_profile_id();
  v_row public.request_outcomes%rowtype;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;
  select * into v_row from public.request_outcomes o where o.id = p_request_id;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_row.kam_id <> v_me and not private.is_admin() then
    raise exception 'This request belongs to another KAM' using errcode = '42501';
  end if;
  if v_row.outcome <> 'did_not_go_through' then
    raise exception 'Only requests that did not go through need a reason' using errcode = '22023';
  end if;
  if p_reason is not null and not exists (
    select 1 from public.loss_reasons l where l.code = p_reason and l.active
  ) then
    raise exception 'Unknown reason' using errcode = '22023';
  end if;

  update public.requests r
     set loss_reason = p_reason,
         loss_reason_at = case when p_reason is null then null else now() end
   where r.id = p_request_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Delete a request: the KAM who logged it, shortly after logging
-- (to fix a typo); admins any time. Every delete is in the audit log.
-- ---------------------------------------------------------------------
create or replace function public.delete_request(p_request_id bigint)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me      uuid := private.my_profile_id();
  v_req     public.requests%rowtype;
  v_minutes int;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;
  select * into v_req from public.requests r where r.id = p_request_id;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if not private.is_admin() then
    if v_req.kam_id <> v_me then
      raise exception 'This request belongs to another KAM' using errcode = '42501';
    end if;
    select r.request_delete_minutes into v_minutes from public.rules r;
    if v_req.created_at < now() - make_interval(mins => v_minutes) then
      raise exception 'Requests can be deleted only within % minutes of logging. Ask an admin.', v_minutes
        using errcode = '42501';
    end if;
  end if;
  delete from public.requests r where r.id = p_request_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Record the next step for a client on the win-back list
-- ---------------------------------------------------------------------
create or replace function public.set_winback_step(p_client_id text, p_step text, p_note text default null)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me uuid := private.my_profile_id();
  v_id text := private.normalize_client_id(p_client_id);
  v_action_id bigint;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot record win-back steps' using errcode = '42501';
  end if;
  if not exists (select 1 from public.clients c where c.client_id = v_id) then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;
  if not private.is_admin() and not private.is_my_client(v_id) then
    raise exception 'This client is not in your book' using errcode = '42501';
  end if;
  if p_step not in ('not_contacted', 'called', 'meeting_set', 'converted', 'not_interested') then
    raise exception 'Unknown step' using errcode = '22023';
  end if;
  insert into public.winback_actions (client_id, step, note, created_by)
  values (v_id, p_step, nullif(trim(p_note), ''), v_me)
  returning id into v_action_id;
  return v_action_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Function permissions: signed-in users only, never signed-out visitors
-- ---------------------------------------------------------------------
revoke execute on function
  public.data_freshness(),
  public.month_portfolio(date),
  public.kam_month_summary(date),
  public.winback_list(),
  public.my_profile(),
  public.lookup_client(text),
  public.log_request(text, text, text, numeric, numeric, text, text),
  public.set_loss_reason(bigint, text),
  public.delete_request(bigint),
  public.set_winback_step(text, text, text)
from public, anon;

grant execute on function
  public.data_freshness(),
  public.month_portfolio(date),
  public.kam_month_summary(date),
  public.winback_list(),
  public.my_profile(),
  public.lookup_client(text),
  public.log_request(text, text, text, numeric, numeric, text, text),
  public.set_loss_reason(bigint, text),
  public.delete_request(bigint),
  public.set_winback_step(text, text, text)
to authenticated;

-- ---------------------------------------------------------------------
-- Lock down: internal functions are not callable from the app, except
-- the few helpers the access rules and the outcomes view need.
-- ---------------------------------------------------------------------
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.my_profile_id(), private.my_role(), private.can_see_all(), private.is_admin(),
  private.can_write(), private.is_my_client(text), private.freshness_date(), private.tbilisi_today()
to authenticated;


-- =====================================================================
-- KAM platform, migration 5 of 6: syncing transactions, importing history
--
-- Two notes on querying ClickHouse through the wrapper:
--   * Date filters use ">=" only. An open bug report shows BETWEEN on a
--     foreign table can be sent to ClickHouse wrongly and silently
--     return wrong rows.
--   * Queries are built with literal values (EXECUTE format), so the
--     date and client filters run on ClickHouse instead of pulling
--     the whole table across.
-- =====================================================================

-- The one upsert statement both sync paths use. p_where is appended to
-- the ClickHouse query; it must only filter on tx_date and client_id.
create or replace function private.transactions_upsert_sql(p_where text)
returns text
language sql immutable set search_path = ''
as $$
  select format($sql$
    insert into public.transactions as t (
      tx_id, tx_time, tx_date, client_id, segment, operation_type, payment_status,
      abs_gel, cross_gel, total_income, spread_income, revaluation, synced_at
    )
    select s.tx_id,
           s.tx_time at time zone 'UTC',
           s.tx_date,
           private.normalize_client_id(s.client_id),
           s.segment,
           s.operation_type,
           s.payment_status,
           round(coalesce(s.abs_gel, 0)::numeric, 2),
           round(coalesce(s.cross_gel, 0)::numeric, 2),
           round(coalesce(s.total_income, 0)::numeric, 2),
           round(s.spread_income::numeric, 2),
           round(s.revaluation::numeric, 2),
           now()
    from ch.client_transactions s
    where %s
      and exists (select 1 from public.clients c where c.client_id = private.normalize_client_id(s.client_id))
    on conflict (tx_id) do update set
      tx_time        = excluded.tx_time,
      tx_date        = excluded.tx_date,
      client_id      = excluded.client_id,
      segment        = excluded.segment,
      operation_type = excluded.operation_type,
      payment_status = excluded.payment_status,
      abs_gel        = excluded.abs_gel,
      cross_gel      = excluded.cross_gel,
      total_income   = excluded.total_income,
      spread_income  = excluded.spread_income,
      revaluation    = excluded.revaluation,
      synced_at      = now()
    where (t.payment_status, t.abs_gel, t.cross_gel, t.total_income, t.tx_date, t.client_id)
          is distinct from
          (excluded.payment_status, excluded.abs_gel, excluded.cross_gel, excluded.total_income, excluded.tx_date, excluded.client_id)
  $sql$, p_where)
$$;

-- ---------------------------------------------------------------------
-- Regular sync: re-reads the last p_days days every run, so payment
-- statuses corrected after the fact are picked up too.
-- ---------------------------------------------------------------------
create or replace function private.sync_transactions(p_days int, p_kind text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_run  bigint;
  v_from date := private.tbilisi_today() - p_days;
  v_rows int;
begin
  insert into private.sync_runs (kind, from_date) values (p_kind, v_from) returning id into v_run;
  begin
    execute private.transactions_upsert_sql(format('s.tx_date >= %L::date', v_from));
    get diagnostics v_rows = row_count;
    update private.sync_runs
       set finished_at = now(), ok = true, rows_upserted = v_rows
     where id = v_run;
  exception when others then
    update private.sync_runs
       set finished_at = now(), ok = false, error = sqlerrm
     where id = v_run;
  end;
end;
$$;

-- ---------------------------------------------------------------------
-- Backfill: when a client appears on the platform for the first time,
-- fetch its last p_days of transactions.
-- ---------------------------------------------------------------------
create or replace function private.process_backfill(p_days int default 180, p_batch int default 20)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_client text;
  v_from   date := private.tbilisi_today() - p_days;
  v_rows   int;
  v_total  int := 0;
  v_run    bigint;
begin
  insert into private.sync_runs (kind, from_date) values ('backfill', v_from) returning id into v_run;
  for v_client in
    select q.client_id
    from private.backfill_queue q
    where q.done_at is null and q.attempts < 5
    order by q.queued_at
    limit p_batch
  loop
    begin
      execute private.transactions_upsert_sql(
        format('s.client_id = %L and s.tx_date >= %L::date', v_client, v_from)
      );
      get diagnostics v_rows = row_count;
      v_total := v_total + v_rows;
      update private.backfill_queue
         set done_at = now(), attempts = attempts + 1, last_error = null
       where client_id = v_client;
    exception when others then
      update private.backfill_queue
         set attempts = attempts + 1, last_error = sqlerrm
       where client_id = v_client;
    end;
  end loop;
  update private.sync_runs
     set finished_at = now(), ok = true, rows_upserted = v_total
   where id = v_run;
end;
$$;

-- ---------------------------------------------------------------------
-- One-off import of the cleaned agreement file.
-- Load the file into private.import_requests first (DEPLOY.md, part 7),
-- then: select * from private.run_history_import();
-- Safe to run again: rows already imported are skipped, and rows that
-- failed get their reason in import_error.
-- ---------------------------------------------------------------------
create or replace function private.run_history_import()
returns table (imported int, failed int)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_row       private.import_requests%rowtype;
  v_id        text;
  v_date      date;
  v_kam       uuid;
  v_sells     text;
  v_gets      text;
  v_amount    numeric;
  v_rate      numeric;
  v_req       bigint;
  v_ok        int := 0;
  v_bad       int := 0;
begin
  -- past KAMs without a login get a profile so their history has an owner
  insert into public.profiles (email, full_name, role, active)
  select distinct lower(trim(i.kam_email)), lower(trim(i.kam_email)), 'kam', true
  from private.import_requests i
  where coalesce(trim(i.kam_email), '') <> ''
  on conflict (email) do nothing;

  for v_row in
    select * from private.import_requests i
    where i.imported_request_id is null
    order by i.row_no
  loop
    begin
      v_id := private.normalize_client_id(v_row.client_id);
      if v_id !~ '^([0-9]{9}|[0-9]{11})$' then
        raise exception 'invalid client id: %', v_row.client_id;
      end if;

      v_date := case
        when v_row.request_date ~ '^\d{4}-\d{2}-\d{2}' then to_date(left(v_row.request_date, 10), 'YYYY-MM-DD')
        when v_row.request_date ~ '^\d{1,2}/\d{1,2}/\d{4}' then to_date(v_row.request_date, 'DD/MM/YYYY')
      end;
      if v_date is null then
        raise exception 'invalid date: %', v_row.request_date;
      end if;

      select p.id into v_kam from public.profiles p where p.email = lower(trim(v_row.kam_email));
      if v_kam is null then
        raise exception 'no KAM email';
      end if;

      v_sells  := nullif(upper(trim(coalesce(v_row.sells_currency, ''))), '');
      v_gets   := nullif(upper(trim(coalesce(v_row.gets_currency, ''))), '');
      if v_sells !~ '^[A-Z]{3}$' then v_sells := null; end if;
      if v_gets  !~ '^[A-Z]{3}$' then v_gets  := null; end if;
      if v_sells = v_gets then v_gets := null; end if;
      v_amount := nullif(nullif(regexp_replace(coalesce(v_row.amount, ''), '[^0-9.]', '', 'g'), ''), '.')::numeric;
      v_rate   := nullif(nullif(regexp_replace(coalesce(v_row.rate,   ''), '[^0-9.]', '', 'g'), ''), '.')::numeric;
      if v_amount <= 0 then v_amount := null; end if;
      if v_rate   <= 0 then v_rate   := null; end if;

      insert into public.clients as c (client_id, name)
      values (v_id, nullif(trim(v_row.client_name), ''))
      on conflict (client_id) do update
        set name = coalesce(c.name, excluded.name);

      insert into public.requests (
        kam_id, client_id, requested_at, request_date, sells_currency, gets_currency,
        amount, rate, source, legacy_status, legacy_loss_reason
      ) values (
        v_kam, v_id, (v_date + time '12:00') at time zone 'Asia/Tbilisi', v_date, v_sells, v_gets,
        round(v_amount, 2), v_rate, 'import', nullif(trim(v_row.legacy_status), ''), nullif(trim(v_row.legacy_loss_reason), '')
      )
      returning id into v_req;

      update private.import_requests set imported_request_id = v_req, import_error = null where row_no = v_row.row_no;
      v_ok := v_ok + 1;
    exception when others then
      update private.import_requests set import_error = sqlerrm where row_no = v_row.row_no;
      v_bad := v_bad + 1;
    end;
  end loop;

  -- fetch transaction history for every client the import brought in
  insert into private.backfill_queue (client_id)
  select c.client_id from public.clients c
  on conflict (client_id) do nothing;

  return query select v_ok, v_bad;
end;
$$;

-- ---------------------------------------------------------------------
-- Lock down: internal functions are not callable from the app, except
-- the few helpers the access rules and the outcomes view need.
-- ---------------------------------------------------------------------
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.my_profile_id(), private.my_role(), private.can_see_all(), private.is_admin(),
  private.can_write(), private.is_my_client(text), private.freshness_date(), private.tbilisi_today()
to authenticated;


-- =====================================================================
-- KAM platform, migration 7: client autofill
--
-- Suggestions for the "Client ID or name" field. An empty box shows
-- this KAM's own recent clients. Typing a name or ID searches the
-- whole company directory, so a company added by any KAM fills in
-- for the next person. Opening the box does not list everyone.
--
--   digits  -> IDs starting with them, also when a personal ID lost its
--              leading zero ("1001001" finds 01001001234)
--   letters -> names containing them, any case
--   empty   -> most recently requested clients
-- =====================================================================

create or replace function public.search_my_clients(p_query text default '', p_limit int default 8)
returns table (
  client_id            text,
  name                 text,
  kind                 text,
  last_request_date    date,
  last_sells_currency  text,
  last_gets_currency   text
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me     uuid := private.my_profile_id();
  v_all    boolean := private.can_see_all();
  v_q      text := trim(coalesce(p_query, ''));
  v_digits boolean;
  v_like   text;
  v_limit  int := least(greatest(coalesce(p_limit, 8), 1), 20);
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;

  v_digits := v_q ~ '^[0-9 ]+$';
  if v_digits then
    v_q := replace(v_q, ' ', '');
  end if;
  -- treat % and _ typed by the user as plain characters
  v_like := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');

  return query
  with pool as (
    -- an empty box shows this KAM's own recent clients; typing searches the whole directory
    select c.client_id, c.name, c.kind
    from public.clients c
    where (v_q = '' and (
            v_all
         or c.assigned_kam_id = v_me
         or exists (select 1 from public.requests r where r.client_id = c.client_id and r.kam_id = v_me)
          ))
       or v_q <> ''
  ),
  last_req as (
    select distinct on (r.client_id)
           r.client_id, r.request_date, r.sells_currency, r.gets_currency, r.requested_at
    from public.requests r
    where r.client_id in (select p.client_id from pool p)
      and (v_all or r.kam_id = v_me)
    order by r.client_id, r.requested_at desc
  )
  select p.client_id, p.name, p.kind, lr.request_date, lr.sells_currency, lr.gets_currency
  from pool p
  left join last_req lr on lr.client_id = p.client_id
  where v_q = ''
     or (v_digits and (p.client_id like v_like || '%' or p.client_id like '0' || v_like || '%'))
     or (not v_digits and p.name ilike '%' || v_like || '%')
  order by lr.requested_at desc nulls last, p.name
  limit v_limit;
end;
$$;

revoke execute on function public.search_my_clients(text, int) from public, anon;
grant execute on function public.search_my_clients(text, int) to authenticated;


-- =====================================================================
-- KAM platform, migration 8: treasury gives the rates
--
-- Flow: a KAM asks for a rate -> the request waits in treasury's queue
-- -> treasury sends a rate with a validity time, or sends the request
-- back with a reason -> the KAM tells the client -> the client's
-- transaction closes the request (unchanged: same-day SUCCESS).
-- An expired or sent-back request can be asked again.
-- Every rate treasury gives is kept in public.quotes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Treasury role
-- ---------------------------------------------------------------------
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'manager', 'treasury', 'kam'));
comment on table public.profiles is
  'One row per person. Roles: admin = everything incl. users and rules; manager = sees everything, changes nothing; treasury = gives rates, sees all requests; kam = own requests, clients and follow-ups.';

-- ---------------------------------------------------------------------
-- 2. Requests: the rate now comes from treasury, not from the KAM
-- ---------------------------------------------------------------------
alter table public.requests drop constraint requests_app_rows_complete;
alter table public.requests add constraint requests_app_rows_complete check (
  source = 'import'
  or (sells_currency is not null and gets_currency is not null and amount is not null)
);

alter table public.requests
  add column asked_at          timestamptz not null default now(),
  add column quote_status      text not null default 'asking'
                               check (quote_status in ('asking', 'quoted', 'declined')),
  add column rate_valid_until  timestamptz,
  add column quoted_by         uuid references public.profiles (id),
  add column quoted_at         timestamptz,
  add column decline_reason    text check (length(decline_reason) <= 200);

comment on column public.requests.rate is 'The rate treasury gave (latest). Imported rows keep the rate from the old file.';

-- imported history is not waiting for anyone
update public.requests set quote_status = 'quoted', asked_at = requested_at where source = 'import';

create index requests_asking_idx on public.requests (asked_at) where quote_status = 'asking';

-- ---------------------------------------------------------------------
-- 3. Every rate treasury gives, and every request sent back
-- ---------------------------------------------------------------------
create table public.quotes (
  id           bigint generated always as identity primary key,
  request_id   bigint not null references public.requests (id) on delete cascade,
  action       text not null check (action in ('quoted', 'declined')),
  rate         numeric(18,6) check (rate > 0),
  valid_until  timestamptz,
  reason       text check (length(reason) <= 200),
  created_by   uuid not null references public.profiles (id),
  created_at   timestamptz not null default now()
);
create index quotes_request_idx on public.quotes (request_id, created_at desc);
create trigger audit_quotes after insert on public.quotes for each row execute function private.audit_row();

-- ---------------------------------------------------------------------
-- 4. Default validity of a rate
-- ---------------------------------------------------------------------
alter table public.rules
  add column default_quote_minutes int not null default 15 check (default_quote_minutes between 1 and 240);
grant update (default_quote_minutes) on public.rules to authenticated;

-- ---------------------------------------------------------------------
-- 5. Who may do what
-- ---------------------------------------------------------------------
create or replace function private.is_treasury()
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.my_role() = 'treasury', false) $$;

-- treasury reads every request and client (also needed for live updates)
drop policy requests_read on public.requests;
create policy requests_read on public.requests for select to authenticated
  using (
    kam_id = (select private.my_profile_id())
    or (select private.can_see_all())
    or (select private.is_treasury())
  );

drop policy clients_read on public.clients;
create policy clients_read on public.clients for select to authenticated
  using (
    (select private.can_see_all())
    or (select private.is_treasury())
    or private.is_my_client(client_id)
  );

alter table public.quotes enable row level security;
revoke all on public.quotes from anon, authenticated;
grant select on public.quotes to authenticated;
create policy quotes_read on public.quotes for select to authenticated
  using (
    (select private.can_see_all())
    or (select private.is_treasury())
    or exists (
      select 1 from public.requests r
      where r.id = quotes.request_id and r.kam_id = (select private.my_profile_id())
    )
  );

-- ---------------------------------------------------------------------
-- 6. Outcomes view: same columns as before, plus the quote state
--    quote_state: asking | quoted | expired | declined
-- ---------------------------------------------------------------------
create or replace view public.request_outcomes
with (security_invoker = true)
as
select
  r.id,
  r.kam_id,
  p.full_name  as kam_name,
  r.client_id,
  c.name       as client_name,
  c.kind       as client_kind,
  r.requested_at,
  r.request_date,
  r.sells_currency,
  r.gets_currency,
  r.amount,
  r.rate,
  r.note,
  r.loss_reason,
  r.loss_reason_at,
  r.source,
  w.went_through,
  case
    when w.went_through then 'went_through'
    when r.request_date >= coalesce(private.freshness_date(), r.request_date) then 'waiting'
    else 'did_not_go_through'
  end as outcome,
  r.asked_at,
  r.quote_status,
  r.rate_valid_until,
  r.quoted_at,
  r.decline_reason,
  case
    when r.quote_status = 'quoted' and r.rate_valid_until is not null and r.rate_valid_until < now() then 'expired'
    else r.quote_status
  end as quote_state
from public.requests r
join public.clients c on c.client_id = r.client_id
left join public.profiles p on p.id = r.kam_id
cross join lateral (
  select exists (
    select 1
    from public.transactions t
    where t.client_id = r.client_id
      and t.tx_date = r.request_date
      and t.payment_status = 'SUCCESS'
  ) as went_through
) w;

-- ---------------------------------------------------------------------
-- 7. KAM: ask for a rate (replaces the old log_request, which took a rate)
-- ---------------------------------------------------------------------
drop function public.log_request(text, text, text, numeric, numeric, text, text);

create or replace function public.log_request(
  p_client_id      text,
  p_sells_currency text,
  p_gets_currency  text,
  p_amount         numeric,
  p_note           text default null,
  p_client_name    text default null
)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me         uuid := private.my_profile_id();
  v_id         text := private.normalize_client_id(p_client_id);
  v_sells      text := upper(trim(coalesce(p_sells_currency, '')));
  v_gets       text := upper(trim(coalesce(p_gets_currency, '')));
  v_new        boolean;
  v_request_id bigint;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot ask for rates' using errcode = '42501';
  end if;
  if v_id !~ '^([0-9]{9}|[0-9]{11})$' then
    raise exception 'Check the ID: companies have 9 digits, people 11' using errcode = '22023';
  end if;
  if v_sells !~ '^[A-Z]{3}$' or v_gets !~ '^[A-Z]{3}$' or v_sells = v_gets then
    raise exception 'Choose two different currencies' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter the amount' using errcode = '22023';
  end if;
  if not exists (select 1 from public.clients c where c.client_id = v_id and c.name is not null)
     and length(coalesce(trim(p_client_name), '')) < 2 then
    raise exception 'New client: enter the client''s name' using errcode = '22023';
  end if;

  insert into public.clients (client_id, name, created_by)
  values (v_id, nullif(trim(p_client_name), ''), v_me)
  on conflict (client_id) do nothing;
  v_new := found;

  if not v_new and nullif(trim(p_client_name), '') is not null then
    update public.clients c set name = trim(p_client_name)
    where c.client_id = v_id and c.name is null;
  end if;

  if v_new then
    insert into private.backfill_queue (client_id) values (v_id)
    on conflict (client_id) do update set done_at = null, queued_at = now();
  end if;

  insert into public.requests (kam_id, client_id, sells_currency, gets_currency, amount, note)
  values (v_me, v_id, v_sells, v_gets, round(p_amount, 2), nullif(trim(p_note), ''))
  returning id into v_request_id;

  return v_request_id;
end;
$$;

-- KAM: ask again after a rate expired or treasury sent the request back
create or replace function public.ask_again(p_request_id bigint, p_note text default null)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me  uuid := private.my_profile_id();
  v_row public.request_outcomes%rowtype;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot ask for rates' using errcode = '42501';
  end if;
  select * into v_row from public.request_outcomes o where o.id = p_request_id;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_row.kam_id <> v_me and not private.is_admin() then
    raise exception 'This request belongs to another KAM' using errcode = '42501';
  end if;
  if v_row.went_through then
    raise exception 'This request already went through' using errcode = '22023';
  end if;
  if v_row.quote_state not in ('expired', 'declined') then
    raise exception 'You can ask again once the rate has expired or treasury has sent it back' using errcode = '22023';
  end if;
  update public.requests r
     set quote_status = 'asking', asked_at = now(), rate = null, rate_valid_until = null,
         decline_reason = null, quoted_by = null, quoted_at = null,
         note = coalesce(nullif(trim(p_note), ''), r.note)
   where r.id = p_request_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. Treasury: the queue, giving a rate, sending a request back
-- ---------------------------------------------------------------------
create or replace function public.treasury_queue()
returns table (
  request_id       bigint,
  asked_at         timestamptz,
  waiting_seconds  int,
  kam_name         text,
  client_id        text,
  client_name      text,
  client_kind      text,
  is_new_client    boolean,
  sells_currency   text,
  gets_currency    text,
  amount           numeric,
  note             text,
  last_rate        numeric,   -- last rate given to this client for the same currencies (incl. an expired one on this request)
  last_rate_at     timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (private.is_treasury() or private.is_admin()) then
    raise exception 'Only treasury can see the rate queue' using errcode = '42501';
  end if;
  return query
  select r.id,
         r.asked_at,
         extract(epoch from now() - r.asked_at)::int,
         p.full_name,
         r.client_id,
         c.name,
         c.kind,
         not exists (select 1 from public.requests r2 where r2.client_id = r.client_id and r2.id <> r.id),
         r.sells_currency,
         r.gets_currency,
         r.amount,
         r.note,
         lq.rate,
         lq.created_at
  from public.requests r
  join public.clients c  on c.client_id = r.client_id
  join public.profiles p on p.id = r.kam_id
  left join lateral (
    select q.rate, q.created_at
    from public.quotes q
    join public.requests r3 on r3.id = q.request_id
    where r3.client_id = r.client_id
      and r3.sells_currency = r.sells_currency
      and r3.gets_currency = r.gets_currency
      and q.action = 'quoted'
    order by q.created_at desc
    limit 1
  ) lq on true
  where r.quote_status = 'asking'
  order by r.asked_at;
end;
$$;

create or replace function public.treasury_quote(p_request_id bigint, p_rate numeric, p_valid_minutes int default null)
returns timestamptz
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me     uuid := private.my_profile_id();
  v_req    public.requests%rowtype;
  v_min    int;
  v_until  timestamptz;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'Only treasury can give rates' using errcode = '42501';
  end if;
  -- lock the row so two dealers can't answer the same request
  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_req.quote_status <> 'asking' then
    raise exception 'This request has already been answered' using errcode = '22023';
  end if;
  if p_rate is null or p_rate <= 0 then
    raise exception 'Enter a rate first' using errcode = '22023';
  end if;
  v_min := coalesce(p_valid_minutes, (select r.default_quote_minutes from public.rules r));
  if v_min < 1 or v_min > 240 then
    raise exception 'Validity must be between 1 and 240 minutes' using errcode = '22023';
  end if;
  v_until := now() + make_interval(mins => v_min);

  update public.requests r
     set rate = p_rate, quote_status = 'quoted', rate_valid_until = v_until,
         quoted_by = v_me, quoted_at = now(), decline_reason = null
   where r.id = p_request_id;
  insert into public.quotes (request_id, action, rate, valid_until, created_by)
  values (p_request_id, 'quoted', p_rate, v_until, v_me);
  return v_until;
end;
$$;

create or replace function public.treasury_decline(p_request_id bigint, p_reason text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me  uuid := private.my_profile_id();
  v_req public.requests%rowtype;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'Only treasury can send requests back' using errcode = '42501';
  end if;
  if length(coalesce(trim(p_reason), '')) < 2 then
    raise exception 'Tell the KAM why' using errcode = '22023';
  end if;
  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_req.quote_status <> 'asking' then
    raise exception 'This request has already been answered' using errcode = '22023';
  end if;
  update public.requests r
     set quote_status = 'declined', decline_reason = trim(p_reason),
         quoted_by = v_me, quoted_at = now(), rate = null, rate_valid_until = null
   where r.id = p_request_id;
  insert into public.quotes (request_id, action, reason, created_by)
  values (p_request_id, 'declined', trim(p_reason), v_me);
end;
$$;

-- today's rates, for treasury's "Your quotes" list
create or replace function public.treasury_quotes_today()
returns table (
  request_id      bigint,
  client_name     text,
  kam_name        text,
  sells_currency  text,
  gets_currency   text,
  amount          numeric,
  rate            numeric,
  quoted_at       timestamptz,
  valid_until     timestamptz,
  quote_state     text,
  went_through    boolean
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (private.is_treasury() or private.is_admin()) then
    raise exception 'Only treasury can see quotes' using errcode = '42501';
  end if;
  return query
  select o.id, o.client_name, o.kam_name, o.sells_currency, o.gets_currency, o.amount,
         o.rate, o.quoted_at, o.rate_valid_until, o.quote_state, o.went_through
  from public.request_outcomes o
  where o.quote_status = 'quoted'
    and o.source = 'app'
    and (o.quoted_at at time zone 'Asia/Tbilisi')::date = private.tbilisi_today()
  order by o.quoted_at desc;
end;
$$;

-- ---------------------------------------------------------------------
-- 9. Permissions
-- ---------------------------------------------------------------------
revoke execute on function
  public.log_request(text, text, text, numeric, text, text),
  public.ask_again(bigint, text),
  public.treasury_queue(),
  public.treasury_quote(bigint, numeric, int),
  public.treasury_decline(bigint, text),
  public.treasury_quotes_today()
from public, anon;

grant execute on function
  public.log_request(text, text, text, numeric, text, text),
  public.ask_again(bigint, text),
  public.treasury_queue(),
  public.treasury_quote(bigint, numeric, int),
  public.treasury_decline(bigint, text),
  public.treasury_quotes_today()
to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.my_profile_id(), private.my_role(), private.can_see_all(), private.is_admin(),
  private.can_write(), private.is_my_client(text), private.freshness_date(), private.tbilisi_today(),
  private.is_treasury()
to authenticated;


-- =====================================================================
-- KAM platform, migration 9: reference rates for treasury
--
-- Treasury sees every rate it can use when quoting:
--   standard  our standard rates: we buy / we sell, GEL per 1 unit,
--             plus cross rates (e.g. USD priced in EUR)
--   nbg       the official National Bank of Georgia rate
-- Rates are loaded by a feed (core system, NBG) through
-- load_reference_rates, which only the service key can call.
-- Every rate treasury gives now also records the standard rate at
-- that moment, so special rates can later be compared to standard.
-- =====================================================================

create table public.reference_rates (
  source          text not null check (source in ('standard', 'nbg')),
  currency        text not null check (currency ~ '^[A-Z]{3}$'),
  quote_currency  text not null default 'GEL' check (quote_currency ~ '^[A-Z]{3}$'),
  buy             numeric(18,6) check (buy > 0),        -- standard: we buy the currency
  sell            numeric(18,6) check (sell > 0),       -- standard: we sell the currency
  official        numeric(18,6) check (official > 0),   -- nbg: official rate
  as_of           timestamptz not null,
  updated_at      timestamptz not null default now(),
  primary key (source, currency, quote_currency),
  constraint reference_rates_shape check (
    (source = 'standard' and buy is not null and sell is not null)
    or (source = 'nbg' and official is not null and quote_currency = 'GEL')
  )
);

alter table public.reference_rates enable row level security;
revoke all on public.reference_rates from anon, authenticated;
grant select on public.reference_rates to authenticated;
create policy reference_rates_read on public.reference_rates for select to authenticated
  using ((select private.can_see_all()) or (select private.is_treasury()));

-- ---------------------------------------------------------------------
-- Feed entry point (service key only).
-- p_rates: [{"currency":"USD","quote_currency":"GEL","buy":2.675,"sell":2.715,"as_of":"..."}]
--          [{"currency":"USD","official":2.6948,"as_of":"..."}]
-- ---------------------------------------------------------------------
create or replace function public.load_reference_rates(p_source text, p_rates jsonb)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_rows int;
begin
  if p_source not in ('standard', 'nbg') then
    raise exception 'Unknown source %', p_source using errcode = '22023';
  end if;
  insert into public.reference_rates as rr (source, currency, quote_currency, buy, sell, official, as_of, updated_at)
  select p_source,
         upper(x ->> 'currency'),
         upper(coalesce(x ->> 'quote_currency', 'GEL')),
         (x ->> 'buy')::numeric,
         (x ->> 'sell')::numeric,
         (x ->> 'official')::numeric,
         coalesce((x ->> 'as_of')::timestamptz, now()),
         now()
  from jsonb_array_elements(p_rates) x
  on conflict (source, currency, quote_currency) do update set
    buy = excluded.buy, sell = excluded.sell, official = excluded.official,
    as_of = excluded.as_of, updated_at = now();
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.load_reference_rates(text, jsonb) from public, anon, authenticated;
grant execute on function public.load_reference_rates(text, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- Rate for a deal direction (client sells p_sells, gets p_gets)
-- ---------------------------------------------------------------------
create or replace function private.standard_rate_for(p_sells text, p_gets text)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select case
    when p_gets = 'GEL' then (select r.buy  from public.reference_rates r where r.source = 'standard' and r.currency = p_sells and r.quote_currency = 'GEL')
    when p_sells = 'GEL' then (select r.sell from public.reference_rates r where r.source = 'standard' and r.currency = p_gets  and r.quote_currency = 'GEL')
    else (select r.buy from public.reference_rates r where r.source = 'standard' and r.currency = p_sells and r.quote_currency = p_gets)
  end
$$;

create or replace function private.nbg_rate_for(p_sells text, p_gets text)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select case
    when p_gets = 'GEL' then a.official
    when p_sells = 'GEL' then b.official
    else round(a.official / nullif(b.official, 0), 6)
  end
  from (select (select r.official from public.reference_rates r where r.source = 'nbg' and r.currency = p_sells) as official) a,
       (select (select r.official from public.reference_rates r where r.source = 'nbg' and r.currency = p_gets)  as official) b
$$;

-- ---------------------------------------------------------------------
-- All reference rates, for the "Rates now" panel
-- ---------------------------------------------------------------------
create or replace function public.treasury_rates()
returns table (source text, currency text, quote_currency text, buy numeric, sell numeric, official numeric, as_of timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (private.is_treasury() or private.can_see_all()) then
    raise exception 'Only treasury can see the rate sheet' using errcode = '42501';
  end if;
  return query
  select r.source, r.currency, r.quote_currency, r.buy, r.sell, r.official, r.as_of
  from public.reference_rates r
  order by r.source desc, r.quote_currency, r.currency;
end;
$$;

-- ---------------------------------------------------------------------
-- Queue now carries the standard and NBG rate for each deal direction
-- ---------------------------------------------------------------------
drop function public.treasury_queue();
create or replace function public.treasury_queue()
returns table (
  request_id       bigint,
  asked_at         timestamptz,
  waiting_seconds  int,
  kam_name         text,
  client_id        text,
  client_name      text,
  client_kind      text,
  is_new_client    boolean,
  sells_currency   text,
  gets_currency    text,
  amount           numeric,
  note             text,
  last_rate        numeric,
  last_rate_at     timestamptz,
  standard_rate    numeric,   -- our standard rate for this direction
  nbg_rate         numeric,   -- official rate (cross rates computed through GEL)
  last_given_today numeric    -- latest special rate given today for the same direction, any client
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (private.is_treasury() or private.is_admin()) then
    raise exception 'Only treasury can see the rate queue' using errcode = '42501';
  end if;
  return query
  select r.id,
         r.asked_at,
         extract(epoch from now() - r.asked_at)::int,
         p.full_name,
         r.client_id,
         c.name,
         c.kind,
         not exists (select 1 from public.requests r2 where r2.client_id = r.client_id and r2.id <> r.id),
         r.sells_currency,
         r.gets_currency,
         r.amount,
         r.note,
         lq.rate,
         lq.created_at,
         private.standard_rate_for(r.sells_currency, r.gets_currency),
         private.nbg_rate_for(r.sells_currency, r.gets_currency),
         lt.rate
  from public.requests r
  join public.clients c  on c.client_id = r.client_id
  join public.profiles p on p.id = r.kam_id
  left join lateral (
    select q.rate, q.created_at
    from public.quotes q
    join public.requests r3 on r3.id = q.request_id
    where r3.client_id = r.client_id
      and r3.sells_currency = r.sells_currency
      and r3.gets_currency = r.gets_currency
      and q.action = 'quoted'
    order by q.created_at desc
    limit 1
  ) lq on true
  left join lateral (
    select q.rate
    from public.quotes q
    join public.requests r4 on r4.id = q.request_id
    where r4.sells_currency = r.sells_currency
      and r4.gets_currency = r.gets_currency
      and q.action = 'quoted'
      and (q.created_at at time zone 'Asia/Tbilisi')::date = private.tbilisi_today()
    order by q.created_at desc
    limit 1
  ) lt on true
  where r.quote_status = 'asking'
  order by r.asked_at;
end;
$$;

-- ---------------------------------------------------------------------
-- Every rate given records the standard rate at that moment
-- ---------------------------------------------------------------------
alter table public.quotes add column standard_rate numeric(18,6);

create or replace function public.treasury_quote(p_request_id bigint, p_rate numeric, p_valid_minutes int default null)
returns timestamptz
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me     uuid := private.my_profile_id();
  v_req    public.requests%rowtype;
  v_min    int;
  v_until  timestamptz;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'Only treasury can give rates' using errcode = '42501';
  end if;
  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_req.quote_status <> 'asking' then
    raise exception 'This request has already been answered' using errcode = '22023';
  end if;
  if p_rate is null or p_rate <= 0 then
    raise exception 'Enter a rate first' using errcode = '22023';
  end if;
  v_min := coalesce(p_valid_minutes, (select r.default_quote_minutes from public.rules r));
  if v_min < 1 or v_min > 240 then
    raise exception 'Validity must be between 1 and 240 minutes' using errcode = '22023';
  end if;
  v_until := now() + make_interval(mins => v_min);

  update public.requests r
     set rate = p_rate, quote_status = 'quoted', rate_valid_until = v_until,
         quoted_by = v_me, quoted_at = now(), decline_reason = null
   where r.id = p_request_id;
  insert into public.quotes (request_id, action, rate, valid_until, created_by, standard_rate)
  values (p_request_id, 'quoted', p_rate, v_until, v_me,
          private.standard_rate_for(v_req.sells_currency, v_req.gets_currency));
  return v_until;
end;
$$;

-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------
revoke execute on function public.treasury_rates(), public.treasury_queue() from public, anon;
grant execute on function public.treasury_rates(), public.treasury_queue() to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.my_profile_id(), private.my_role(), private.can_see_all(), private.is_admin(),
  private.can_write(), private.is_my_client(text), private.freshness_date(), private.tbilisi_today(),
  private.is_treasury()
to authenticated;


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


-- =====================================================================
-- KAM platform, migration 11: notification schedules (needs pg_cron)
-- Times are UTC. Tbilisi is UTC+4, so 05:30 UTC = 09:30 Tbilisi.
-- =====================================================================

create extension if not exists pg_cron;

-- every minute: waiting-too-long and about-to-expire messages
select cron.schedule('kam-notify-timers',    '* * * * *',  $$select private.notify_timers()$$);

-- every minute: record Make's answers and retry failed messages
select cron.schedule('kam-notify-reconcile', '* * * * *',  $$select private.reconcile_notifications()$$);

-- every working day at 09:30 Tbilisi: KAM follow-up summary
select cron.schedule('kam-notify-daily',     '30 5 * * 1-5', $$select private.notify_daily_followups()$$);

-- weekly: keep 90 days of delivered messages and 30 days of marks
select cron.schedule('kam-notify-cleanup',   '45 0 * * 0', $$
  delete from public.notification_events where created_at < now() - interval '90 days';
  delete from private.notification_marks where created_at < now() - interval '30 days';
$$);


-- =====================================================================
-- KAM platform, migration 12: what the admin screen and live updates need
-- =====================================================================

-- "Sync now" runs count as fresh data too
create or replace function public.data_freshness()
returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select max(s.finished_at)
  from private.sync_runs s
  where s.ok and s.kind in ('hourly', 'nightly', 'manual')
$$;

-- Data sync panel: freshness, last runs, clients waiting for history
create or replace function public.admin_sync_status()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only admins can see the sync status' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'freshness', public.data_freshness(),
    'last_nightly', (select max(s.finished_at) from private.sync_runs s where s.ok and s.kind = 'nightly'),
    'backfill_waiting', (select count(*) from private.backfill_queue q where q.done_at is null and q.attempts < 5),
    'runs', coalesce((
      select jsonb_agg(x order by x.started_at desc)
      from (
        select s.id, s.kind, s.started_at, s.finished_at, s.ok, s.rows_upserted, s.error
        from private.sync_runs s
        order by s.started_at desc
        limit 10
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

-- "Sync now" button: re-reads the last 2 days right away
create or replace function public.admin_sync_now()
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only admins can start a sync' using errcode = '42501';
  end if;
  perform private.sync_transactions(2, 'manual');
  return public.admin_sync_status();
end;
$$;

-- Messages panel: is each role's Make webhook set, and how is delivery going
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
         exists (select 1 from vault.decrypted_secrets ds where ds.name = 'make_webhook_' || a.aud),
         (select max(n.delivered_at) from public.notification_events n where n.audience = a.aud),
         (select count(*) from public.notification_events n where n.audience = a.aud and n.status = 'failed' and n.created_at > now() - interval '1 day'),
         (select count(*) from public.notification_events n where n.audience = a.aud and n.status in ('pending', 'sent'))
  from (values ('treasury'), ('kam'), ('admin'), ('manager')) a(aud);
end;
$$;

revoke execute on function public.admin_sync_status(), public.admin_sync_now(), public.admin_message_status(), public.data_freshness() from public, anon;
grant execute on function public.admin_sync_status(), public.admin_sync_now(), public.admin_message_status(), public.data_freshness() to authenticated;

-- Live updates: new requests reach treasury and rates reach KAMs without refreshing.
-- Realtime still applies the access rules, so everyone only receives rows they may see.
do $$
begin
  alter publication supabase_realtime add table public.requests;
exception when others then
  raise notice 'Realtime publication not changed: %', sqlerrm;
end;
$$;


-- =====================================================================
-- KAM platform, migration 13: a request only "went through" on a
-- transaction made after the request; imported rows are history
--
-- Same-day matching alone marked a new request as done when the client
-- had already converted earlier that day. Requests from the app now need
-- a successful transaction on the same day AND after the request was made
-- (1 minute's leeway for clock differences). Imported history keeps the date-only rule, since
-- the old file has no times.
-- =====================================================================

create or replace view public.request_outcomes
with (security_invoker = true)
as
select
  r.id,
  r.kam_id,
  p.full_name  as kam_name,
  r.client_id,
  c.name       as client_name,
  c.kind       as client_kind,
  r.requested_at,
  r.request_date,
  r.sells_currency,
  r.gets_currency,
  r.amount,
  r.rate,
  r.note,
  r.loss_reason,
  r.loss_reason_at,
  r.source,
  w.went_through,
  case
    when w.went_through then 'went_through'
    when r.request_date >= coalesce(private.freshness_date(), r.request_date) then 'waiting'
    else 'did_not_go_through'
  end as outcome,
  r.asked_at,
  r.quote_status,
  r.rate_valid_until,
  r.quoted_at,
  r.decline_reason,
  case
    when r.quote_status = 'quoted' and r.rate_valid_until is not null and r.rate_valid_until < now() then 'expired'
    else r.quote_status
  end as quote_state
from public.requests r
join public.clients c on c.client_id = r.client_id
left join public.profiles p on p.id = r.kam_id
cross join lateral (
  select exists (
    select 1
    from public.transactions t
    where t.client_id = r.client_id
      and t.tx_date = r.request_date
      and t.payment_status = 'SUCCESS'
      -- a request from the app only counts transactions made after it was asked
      -- (1 minute's leeway for clock differences); imported history has no times
      and (r.source = 'import' or t.tx_time >= r.requested_at - interval '1 minute')
  ) as went_through
) w;

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
        and new.tx_time >= q.requested_at - interval '1 minute'
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
          and t.tx_time >= q.requested_at - interval '1 minute'
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

-- Rows from the old agreement file are history: never waiting for treasury
create or replace function private.import_rows_are_history()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.source = 'import' then
    new.quote_status := 'quoted';
    new.asked_at := new.requested_at;
  end if;
  return new;
end;
$$;
create trigger import_rows_are_history before insert on public.requests
  for each row execute function private.import_rows_are_history();
update public.requests set quote_status = 'quoted', asked_at = requested_at
where source = 'import' and quote_status = 'asking';

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.my_profile_id(), private.my_role(), private.can_see_all(), private.is_admin(),
  private.can_write(), private.is_my_client(text), private.freshness_date(), private.tbilisi_today(),
  private.is_treasury()
to authenticated;
-- =====================================================================
-- Analytics from an uploaded transaction file.
-- Paste into the Supabase SQL Editor and run once.
-- =====================================================================

-- An upload counts as fresh data, same as a sync.
create or replace function public.data_freshness()
returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select max(s.finished_at)
  from private.sync_runs s
  where s.ok and s.kind in ('hourly', 'nightly', 'manual', 'upload')
$$;

-- Rows from the Excel or CSV. Admins only. Same columns the rate
-- counting already uses: abs_gel + cross_gel is turnover, total_income
-- is income. A repeated transaction id updates the existing row.
create or replace function public.import_transactions(p_rows jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_run     bigint;
  v_before  bigint;
  v_after   bigint;
  v_upserted int;
  v_skipped  int;
begin
  if not private.is_admin() then
    raise exception 'Only admins can upload transactions' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Expected a list of transactions';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'Send at most 1000 transactions at a time';
  end if;

  insert into private.sync_runs (kind) values ('upload') returning id into v_run;

  select count(*) into v_before from public.clients;

  with raw as (
    select *
    from jsonb_to_recordset(p_rows) as x(
      tx_id text, tx_date text, client_id text, client_name text,
      segment text, operation_type text, payment_status text,
      abs_gel numeric, cross_gel numeric, total_income numeric,
      spread_income numeric, revaluation numeric
    )
  ),
  clean as (
    select nullif(trim(tx_id), '') as tx_id,
           case when tx_date ~ '^\d{4}-\d{2}-\d{2}$' then tx_date::date end as tx_date,
           private.normalize_client_id(client_id) as client_id,
           nullif(left(btrim(coalesce(client_name, '')), 200), '') as client_name,
           nullif(btrim(segment), '') as segment,
           nullif(btrim(operation_type), '') as operation_type,
           upper(nullif(btrim(payment_status), '')) as payment_status,
           round(coalesce(abs_gel, 0), 2) as abs_gel,
           round(coalesce(cross_gel, 0), 2) as cross_gel,
           round(coalesce(total_income, 0), 2) as total_income,
           round(spread_income, 2) as spread_income,
           round(revaluation, 2) as revaluation
    from raw
  ),
  good as (
    select distinct on (tx_id) *
    from clean
    where tx_id is not null
      and tx_date is not null
      and client_id <> ''
      and payment_status is not null
      and lower(coalesce(operation_type, '')) not in ('position-close-in-bank', 'fastoo', 'bitnet', 'unipay')
    order by tx_id
  ),
  added as (
    insert into public.clients as c (client_id, name)
    select g.client_id, g.client_name
    from good g
    where g.client_id ~ '^([0-9]{9}|[0-9]{11})$'
    on conflict (client_id) do update
      set name = coalesce(c.name, excluded.name)
    returning 1
  ),
  saved as (
    insert into public.transactions as t (
      tx_id, tx_time, tx_date, client_id, segment, operation_type, payment_status,
      abs_gel, cross_gel, total_income, spread_income, revaluation, synced_at
    )
    select g.tx_id,
           (g.tx_date + time '12:00') at time zone 'Asia/Tbilisi',
           g.tx_date, g.client_id, g.segment, g.operation_type, g.payment_status,
           g.abs_gel, g.cross_gel, g.total_income, g.spread_income, g.revaluation, now()
    from good g
    on conflict (tx_id) do update set
      tx_time = excluded.tx_time,
      tx_date = excluded.tx_date,
      client_id = excluded.client_id,
      segment = excluded.segment,
      operation_type = excluded.operation_type,
      payment_status = excluded.payment_status,
      abs_gel = excluded.abs_gel,
      cross_gel = excluded.cross_gel,
      total_income = excluded.total_income,
      spread_income = excluded.spread_income,
      revaluation = excluded.revaluation,
      synced_at = now()
    returning 1
  )
  select (select count(*) from saved),
         (select count(*) from clean) - (select count(*) from good)
    into v_upserted, v_skipped;

  select count(*) into v_after from public.clients;

  update private.sync_runs
     set finished_at = now(), ok = true, rows_upserted = v_upserted
   where id = v_run;

  return jsonb_build_object(
    'upserted', v_upserted,
    'skipped', v_skipped,
    'clients_added', v_after - v_before
  );
exception when others then
  update private.sync_runs
     set finished_at = now(), ok = false, error = sqlerrm
   where id = v_run;
  raise;
end;
$$;

-- Company numbers from the uploaded transactions. Same rules as the
-- Team page: turnover is abs GEL plus cross GEL, income is total income.
create or replace function public.analytics_kpis(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_from date := p_from;
  v_to   date := p_to;
begin
  if not private.can_see_all() then
    raise exception 'Only admins and managers can see analytics' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'transactions', (select count(*) from public.transactions t
                      where (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)),
    'clients', (select count(distinct t.client_id) from public.transactions t
                 where (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)),
    'turnover', coalesce((select sum(t.abs_gel + t.cross_gel) from public.transactions t
                           where (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)), 0),
    'turnover_not_successful', coalesce((select sum(t.abs_gel + t.cross_gel) from public.transactions t
                           where t.payment_status <> 'SUCCESS'
                             and (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)), 0),
    'income', coalesce((select sum(t.total_income) from public.transactions t
                         where (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)), 0),
    'successful', (select count(*) from public.transactions t
                    where t.payment_status = 'SUCCESS'
                      and (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)),
    'by_month', coalesce((
      select jsonb_agg(x order by x.month)
      from (
        select to_char(date_trunc('month', t.tx_date), 'YYYY-MM-DD') as month,
               count(*) as transactions,
               count(distinct t.client_id) as clients,
               sum(t.abs_gel + t.cross_gel) as turnover,
               coalesce(sum(t.abs_gel + t.cross_gel) filter (where t.payment_status <> 'SUCCESS'), 0) as turnover_not_successful,
               sum(t.total_income) as income
        from public.transactions t
        where (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)
        group by date_trunc('month', t.tx_date)
      ) x
    ), '[]'::jsonb),
    'top_clients', coalesce((
      select jsonb_agg(x order by x.turnover desc)
      from (
        select t.client_id, c.name,
               sum(t.abs_gel + t.cross_gel) as turnover,
               sum(t.total_income) as income,
               count(*) as transactions
        from public.transactions t
        left join public.clients c on c.client_id = t.client_id
        where (v_from is null or t.tx_date >= v_from) and (v_to is null or t.tx_date <= v_to)
        group by t.client_id, c.name
        order by sum(t.abs_gel + t.cross_gel) desc
        limit 15
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.import_transactions(jsonb), public.analytics_kpis(date, date) from public, anon;
grant execute on function public.import_transactions(jsonb), public.analytics_kpis(date, date) to authenticated;
