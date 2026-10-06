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
