# Phase 2 performance changes

Read optimization for the KAM–Treasury workflow. No commit, no deploy, no SQL applied to a database.

This is Phase 2 in `PERFORMANCE_AUDIT.md` (issue 1 and issue 10), on top of Phase 1. Phase 1 client behavior stays: the 3-second `treasury_queue` check, the 15-second desk reload, coalesced Realtime, history not reloading on every quote, and header badges off Realtime.

`public.request_outcomes` is not modified. Its columns, order, and SQL body stay as in `supabase/setup/32_loss_visible.sql`. `SECURITY DEFINER` stays on `analyst_deals` and `request_rate_names`.

## Security model (this is the spec the SQL follows)

`public.request_active` is a view with `security_invoker = true`. It is not security definer. A select runs as the signed-in user, so row-level security on the underlying tables applies. The view reads only `requests`, `clients`, and `profiles`. It does not read `transactions`.

Who can select a request row, same rule as `requests_read` today:

| Role | Rows |
|---|---|
| KAM | `kam_id` equal to that KAM’s profile id. Another KAM’s requests are not returned. |
| Admin, manager | All rows. `private.can_see_all()` is admin and manager. |
| Treasury | All rows. `private.is_treasury()`, same as today. |
| Analyst | No request rows. Analyst is not a KAM, not treasury, and not `can_see_all`. This view does not add any. |
| Signed out | No grant to `anon`. |

The client join is an inner join, copied from `request_outcomes`. `clients_read` is `can_see_all`, treasury, or `is_my_client`. A row the outcomes view would hide because the client is not visible stays hidden. The profile joins are left joins. `profiles_read` is your own profile or admin/manager, so a treasury user can get a null KAM name here, the same as on `request_outcomes` today. This view does not grant treasury, a KAM, or an analyst new profile rows. Names for “who quoted” and “who wrote” still come from `request_rate_names`, which stays security definer.

`public.desk_day_rows` and `public.request_went_through_ids` are `security invoker`. They select from `request_outcomes`, so the caller’s existing rights on that view apply. They do not bypass RLS. An analyst who calls either gets no rows. A KAM who calls either gets only their own ids. The rate desk calls `desk_day_rows` for treasury and admin, who can already select `request_outcomes`. `request_went_through_ids` returns only `id`, and only for ids the caller passed that the view already marks `went_through`.

Grants: `select` on the view and `execute` on both functions to `authenticated` only. `public` and `anon` are revoked.

## Reads that move off `request_outcomes`

These are the reads that leave the outcomes view, and why that does not change the workflow.

1. **KAM open cards** (`Requests.tsx` `load`, every 10 seconds, Realtime, focus, visibility). The card body is `request_active` for that KAM, `request_date = today` or `quote_status = asking`. Written rate and `payment_confirmed_at` are columns on `requests`. Before the cards paint, the same load asks `request_went_through_ids` for those ids. Ids the outcomes view already marks `went_through` (including a payment match) are stamped `went_through`, `outcome = went_through`, and `loss_open = false`. A matched row is not shown as a loss. The client does not reimplement the payment rule. If that call cannot be answered, the previous reconciled list stays. Ownership filter `kam_id` stays, and the id function is security invoker, so another KAM’s id is not returned.

2. **Older approved extras on the rate desk** (`RateDesk.tsx`, the last-14-days `client_reply = approved` list, limit 40). The columns used are id, names, amounts, rate, `approved_rate`, and note. They do not include `went_through`, `outcome`, or `loss_open`. `closedIds` still reads `request_outcomes` for those ids and still removes a written, paid, matched, or lost row. The Phase 1 15-second full check still runs `closedIds`. This does not lengthen the wait for a waiting-list row that only outcomes can close.

## Reads that stay on `request_outcomes`

