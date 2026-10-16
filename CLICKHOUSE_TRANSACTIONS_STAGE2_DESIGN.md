# Stage 2 — ClickHouse transactions (design only)

This document proposes a later sync. It does not create a table, function, sync job, credential, host, or query against ClickHouse.

ClickHouse has never been connected from this project. Live column types, nullability, time zone, and decimal scale are **unknown**. They are an open check before any query or table definition is finalized. No type below is a confirmed ClickHouse type.

No hostname, password, user, or sample rate is included, because none was available to confirm.

## Source contract

Read only rows that satisfy all of these:

- `is_registered = true`
- `sender_id IS NOT NULL`
- `status = 'SUCCESS'`
- `operation_type = 'conversion'`

Those four filters stay on the source query. They are not copied onto the destination table. The destination is already the set of registered, identified, successful conversions. Storing the filter columns would only be justified if a later correction could change one of them on a row we must keep (for example a SUCCESS later reversed). That need is not demonstrated. If a reversal must be represented, the sync deletes or supersedes the destination row. It does not keep a status column “just in case”.

| Source column | Destination column | Type |
| --- | --- | --- |
| `transaction_id` | `tx_id` | unknown |
| `client_id` (same identifier as `sender_id`) | `client_id` | unknown |
| `sender_name` | `client_name` | unknown |
| `created_at` | `tx_time` | unknown |
| `abs_gel` | `abs_gel` | unknown |
| `cross_gel` | `cross_gel` | unknown |
| `total_income` | `total_income` | unknown |
| `client_type` | `client_type` | unknown |
| `currency_to_send` | `sells_currency` | unknown |
| `currency` | `gets_currency` | unknown |

`client_id` and `sender_id` are the same identifier. The destination stores it once, as `client_id`. Confirm that equality on a live sample before the first backfill. If they ever differ, stop and do not guess which one is the client.

## Open checks before any query is finalized

1. ClickHouse types and nullability for every source column above.
2. Whether `created_at` is UTC, Asia/Tbilisi, or a naive timestamp, and whether it has fractional seconds.
3. Scale of `abs_gel`, `cross_gel`, and `total_income` (integer tetri, numeric, or float).
4. Whether `transaction_id` is unique among rows that pass the filters, and what an empty id looks like.
5. Whether a SUCCESS row can later be corrected or removed, and which column moves when it does (`created_at`, an update timestamp, or a version).
6. That `client_id` and `sender_id` are the same value on real rows.
7. Currency code shape (`USD` versus a numeric or Georgian label).

Until those are answered, the destination types stay unspecified. Do not invent them.

## Proposed destination

A Postgres table is the product store, same as today’s `transactions` table, so RLS and the app stay on Supabase. ClickHouse remains the source of truth for the bank extract. The destination holds one row per payment the filters accept.

Suggested columns, types still unknown until the open checks:

- `tx_id` — the source `transaction_id` when it is present and non-blank
- `client_id`, `client_name`, `client_type`
- `tx_time` — the source `created_at`, stored as `timestamptz` only after the zone check
- `abs_gel`, `cross_gel`, `total_income` — numeric only after the scale check; do not use float for money if the source is decimal
- `sells_currency`, `gets_currency`
- `synced_at` — when this warehouse last wrote the row (ours, not the bank’s)

No `is_registered`, `status`, `payment_status`, or `operation_type` unless check 5 shows we must retain a row after the source stops matching the filters.

A row with no `transaction_id` still has to be stored once. It cannot use `tx_id` as its identity. Give it a separate insert identity that the sync does not regenerate on the next run (a hash of the stable source fields, or the source’s physical row identity if one exists). Do not invent a `transaction_id`. The current product rule is the same: the same `tx_id` counts once, and a row with no `tx_id` still counts once.

## Sync

One job, least privilege, no credential in the app or in git.

- A worker outside the browser reads ClickHouse and writes Postgres.
- Backfill: walk the source in `created_at` order, in bounded batches, and upsert.
- Incremental: a watermark of the last successfully committed source timestamp, plus an overlap window (suggested 48 hours, to be confirmed once late-arrival behavior is known). Re-read the overlap on every run.
- Idempotent upsert on `tx_id` when `tx_id` is present: later source values replace `abs_gel`, `cross_gel`, `total_income`, names, currencies, and `tx_time`.
- Rows with no `tx_id` insert once under their separate identity. A re-read of the same source row updates that identity. It does not insert a second copy.
- Late or corrected records: the overlap plus upsert applies the correction. If the source can correct a row without moving `created_at`, the watermark alone will miss it. That is open check 5. If there is no update column, the overlap must be long enough to cover the bank’s correction window, or the job must periodically re-read a closed month.
- A failed batch does not advance the watermark. Retry the same batch with backoff. Record the error and the watermark that was not committed. Do not skip a batch to “catch up”.
- After a successful batch, the watermark moves to the minimum of “latest `created_at` read” and “now minus the overlap”, so a row that appears during the run is not skipped.

