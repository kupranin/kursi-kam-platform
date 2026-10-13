-- Do not paste this until you have approved it.
-- Do not paste it inside a transaction. Do not paste it together with
-- 33_active_reads.sql in one transaction block.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction. Supabase
-- migration runners, and a SQL editor that wraps the whole script in
-- BEGIN/COMMIT, will fail with "cannot run inside a transaction block".
-- Paste ONE statement at a time into the SQL editor, with no BEGIN.
-- If an earlier attempt left an index INVALID, drop that index and create
-- it again.
--
-- These support desk_day_rows (setup 33): source = app AND one timestamp
-- >= Tbilisi midnight, as a separate arm of the OR. They do not change
-- requests, request_outcomes, RLS, or any function.
-- No EXPLAIN was run. The planner may still ignore them.
--
-- Not created here, on purpose:
--   requests_date_idx already covers request_date = today.
--   requests_kam_date_idx and requests_asking_idx already cover the KAM
--   open-card filter. requests_asking_idx stays; treasury_queue uses it.
--   requests_better_open_idx stays; it is only the open better-rate arm,
--   which is not the desk's client_replied_at arm.

create index concurrently if not exists requests_app_quoted_at_idx
  on public.requests (quoted_at)
  where source = 'app' and quoted_at is not null;

create index concurrently if not exists requests_app_asked_at_idx
  on public.requests (asked_at)
  where source = 'app' and asked_at is not null;

create index concurrently if not exists requests_app_client_replied_at_idx
  on public.requests (client_replied_at)
  where source = 'app' and client_replied_at is not null;

create index concurrently if not exists requests_app_rate_written_at_idx
  on public.requests (rate_written_at)
  where source = 'app' and rate_written_at is not null;

create index concurrently if not exists requests_app_rate_valid_until_idx
  on public.requests (rate_valid_until)
  where source = 'app' and rate_valid_until is not null;

create index concurrently if not exists requests_app_loss_reason_at_idx
  on public.requests (loss_reason_at)
  where source = 'app' and loss_reason_at is not null;