| Read | Why it stays |
|---|---|
| Treasury today list | The status pill uses `went_through`, `outcome`, and `loss_open`, which include payment matching. The seven slices become one function that still selects this view. |
| `closedIds` and “hide earlier deals” | A waiting card leaves when outcomes says it closed, including a payment match. Unchanged, including the Phase 1 rule that the 3-second check skips this when the card text is unchanged, and the 15-second reload still runs it. |
| KAM “went through today”, and older still-asking rows that already went through | Payment matching stays inside `request_outcomes`. The open-card load asks only for those ids (`request_went_through_ids`), on the same 10-second load, before paint. It does not `select('*')` the outcomes view. |
| KAM history, admin/manager history | Needs `went_through` and `outcome`, including imports. Still not reloaded on every quote (Phase 1). |
| Admin/manager “client approved” list | Stays. It is not the open-card poll. |
| Lost requests, header loss badge, header follow-up badge | Need `loss_open`, `went_through`, or `outcome`. |
| Quoted progress, desk history, follow-ups, request log | History and loss screens. |
| `treasury_queue`, `treasury_quotes_today`, `treasury_client_replies` | Unchanged RPCs. |

## Today list — old predicates and the new OR

`loadDeskDay` in `RateDesk.tsx` (before this change) ran these queries and merged by `id`. Each had `.limit(1000)`. Slices 1–7 also had `.eq('source', 'app')`. Slice 8 did not. `start` is `tbilisiDayStart(today)`, midnight in Asia/Tbilisi as a UTC instant. There is no upper bound on the `gte` slices. After the merge, the screen still keeps only rows for which `onDeskToday` is true (Tbilisi calendar day).

| # | Predicate |
|---|---|
| 1 | `source = app` and `request_date = today` |
| 2 | `source = app` and `quoted_at >= start` |
| 3 | `source = app` and `asked_at >= start` |
| 4 | `source = app` and `client_replied_at >= start` |
| 5 | `source = app` and `rate_written_at >= start` |
| 6 | `source = app` and `rate_valid_until >= start` |
| 7 | `source = app` and `loss_reason_at >= start` |
| 8 | `id` in the quote ids passed in, any source, only when that list is non-empty |

`requested_at` is not its own query. The comment on the screen treats `request_date` as that day. `onDeskToday` still checks `requested_at` after the row has been fetched by something else. The new function does not add a `requested_at` predicate, so it does not pull rows the old slices would have skipped.

`public.desk_day_rows(p_today, p_start, p_also_ids)` is that same OR, one `select`, deduped because it is one statement rather than a union of overlapping slices:

```sql
id = any (p_also_ids)
or (
  source = 'app'
  and (
    request_date = p_today
    or quoted_at >= p_start
    or asked_at >= p_start
    or client_replied_at >= p_start
    or rate_written_at >= p_start
    or rate_valid_until >= p_start
    or loss_reason_at >= p_start
  )
)
```

There is no `LIMIT`. A cap on the combined set could omit a row one of the old slices still returned. `p_start` is the same `tbilisiDayStart(today)` string the slices used. The client still applies `onDeskToday`, so a timestamp after today’s Tbilisi midnight that the `gte` arm returns is still dropped on screen, as it was when that slice returned it. A row that matches several arms is returned once. No `ORDER BY`.

If `desk_day_rows` is not in the database yet, the client uses the seven slices again. If the function exists and this call fails, that one refresh uses the slices once. It does not retry the function. A second refresh does not start a second slice batch while one is in flight. The failure is one `console.error` until a later call succeeds. It is not a toast. The slice fallback still has the old per-slice cap of 1000. The success path does not.

## Queries removed and added

Removed from the hot path:

- Seven (or eight) parallel `request_outcomes` selects in `loadDeskDay`, replaced by one `desk_day_rows` call when that function exists.
- KAM open-card `request_outcomes` `select('*')` on the 10-second / Realtime poll, replaced by `request_active`.
- The 14-day approved extras select on `request_outcomes`, replaced by `request_active` when that view exists.

Added:

- `request_active` for KAM open cards and for the extras list.
- `desk_day_rows` for today’s desk.
- `request_went_through_ids` on the open-card load, returning only ids. If that function is not pasted yet, one `select id` on `request_outcomes` for those ids where `went_through` is true. Not `select('*')`.