## Time and money

Month membership for turnover is the Asia/Tbilisi calendar month of the payment, not the month of the request. That is the current rule in `20261009150000_analytics_count.sql`: a payment whose time falls in a previous month stays out of the month being viewed, even when the client requested this month.

Until the zone of `created_at` is known:

- If it is UTC, convert to `timestamptz` and bucket with `AT TIME ZONE 'Asia/Tbilisi'`.
- If it is already Tbilisi wall time with no zone, store it as that civil time. Do not convert it a second time.
- If it is naive and the zone is still unknown, do not finalize the month function.

Empty `abs_gel` or `cross_gel` contributes zero to a turnover sum, matching today’s `coalesce(..., 0)`. Empty is not the same as a blank request GEL figure. Request GEL (Stage 1 analytics) and bank turnover stay separate totals. A blank request GEL still adds nothing to request lari.

Round money to the source scale once it is known. Today’s Postgres import rounds gel and income to two decimal places. Do not assume two places until check 3 says so. Do not multiply by 84.7 or any other constant.

## Indexes

After types exist:

- Unique index on `tx_id` where `tx_id` is not null.
- Unique index on the no-id identity where `tx_id` is null.
- Index on `(client_id, tx_time)` for month turnover, which looks up a month’s clients and then their payments.
- Do not index a request-match key that is only client id plus currency pair. That key is not unique.

## Reconciliation

Each run records: rows read, rows inserted, rows updated, rows skipped as duplicates, watermark before and after, and the Tbilisi month totals of `abs_gel + cross_gel` and `total_income`.

A separate check, not on the request path, compares those month totals to a ClickHouse aggregate over the same filters and the same zone. A mismatch blocks cutover. It does not block reading the old `transactions` table.

Turnover does not require a unique request match. Every payment in the month whose client also requested in that month counts, including many payments for one client. `matched_request_id` is not an input to that sum.

## Matching a SUCCESS row to a request

Do not match on client id plus currency pair. One client has many requests on the same pair.

Do not set a request’s success flag from a non-unique match. A wrong success flag blocks loss approval and changes `went_through`.

Proposed match, all of the following, and only when exactly one request fits:

- Same `client_id` (after the existing leading-zero rule on a 10-digit id).
- Payment time on the request’s Tbilisi `request_date`, and not before `requested_at` minus one minute (the current `tx_hit` window for app requests).
- `sells_currency` and `gets_currency` equal the request pair, in that direction.
- The gel side, when both the payment and the request have one, agrees within the source scale. If either side has no gel figure, do not invent one and do not match on gel.
- No other open or historical request for that client on that date and pair satisfies the same checks.

If zero requests fit, the payment still counts in turnover. It does not set a success flag.

If two or more requests fit, the payment still counts once in turnover. It does not set a success flag on any of them. A person can attach `matched_request_id` later. That attachment is optional and is not required for the month total.

This is stricter than today’s `tx_hit`, which treats any SUCCESS for that client on that date (or an existing `matched_request_id`) as a hit, with no pair and no uniqueness check. Cutover must not widen that. Replacing `tx_hit` with the stricter rule is a product change and needs its own approval, because it can move requests between success and loss.

## Who can read it

- The sync role can insert and update only this table. It cannot read `requests`, change RLS, or sign in as a user.
- App roles do not get the ClickHouse secret. The browser never queries ClickHouse.
- RLS on the destination should match today’s `transactions` policy: `private.can_see_all()` (admin and manager) or the client is the caller’s own client. A KAM does not see other KAMs’ payments. An analyst is not added. Treasury is not granted a new company-wide payment view unless a later product decision says so.
- Secrets live in the worker’s environment, not in the repo, not in `VITE_*`, and not in a migration.

## Cutover and rollback

1. Build the new table empty. Do not drop `public.transactions`.
2. Backfill and reconcile month totals against ClickHouse. Leave the app on the old table.
3. When totals match for the months the business still reports, point the turnover read at the new table behind a switch. Request success flags stay on the old `tx_hit` until the stricter match is explicitly approved.
4. Rollback is switching the read back to `public.transactions`. The old table is still populated until a later, separate decision retires it. The new table can be truncated and refilled. Nothing in Stage 2 deletes historical payments.

## Product rules that must survive

- A payment dated in a previous Tbilisi month stays out of the month being viewed.
- The same `tx_id` counts once.
- A row with no `tx_id` still counts once, and the sync does not invent an id.
- Turnover does not require a unique request match.
- A request’s success flag is not set from a weak match (client id and pair alone, or several requests on the same day).
- Request-derived GEL (Stage 1) is not this turnover. A written rate is not a confirmed bank transaction. `payment_confirmed_at` and a real SUCCESS match remain the payment marks.
- RUB rate handling and blank request GEL stay on the request side. They are not applied to `abs_gel` or `cross_gel`.

## What this stage does not do

No table, function, sync, credential, or ClickHouse query is part of Stage 1. This file is the design only.