Unchanged queries: `treasury_queue`, `closedIds`, hide-earlier-deals, history, the approved admin list, lost requests, header badges, quote progress, desk history, follow-ups, the log.

## SQL files (not applied)

| File | What |
|---|---|
| `supabase/setup/33_active_reads.sql` | View `request_active`, function `desk_day_rows` (no row cap), and function `request_went_through_ids`. Paste this only after you approve it. Copy it from disk. Do not re-paste older setup files over it. |
| `supabase/migrations/20261013120000_active_reads.sql` | Same statements as the setup file, timestamped after `20261012130000`. |
| `supabase/migrations/20261013140100_desk_day_indexes.sql` | Indexes only. Do not apply inside a transaction. See below. |

Until `33_active_reads.sql` is pasted, the client keeps the previous reads (the missing view or function is detected and the old query runs). Pasting it is what turns the cheaper path on. Do not paste it until you approve it. Do not paste the index file in the same step unless you also want the indexes, and do not paste the index file inside a transaction.

## Screens

| Screen | Change |
|---|---|
| Rate desk, today’s deals | One server read of `request_outcomes` instead of seven slices, with no combined row cap. Same inclusion OR, then `onDeskToday`. If that call fails, that refresh uses the slices once. Status pills still use payment matching. |
| Rate desk, waiting list | Unchanged. `treasury_queue` and `closedIds` unchanged. |
| Rate desk, older approved extras | Read `request_active`. `closedIds` still applies. |
| KAM requests, open cards | Read `request_active`, then stamp ids that `request_went_through_ids` says already went through, before paint. Same KAM and same today-or-asking filter. |
| KAM requests, went through today | Those stamped ids, plus a written rate or `payment_confirmed_at` on the active row. No separate `select('*')` of outcomes on a 60-second timer. |
| KAM / admin history, approved list | Unchanged. |
| Lost requests, header badges | Unchanged. |

## Indexes

No `EXPLAIN` was run. There is no copy of production data in this workspace, and these files were not applied. Nothing below is a measured plan. Postgres may still sequential-scan. Existing indexes were searched in `supabase/migrations` and `supabase/setup`.

The new shapes that can use an index:

- `desk_day_rows`: `source = 'app'` and one of `request_date = today`, `quoted_at >= start`, `asked_at >= start`, `client_replied_at >= start`, `rate_written_at >= start`, `rate_valid_until >= start`, `loss_reason_at >= start`, or a primary-key `id = any(...)`.
- KAM open cards: `kam_id = me` and (`request_date = today` or `quote_status = 'asking'`).
- Extras: `source = 'app'`, `client_reply = 'approved'`, `request_date >= today-14`, limit 40.

| Proposed index | Query arm | Already covered? | Benefit | Write / storage | Created? |
|---|---|---|---|---|---|
| `requests_app_quoted_at_idx` on `(quoted_at)` where `source = 'app'` and `quoted_at` is not null | Desk OR, `quoted_at >= start` | No index on `quoted_at` | Range scan for quotes since Tbilisi midnight, if the planner bitmap-ORs the arms | One entry per app row that has been quoted. A quote updates this index. | Yes, in the index migration. Not applied. |
| `requests_app_asked_at_idx` on `(asked_at)` where `source = 'app'` and `asked_at` is not null | Desk OR, `asked_at >= start` for every status | `requests_asking_idx` is only `where quote_status = 'asking'`. It does not serve this arm. Left in place for `treasury_queue`. | Same kind of range scan for every ask since midnight | One entry per app ask. Ask-again updates it. | Yes. Not applied. |
| `requests_app_client_replied_at_idx` on `(client_replied_at)` where `source = 'app'` and `client_replied_at` is not null | Desk OR, `client_replied_at >= start` | `requests_better_open_idx` is only open better-rate rows. It does not serve this arm. Left in place. | Range scan for replies since midnight | One entry per app reply. | Yes. Not applied. |
| `requests_app_rate_written_at_idx` on `(rate_written_at)` where `source = 'app'` and `rate_written_at` is not null | Desk OR, `rate_written_at >= start` | None | Range scan for rates written since midnight | One entry per written app rate. | Yes. Not applied. |
| `requests_app_rate_valid_until_idx` on `(rate_valid_until)` where `source = 'app'` and `rate_valid_until` is not null | Desk OR, `rate_valid_until >= start` | None | Range scan for rates whose validity instant is still at or after midnight | One entry per quoted validity. A new quote updates it. | Yes. Not applied. |
| `requests_app_loss_reason_at_idx` on `(loss_reason_at)` where `source = 'app'` and `loss_reason_at` is not null | Desk OR, `loss_reason_at >= start` | `requests_loss_approval_idx` is `(request_date desc)` where the loss is still unapproved and unwritten. It does not serve `loss_reason_at`. | Range scan for losses marked since midnight | One entry per app loss reason time. | Yes. Not applied. |
| `(source, request_date)` or partial `(request_date) where source = 'app'` | Desk OR, `request_date = today` and `source = 'app'` | `requests_date_idx` on `(request_date)` already exists, and `requests_kam_date_idx` / `requests_client_date_idx` too | Would only help if filtering `source` after the date index is expensive. No row counts, no plan. | Extra index on every app insert | **Not created.** The date index already matches the equality. |
| KAM `(kam_id, request_date)` plus asking | Open cards | `requests_kam_date_idx` and `requests_asking_idx` | The two arms of the existing OR already have indexes | — | **Not created.** |
| Approved extras on `client_reply` | 14-day approved list, limit 40 | `requests_date_idx` can range-scan the 14 days | Limit 40 on a date range the date index already supports | — | **Not created.** |

An OR of seven predicates often becomes a bitmap OR or a sequential scan. These indexes are the ones that can support the arms that had no index. They do not change RLS or any workflow. They do cost space and a bit of write time on `requests` when the matching column changes.

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction. Supabase’s migration runner and a SQL editor that wraps the whole paste in `BEGIN`/`COMMIT` will reject it. Apply `supabase/migrations/20261013140100_desk_day_indexes.sql` only if you want the indexes, only after you approve them, and only outside a transaction: paste **one** `CREATE INDEX` statement at a time into the SQL editor, with no `BEGIN`. If a statement fails with “cannot run inside a transaction block”, that paste was wrapped. Run that statement alone. If an earlier attempt left an index marked `INVALID`, drop that index and create it again. Do not paste this file in the same transaction as `33_active_reads.sql`.

## Workflow checks (no live database)

There are no Supabase keys here, and nothing was applied, so these predicates were not executed against Postgres. `scripts/check-phase2.ts` checks the pure functions the client uses, and checks that the SQL text is the OR above, is security invoker, does not read `transactions` in the new view, and does not replace `request_outcomes`. Results are filled in after the script runs.

What the pure checks cover:

1. New request waiting for treasury — in the desk OR and on the desk today; on the KAM open list.
2. Treasury quote — `quoted_at` keeps it in the OR.
3. KAM accepts — `client_replied_at` keeps it in the OR; still open.
4. Better rate requested — still open; not treated as a finished loss while treasury has not answered.
5. Treasury answers the better rate — still in the OR.
6. Rate written — leaves the open list and appears in “went through today” from the request columns alone.
7. Successful payment — `payment_confirmed_at` does the same without a transaction lookup. A match that exists only on `transactions` is an open loss if the active row is painted before the outcomes id is applied. `applyMatchedSuccess` clears `loss_open` and sets `went_through` before the cards render, so that row leaves the open list and appears in “went through today”. An older asking row that matches leaves the open list and is not “went through today”.
8. Marked lost — stays on the open list; pending loss from the reason, without a payment lookup.
9. Loss waiting for approval — `loss_open`, not approved; still open for the KAM; the lost-page filters in `LostRequests.tsx` are unchanged (`loss_approved_at` is null, `went_through` is false).
10. Loss approved — not a pending loss; still on the KAM open list if it did not go through (same as `!went_through` today); the lost action list requires `loss_approved_at` is null, so an approved loss is not on that list.
11. Admin and manager — `can_see_all` sees every row.
12. Treasury — `is_treasury` sees every row, same as `requests_read`.
13. KAM — only `kam_id` of that KAM. A second KAM’s id is rejected.
14. Analyst — no rows.

A row that matches several today-arms is counted once. A `quoted_at` after the next Tbilisi midnight is in the SQL OR (no upper bound, same as `.gte`) and is removed by `onDeskToday`.

## Business rules not changed

Quote, decline, better-rate, mark-written, and client-reply RPCs and their argument names. `log_request` argument names. Written-rate success, payment confirmation, loss approval, and the rule that a written rate cannot be deleted. Who can see, quote, write, or approve. Georgian treasury wording (ხაზინა / ხაზინის / ხაზინას). `LoadingLine`.

## Known risks

- Until `33_active_reads.sql` is pasted, the client uses the previous queries. The cheaper path does not run. Paste only after approval, from the file on disk, before users depend on a deployed build of this client. After pasting, if the API still reports the function missing, reload the API schema cache.
- If `request_went_through_ids` and the narrow `select id` both fail, the open cards keep the last reconciled list. The first load stays empty until a later 10-second poll can answer. The cards are not painted as a loss in that gap. Written rates and confirmed payments still come from the active row when the id call succeeds.
- The success path of `desk_day_rows` returns every row the OR matches, including timestamps after the next Tbilisi midnight that `onDeskToday` then drops. That payload can be larger than one calendar day. It does not omit a row the old merge kept. The slice fallback, used only when the function is missing or that call fails, still caps each slice at 1000.
- `loss_open` on an active row ignores payment matching until the id stamp in the same load. The stamp runs before `setRows`. A matched row is not shown as a loss.
- KAM names on `request_active` follow `profiles_read`, same as `request_outcomes`. This does not fix a null name for treasury.
- Indexes were not planned with `EXPLAIN`. The planner may ignore them. They still add write cost if created.
- No production click-through. Login and live Supabase were not available.

## Manual steps that still need your approval

Do not paste anything until you say so.

1. When you want the cheaper reads, copy `supabase/setup/33_active_reads.sql` from disk into the Supabase SQL editor and run it. It creates `public.request_active`, `public.desk_day_rows(date, timestamptz, bigint[])`, and `public.request_went_through_ids(bigint[])`. It is safe to run again. It does not drop or edit `request_outcomes`. It does not change `analyst_deals` or `request_rate_names`. It does not create indexes.
2. Only if you also want the indexes: run each statement in `supabase/migrations/20261013140100_desk_day_indexes.sql` **by itself**, outside a transaction. Do not paste that file inside `BEGIN`/`COMMIT`, and do not rely on a migration runner that wraps SQL in a transaction (`CREATE INDEX CONCURRENTLY` will fail there).
3. Do not deploy this client until step 1 is in the database if you want the cheaper path on the first request. Before step 1, this client still runs the old reads.

## Checks

No live database. `scripts/check-phase2.ts` passed (`phase 2 checks passed (2026-10-13, start 2026-10-12T20:00:00.000Z)`). It checks the inclusion OR, dedupe, the next-midnight drop, no combined row cap, the id reconciliation function, the quiet slice fallback, the 14 workflow states (including a payment match that would look like a loss until the id stamp), KAM / treasury / admin / manager / analyst visibility, and that the new SQL does not replace `request_outcomes` or redefine the business RPCs.

`npx tsc --noEmit` succeeded. `npm run build` succeeded (`dist/assets/index-D2jPnMsd.js`). Nothing was committed, pushed, deployed, or applied to a database. No database SQL was executed. The index migration was not edited and was not applied.
