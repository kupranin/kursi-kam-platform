# Stage 1 — request workflow changes

Local only. Nothing in this change was committed, pushed, deployed, or applied to a database. No production row was updated. No table or function was dropped.

The two-choice “write the rate / hold the rate” workflow is **not deployable** until `supabase/setup/43_defer_rate_write.sql` is approved and pasted. Until that column exists, the screen keeps today’s single approve path.

## What shipped in the working tree

### A. KAM analytics

`/analytics` now branches on the viewed role.

- A KAM sees only their own requests: total, open, successful, lost, loss reasons, and request-derived GEL. The month filter is the same 18-month list plus “whole period”.
- The page reads `request_outcomes` with `.eq('kam_id', profile.id)`. It does not call `analyst_deals` or `analytics_response_times`. A KAM is not added to `analyst_deals`. RLS is unchanged. The extra `kam_id` filter also keeps an admin “view as KAM” session from loading the company.
- GEL is summed on success only. Success is the outcome view’s `went_through` / `outcome = went_through` (written rate, payment mark, transaction hit, or legacy file win — the existing rule, not a new one). The amount is `requests.gel_amount` when an admin has typed one, otherwise the same branches as `private.request_gel`: GEL side if present; RUB only when the rate is below 1; USD/EUR only when the rate is between 1 and 10; other currencies use amount × rate; a cross with no GEL side, or an unusable rate, adds nothing. Blank GEL adds nothing. Nothing is multiplied by 84.7.
- The KAM cards are labeled separately: total, open, **გავიდა / Went through** (existing outcome rule), **დაკარგული / Lost**, **მოთხოვნის ლარი / Request lari**, and **დადასტურებული საბანკო ბრუნვა / Confirmed bank turnover** with the value **—** and the text **ჯერ არ არის**. A written rate is not described as a completed bank payment. Who can see the company report is unchanged.
- Admin, manager, and analyst still use `analyst_deals` and, for response times, `analytics_response_times`. Their each-KAM table and treasury-time card stay. Their GEL card stays labeled **ბრუნვა GEL**, with the existing note that it is request lari, not bank-file turnover. Bank KPI cards and the upload control are gone for everyone on this page.
- Desktop nav for a KAM includes Analytics after My numbers. Phone nav and More do not. `/analytics` on a phone still shows the desktop-only gate. No analytics tab was added to the phone.

### B. Transaction upload and management UI that was hidden

Removed from the screens people open:

- Analytics bank-file upload (`import_transactions`, `finish_transaction_upload`, `readTransactionFile`) and the `analytics_kpis` turnover cards.
- Admin “data sync” nav item and `SyncPanel` (`admin_sync_status`, `admin_sync_now`). The component file remains on disk and is not mounted.
- Layout banner that called `data_freshness` to say transactions were updated or not synced.
- Team page bank turnover, income, failed-turnover bars, biggest-failed card, and the winback count that came from successful transactions. The scorecard now shows clients and “requests that went through”, labeled as request outcomes. The CSV is client id, name, KAM, and requests in the period.

`src/lib/transactionFile.ts` remains on disk and is no longer imported by Analytics.

Success and loss math were not changed. `request_outcomes` and `analyst_deals` were not rewritten.

### C. Hold a client approval off the treasury write queue

A treasury quote does not start an acceptance countdown. The 5/15/30 minute chooser stays off the quote form. `treasury_quote` keeps its signature and ignores `p_valid_minutes`. A new quote stores `rate_valid_until` null. Old values are not rewritten. `kam_client_reply` no longer refuses because that column, or `rules.default_quote_minutes`, has passed. The client may accept more than 15 minutes after the quote. Once the client accepts, the rate is agreed. Deferring execution does not invalidate it, and treasury is not asked to reconfirm because time has passed.

After the KAM confirms the client accepted the rate, and only when the new column can be read:

1. **გაწერეთ კურსი** — existing `kam_client_reply`. Approval is saved. `rate_write_deferred` stays false. The row goes to the treasury write queue, as today.
2. **ჯერ არ გაწეროთ კურსი** — `kam_defer_rate_write`. The same approval and approved rate are saved, and `rate_write_deferred` is set true. Treasury’s write queue, waiting queue, better-rate queue, and the approval inbox do not see it.

The held row keeps the original quote, the approved rate, and `client_replied_at`. That timestamp is set once when the client accepts. `edit_request` does not write it, and the authenticated guard refuses a direct change. `ask_again` refuses an approved reply, so it does not clear it. There is no separate `accepted_at`. The 24-hour hold is that timestamp plus 24 hours. The held row stays on the owning KAM’s open list after reload and on later dates. The read filters `kam_id` to that KAM and pages until the list ends. There is no 200-row cap. RLS still applies, so another KAM’s held rows are not returned. Status text is **კლიენტმა დაადასტურა — გაწერას ელოდება**. The desktop row and the phone card show elapsed time and the deadline.

Within 24 hours, **გაწერეთ კურსი** calls `kam_release_rate_write` and sends the agreed deal. It does not rewrite the rate and it does not ask treasury to reconfirm. After 24 hours the owning KAM cannot release. The deal appears on the desktop rate desk and the treasury phone desk under **დასახური გარიგებები — ხაზინის დასტური**. Treasury or an admin approves closing, which moves the same rate into the ordinary write queue and records who and when. That does not set `rate_written_at`, does not mark a payment, does not mark the request lost, and does not change the price. Writing the rate is still the separate **კურსი გაწერილია** action. If closing cannot be approved, treasury records a reason of 2–500 characters, who, and when. That first exception is not overwritten. The row stays in that queue until treasury or an admin later approves closing. That later approval keeps the original reason, actor, and timestamp, clears only the hold, and moves the same rate into the ordinary write queue. It does not set `rate_written_at`, does not mark a payment, does not mark the request lost, and does not change the price. One inbox row and one `private.emit` per actual transition. A second approve after the row has moved does not notify again.

Passing 24 hours does not by itself cancel the request, mark it lost, change the rate, or write it. The overdue state is computed in SQL whenever the closing queue is read: held, approved, not released, not written, not paid, not lost, and `client_replied_at + 24 hours < now()`. That read does not use `closing_overdue_notified_at`. A failed notice does not hide the deal, and the list does not wait for a scheduled status change. `pg_cron` is already used in this project. The paste schedules `kam-closing-overdue` every minute to call `private.notify_closing_overdue()`. That function only sends the one treasury notice. If the notice fails, its timestamp rolls back and the next minute retries. If the paste warns that `pg_cron` is not available, a dashboard schedule of `select private.notify_closing_overdue();` every minute is required for the notice. The queue itself does not need that job.

The KAM can still edit the permitted comment through `edit_request`.

If the column select fails, the two buttons are not shown and the single Send button calls `kam_client_reply`. Replies do not break when setup 43 has not been pasted.

This is not payment success and not a written rate. `rate_written_at` is still the mark that the deal went through and cannot be deleted.

The quote form does not ask treasury to pick 5, 15, or 30 minutes, and the call does not pass `p_valid_minutes`. The toast does not say the quote expires. `treasury_quote` still has that argument and ignores it. A new quote does not store an acceptance deadline.

Thirty minutes of the written rate starts at `rate_written_at`. The screen says **კურსი გაწერიდან 30 წუთი მოქმედებს** and shows that deadline on the treasury write screen, the desk day row, history, and the KAM card. Passing those 30 minutes does not cancel, lose, or change the rate. No existing product rule does that, and none was added.

### D. Special bank-rate reference

The checkbox **კლიენტს აქვს ბანკის სპეციალური კურსი** is unchanged. When it is on, a reference block appears under it.

- **Valuto** is confirmed in `supabase/functions/fetch-market-rates/index.ts` (`valuto()`). It GETs `https://valuto.ge/wp-json/rest-currency-list/v3/currencies` and stores `source = valuto`, `venue = Valuto`, `venue_kind = board`, buy/sell from `buy` / `sell` and the pair from `CcFrom` / `CcTo`. That is the public currency list, not an individually negotiated TBC special rate. The checkbox shows that stored quote only when one exists from the last two days for the pair, labeled as a provider public board. It does not write `client_special_rates` and it is not the client’s negotiated TBC rate.
- **Express Online** has no source, venue, URL, buy/sell map, currency list, freshness rule, or failure mode in that function. The block always says the rate is unavailable and the feed is not connected. `expresslombard` / “Express Lombard” (`https://expresslombard.ge/api/currencies/get-currencies`) is a different provider and is not used. No price is invented. No scraper was added.

Client negotiated terms stay in `client_special_rates`. Blank fields are still not sent, so stored values are not wiped. This is not `log_request`’s `p_bank`. Treasury still sees the client-reported special terms on the request.

## Files changed

New:

- `src/lib/deferWrite.ts` — column probe, held-row detection, open-list merge, comment save
- `src/lib/requestGel.ts` — client port of `private.request_gel`
- `src/components/DeferWriteBar.tsx` — held status, 24-hour clock from `client_replied_at`, release button, comment
- `supabase/setup/43_defer_rate_write.sql` — paste file, not applied
- `supabase/migrations/20261016180000_defer_rate_write.sql` — the same statements, not applied
- this file and `CLICKHOUSE_TRANSACTIONS_STAGE2_DESIGN.md`

Edited:

- `src/pages/Analytics.tsx`, `src/lib/kamBreakdown.ts`, `src/lib/nav.ts`
- `src/pages/Requests.tsx`, `src/components/mobile/KamRequestDetail.tsx`, `src/components/mobile/kamLoad.ts`, `src/components/mobile/kamBuckets.ts`
- `src/pages/RateDesk.tsx`, `src/components/mobile/treasuryLoad.ts`, `src/components/Layout.tsx`
- `src/pages/Team.tsx`, `src/pages/admin/Admin.tsx`
- `src/components/ClientSpecialTerms.tsx`, `src/components/VenuePairLine.tsx`, `src/components/mobile/KamNewRequest.tsx`
- `src/lib/types.ts`, `src/styles.css`

Not edited, and not reverted: KAM phone, treasury phone desk, KAM search, `/competitiveness`, and client special rates (`42_client_special_rates.sql`, commit `1d46b92`).

## Defer-write state machine

`requests.rate_write_deferred boolean not null default false`.

There is no backfill. Every existing approval stays false, which means “already on the treasury write queue”. Only a new hold sets the flag.

| State | Flag | Who sees it |
| --- | --- | --- |
| Not yet answered | false, `client_reply` null | KAM open list, treasury quote queue as today |
| Approved and sent | false, `client_reply = approved` | Treasury write queue and approval inbox |
| Approved and held | true, `client_reply = approved`, `rate_written_at` null, `closing_approved_at` null | KAM open list only while `client_replied_at` plus 24 hours is still in the future. Not the write queue, not waiting, not better-rate, not the approval inbox. The agreed rate stays. |
| Overdue hold | same, and `client_replied_at + 24 hours < now()` | Treasury closing queue **დასახური გარიგებები — ხაზინის დასტური**. The owning KAM cannot release. Rate, reply, and `rate_written_at` stay. |
| Closing approved | flag set back to false, `closing_approved_at` set | Ordinary write queue at the same rate, including when a first exception is already stored. Those exception columns stay. Not written, not paid, not lost. The row leaves the closing queue. |
| Closing exception | flag stays true, `closing_exception_at` set once | Stays in the closing queue with the original reason. Treasury or admin can later approve closing. A second exception does not overwrite the first and does not notify again. |
| Released by the owning KAM | flag set back to false once, only while the 24 hours have not passed | Same as “approved and sent”. Rate, approved rate, `rate_valid_until`, and `client_replied_at` are unchanged. |
| Written | `rate_written_at` set | Unchanged. Cannot be deleted. Not a bank transaction by itself |
| Payment mark or SUCCESS match | existing rules | Unchanged. Held release returns `unchanged` |

Guards:

- Defer uses the same checks as `kam_client_reply` except the old quote window: owning KAM, `can_write()`, source app, quoted, no reply yet, not written, not payment-confirmed, no SUCCESS transaction for that client on that day. `FOR UPDATE`. The update requires `client_reply is null`. A second defer raises. Neither defer nor `kam_client_reply` reads `rate_valid_until` or `rules.default_quote_minutes`.
- Release is the owning KAM only, and only while `client_replied_at + 24 hours >= now()`. `kam_id` must be the caller, the same rule as `kam_client_reply`. An admin is not given another KAM’s row. After 24 hours it raises and does not notify. Treasury releases only through `treasury_approve_closing`. If the row is not approved, it raises. If it is already written, payment-confirmed, or matched by a SUCCESS transaction, it returns `unchanged` and does not enter the queue. If the flag is already false, or closing is already approved or excepted, it returns `unchanged`. An explicit loss (`marked_lost_at`, `loss_approved_at`, or loss-reason text) raises and does not enter the queue. The update requires the flag, `rate_written_at` null, `client_reply = approved`, a quoted rate, and `quote_status = quoted`. It does not change `rate`, `approved_rate`, `rate_valid_until`, or `client_replied_at`. A second call returns `unchanged` and does not notify again.
- `ask_again` does not fit: it refuses an approved reply and clears the approval. `treasury_quote` does not fit: it requires `quote_status = 'asking'` and replaces the rate. Neither is called here. There is no treasury reconfirm step.
- `treasury_mark_rate_written` keeps its `(bigint)` signature. It refuses a held row. The update also requires the flag false and `rate_written_at` null.
- `treasury_set_rate` refuses an agreed deal that is not yet written, including after the hold is cleared by a KAM release or by closing approval. It does not change `requests.rate` or `quote_status` in that state. An unapproved quote can still be set or cleared. After `rate_written_at` is set, the existing correction remains: a new rate, or null, which also clears the written mark.
- `treasury_client_replies` keeps its signature. It excludes an approved row that is still deferred. A release whose `client_replied_at` is an earlier Tbilisi day is included when `deferred_released_at` is today, so an overnight hold can still reach the write queue. The desk and the phone queue also drop held ids client-side. `treasury_queue()` is still `quote_status = 'asking'` only, and the better-rate list is still `client_reply = 'better'`, so a held approval is in neither.
- The inbox trigger skips the treasury and manager notice when a new approval is deferred. The owning KAM’s release sends that same notice once. `client_reply` is already approved, so the “became approved” branch does not also fire. Release also emits `request.client_approved` once. Defer does not emit. Treasury closing approval sets `closing_approved_at` in the same update, so that trigger branch is suppressed. The approve function itself writes one inbox row to the owning KAM and emits `deal.closing_approved` once. An exception writes one inbox row to the owning KAM and emits `deal.closing_exception` once. The overdue job writes one treasury inbox row and emits `deal.closing_due` once, and stores `closing_overdue_notified_at` in the same subtransaction. If that notice fails, the timestamp rolls back and the next minute retries. The closing queue does not read that timestamp. Approve, exception, and KAM release keep the row change if the notice fails. That failure is a database warning only. It is not retried, because a later send would be a second notice after the transition already committed. A second press of the same decision still returns `unchanged` and does not notify.
- The 24-hour mark is `client_replied_at` plus 24 hours. Passing it does not cancel, lose, write, or change the rate. It only puts the unreleased hold on the closing queue and blocks KAM self-release. Direct-message “24 hours” and the Excel time fraction are different features.
- The desktop form and the phone detail use an in-flight lock so two clicks do not send twice. The database lock is the real guard.
- Search and role filters are unchanged. A KAM still sees only their own requests. `private.can_see_all()` is still admin and manager. The analyst still reads `analyst_deals` only.
- `log_request` argument names are unchanged.
- Views `request_outcomes`, `request_active`, and `analyst_deals` were not replaced, so success and loss semantics stay.

Freshness-only `loss_open` does not hide a hold. An explicit loss is not forced back onto the open list.

## SQL waiting for approval

Paste file: **`supabase/setup/43_defer_rate_write.sql`**

Matching migration, same body, also not applied: `supabase/migrations/20261016180000_defer_rate_write.sql`

Paste it only after it is approved, and only after `42_client_special_rates.sql`. Do not re-run `1_platform.sql`. It is idempotent. It does not drop tables. It does not use `CASCADE`. It drops and recreates `kam_release_rate_write(bigint)` and trigger `requests_guard_deferred_write`. If a previous paste created `treasury_reconfirm_deferred` or `treasury_reconfirm_queue`, it drops those functions and does not recreate them. A database that never had them is unchanged by `IF EXISTS`. It does not widen RLS. It does not add a KAM to `analyst_deals`.

What it does:

1. Adds `requests.rate_write_deferred` if missing, default false, with a comment. No update of old rows.
2. Adds `deferred_released_at` and `deferred_released_by` if missing. These record the release. The hold clock is `client_replied_at`. No backfill.
3. Creates `kam_defer_rate_write(p_request_id bigint, p_rate numeric)`. Owner-only. Sets `client_reply = approved`, `approved_rate`, `client_replied_at`, and the hold flag true. Does not check a quote window. Does not notify.
4. Drops and recreates `kam_release_rate_write(p_request_id bigint)` so the return stays text. The drop is not `CASCADE`. Nothing in the repo calls that signature from a view, trigger, or other function. It also drops and recreates trigger `requests_guard_deferred_write` only. That drop is not `CASCADE` and does not drop `requests_guard_update`.
5. Drops `treasury_reconfirm_deferred` and `treasury_reconfirm_queue` if present, every signature, without `CASCADE`. Does not recreate them. `treasury_queue()` is not replaced.
6. Replaces `private.inbox_on_request` from the current body, with the hold skip and the release notice. The release notice does not require `rate_valid_until` to still be in the future.
7. Replaces `treasury_client_replies` with the same signature, the held-row exclusion, and today’s `deferred_released_at` rows.
8. Replaces `treasury_mark_rate_written` with the same `(bigint)` signature so a held row cannot be marked written.
9. Replaces `treasury_set_rate` with the same `(bigint, numeric)` signature. An agreed rate that is not yet written cannot be edited or cleared, including after the hold flag is false. An unapproved quote still can. After `rate_written_at`, the existing correction remains.
10. Grants execute on the functions to `authenticated` and revokes them from `public` and `anon`.
11. Adds `private.guard_deferred_rate_write` (`search_path = ''`, security invoker). An `authenticated` update cannot change the hold columns, set `rate_written_at` on a held row, or change `rate`, `approved_rate`, `rate_valid_until`, `quote_status`, `client_reply`, or `client_replied_at` while the hold is set or while an agreed rate is not yet written. Security definer functions still pass, and they keep their own role checks.
12. Drops `rate_reconfirm_required`, `deferred_quote_expired`, `rate_reconfirmed_at`, and `rate_reconfirmed_by` if they exist. `IF EXISTS`. No `CASCADE`. If something outside this file still depends on one of them, the paste stops.
13. Replaces `kam_client_reply` with the same `(bigint, text, numeric, text)` signature. The body no longer refuses because `rate_valid_until` has passed. Authorization, `FOR UPDATE`, loss, payment, and role checks stay.
14. Replaces `treasury_quote` with the same `(bigint, numeric, int)` signature. `p_valid_minutes` is ignored. This quote stores `rate_valid_until` null and returns null. Other rows are not updated.
15. Replaces `treasury_answer_better` with the same signature. Accept and correct store `rate_valid_until` null. The ready notice does not name a validity time.
16. Replaces `private.notify_request_change` so the rate-ready text does not say “Valid until”.
17. Adds `closing_approved_at`, `closing_approved_by`, `closing_exception_at`, `closing_exception_by`, `closing_exception_reason`, and `closing_overdue_notified_at` if missing. No backfill. The reason check is null or 2–500 characters after trim.
18. Creates `treasury_closing_queue()`, `treasury_approve_closing(bigint)`, and `treasury_record_closing_exception(bigint, text)`. `treasury_queue()` is not replaced and its return type is unchanged.
19. Creates `private.notify_closing_overdue()` and, when `pg_cron` is available, schedules `kam-closing-overdue` every minute. If the paste warns, schedule `select private.notify_closing_overdue();` from the dashboard. The queue does not need that job to be visible.

`kam_client_reply` is replaced in this file. Its signature is not changed.

Until this file is pasted, the two-choice workflow is not deployable. The UI in this branch is safe to have present only because it hides the choice when the column is missing.

## Special-rate provider findings

| Reference | What exists |
| --- | --- |
| Valuto | Connected public board, not a negotiated TBC special rate. Function `valuto()` in `fetch-market-rates`. URL `https://valuto.ge/wp-json/rest-currency-list/v3/currencies`. Stored source `valuto`, venue `Valuto`, kind `board`. Buy and sell from `buy` / `sell`, pair from `CcFrom` / `CcTo`. Shown only from a stored row newer than two days, labeled as a provider public board. |
| Express Online | Not connected. No vendor confirmation, no feed URL, no buy/sell fields, no currency list, no freshness window, no failure path. The UI says the rate is unavailable and the feed is not connected. It is not labeled as a BOG special rate. |
| Express Lombard | Connected as a different board (`expresslombard`, venue “Express Lombard”, URL `https://expresslombard.ge/api/currencies/get-currencies`). Not used as the BOG special-rate reference. |

No live quote was read in this session. Whether a current Valuto row is stored in `market_rates` was not checked.

### Express Online integration plan

Do not connect it until these are confirmed from the vendor. No endpoint is invented here, and no scraper is added. `expresslombard` is a different provider and is not a substitute.

- Vendor: the legal name and that this feed is Express Online, not Express Lombard.
- Feed: the official URL or API, the authentication it requires, and the response shape.
- Buy/sell: which fields are the client buy and the client sell, and which side of the pair they apply to.
- Currencies: the currency list and how a cross rate is named.
- Freshness: how often the feed updates, and how old a stored row may be before the screen hides it.
- Failure: what the screen shows when the feed times out, returns an empty list, or returns a pair this request does not use.

## Legacy transaction dependencies that remain

These stay. None were dropped.

| Dependency | Why it stays |
| --- | --- |
| `public.transactions` and its RLS (`can_see_all` or `is_my_client`) | Historical payments. Outcome math and loss blocking still read them. |
| SUCCESS match inside `43_defer_rate_write.sql` | Kept. Defer raises and release returns `unchanged` when `transactions` has the same `client_id`, the same `tx_date` as `request_date`, `payment_status = 'SUCCESS'`, and either `source = 'import'` or `tx_time >= requested_at - interval '1 minute'`. Same predicate as `kam_client_reply`. It does not change `request_outcomes`, success, or loss. |
| `request_outcomes.tx_hit` | SUCCESS on the same client and Tbilisi date (or `matched_request_id`) still counts as went-through. Changing that would change success and loss. |
| `file_won` / legacy agreement status | Same outcome view. Unchanged. |
| Loss approval blocked when a rate is written or a SUCCESS row matches | Existing financial rule. The loss screen still uses it. |
| `payment_confirmed_at` and the “ტრანზაქცია გავიდა” button | A KAM mark on the request. It does not require a bank file. It is not the broken upload. Follow-ups still uses it to take a request off the list. |
| `data_freshness` / `private.freshness_date()` | Still called from request loads. It decides when an unanswered request can become a freshness loss. The layout “synced / not synced” banner was removed. The function stays. |
| `kam_month_summary` and `month_portfolio` | Still called by Team for client counts and requests-in-period. They still compute `abs_gel + cross_gel` and `total_income` inside the database. The page no longer shows those fields. The functions were not altered. |
| `winback_list` | Still called by Follow-ups. A client leaves that book when a successful transaction exists, which is the existing product rule. Team no longer shows the winback count. |
| `analytics_kpis`, `import_transactions`, `finish_transaction_upload` | SQL remains. The Analytics page no longer calls them. |
| `admin_sync_status`, `admin_sync_now` | SQL remains. Admin no longer mounts `SyncPanel`. |
| `matched_request_id` on transactions | Still an optional link used by `tx_hit`. Not used by the month turnover total (that total ignores it on purpose). |
| Month turnover SQL (`20261009150000_analytics_count.sql`) | Still the rule for any future bank total: Tbilisi month of the payment, same `tx_id` once, a row with no `tx_id` still once, a previous-month payment stays out. The card that displayed it was hidden because the upload does not work. |

## Deployment order

1. Approve `supabase/setup/43_defer_rate_write.sql`. Do not paste it before that.
2. Paste it after `42_client_special_rates.sql`. Do not re-run `1_platform.sql`. The paste drops and recreates `kam_release_rate_write(bigint)` and trigger `requests_guard_deferred_write`. It also drops `treasury_reconfirm_deferred` and `treasury_reconfirm_queue` if a previous paste created them, and the four reconfirm-only columns if they exist. Do not drop anything else. Do not use `CASCADE`.
3. Only then is the two-choice workflow deployable. Shipping the frontend earlier does not break replies: the choice stays hidden and `kam_client_reply` remains the only approve path.
4. Do not treat a client approval, a held approval, or a written rate as a confirmed bank transaction. Those labels stay on `payment_confirmed_at` and a SUCCESS match.
5. Stage 2 is a design document only. Do not create a ClickHouse table, sync, or credential as part of this release.

## What was verified, and what was not

`npx tsc --noEmit` passed. `npm run build` passed (`tsc --noEmit && vite build`).

Live tests were not run. This workspace has no Supabase keys, so the app cannot sign in. ClickHouse is not connected. Setup 43 was not applied. No role was logged in.

Not verified against a database or a browser session:

- KAM analytics numbers, empty states, and the month filter
- Admin, manager, and analyst analytics still matching `analyst_deals`
- A KAM being refused `analyst_deals` and `analytics_response_times`
- Upload and sync controls absent after login
- Team cards and the follow-up book
- The two-choice path, reload, re-login, double submit, a release after an old stored `rate_valid_until`, the 24-hour closing queue, and loss blocking
- An old approval staying on the treasury queue (flag default false)
- Treasury phone and desktop queues hiding a held row
- Search and “view as” isolation
- Valuto appearing only when a stored quote exists
- The Express Online unavailable sentence next to saved client terms
- Desktop and phone layouts of the new bars

Those need a database where 43 has been pasted, and a signed-in KAM, treasury user, and admin.

## Production review notes

Checked against the SQL files. The SQL was not applied. There is no quote-acceptance countdown and no reconfirmation queue. `client_replied_at` is the 24-hour hold clock. The written-rate note is 30 minutes from `rate_written_at`, display only, and does not reuse `rate_valid_until`.

An ordinary approval (`kam_client_reply`, flag left false) does not require `rate_valid_until` to still be in the future. `treasury_client_replies` keeps it for the Tbilisi day of `client_replied_at`, and `treasury_mark_rate_written` does not read `rate_valid_until`. Writing the rate sets `rate_written_at` and does not change the price, the payment mark, or the loss mark. Thirty minutes after that timestamp the note shows the period has passed. Nothing in this paste cancels the deal, changes the rate, marks it lost, or marks a bank transaction completed because those 30 minutes passed.

Release writes the same notice a normal approval writes: one `private.emit` call, which inserts one `notification_events` row per enabled audience (treasury and manager), and the inbox trigger writes one `user_notifications` row for treasury and one for managers. The trigger’s “reply became approved” branch does not also fire, because `client_reply` was already approved. A second press returns `unchanged` and adds no second notice.

`treasury_set_rate` raises on an agreed deal that is not yet written, including a hold, a released hold, and a closing approval, before it can clear `requests.rate` or set `quote_status` to `asking`. The authenticated guard refuses that same direct change. An unapproved quote can still be edited. After `rate_written_at`, the existing correction remains. The guard also refuses a direct change of the closing columns. The database owner can still change columns outside the `authenticated` role. Passing 24 hours does not by itself lose or write the deal. The closing queue is that overdue row. It does not depend on `closing_overdue_notified_at`. Treasury or an admin may approve closing, or record one exception and later approve closing. The later approval keeps the first exception and takes the deal off the closing queue.

## Manual test matrix

Do not run these on production. Do not create test rows. Each check needs a database where setup 43 has been pasted, and a signed-in owning KAM plus a treasury user.

| Check | What to look at |
| --- | --- |
| Accept after 15 minutes | Treasury quoted earlier and stored no acceptance deadline, or an old `rate_valid_until` is already past. The client still approves. `kam_client_reply` saves the agreed rate. |
| Immediate write | Owning KAM. **გაწერეთ კურსი** uses `kam_client_reply`. The row is on today’s write queue. Treasury and managers get one approval notice per channel. |
| Hold | **ჯერ არ გაწეროთ კურსი**. Approval, original rate, and `client_replied_at` stay. The row is on the owning KAM’s open list and off the write, waiting, and better-rate queues. |
| Release after an old quote deadline | Same hold after a stored `rate_valid_until` has passed, and still inside 24 hours of `client_replied_at`. Returns `released`. Both rates and the old validity stay. The row is on the write queue. No reconfirm list. A second press returns `unchanged` and does not add a second notice. |
| Written-rate clock | **კურსი გაწერილია** sets `rate_written_at`. The note says **კურსი გაწერიდან 30 წუთი მოქმედებს** and the deadline is that timestamp plus 30 minutes. After 30 minutes the note expires on screen. The rate, loss, and payment marks stay. |
| 24-hour closing | An unreleased hold whose `client_replied_at` is more than 24 hours ago appears in **დასახური გარიგებები — ხაზინის დასტური** even if the overdue notice failed. The KAM release button is gone. Approve moves it to the ordinary write queue at the same rate and does not set `rate_written_at`. An exception stays visible with the original reason, and **დახურვის დასტური** still moves that same rate to the write queue without erasing the exception. The row then leaves the closing list. A second approve returns `unchanged` and does not notify again. |
| Duplicate clicks | Two presses of release. The second does not send a second approval notice or a second write-queue entry. |
| Held requests after reload | After defer, reload the KAM open list. The hold is still there, on later dates too. Status stays **კლიენტმა დაადასტურა — გაწერას ელოდება**. |
| KAM isolation | Another KAM does not see the hold and `kam_release_rate_write` raises. A direct update of `rate_write_deferred` raises. An admin who is not the owning KAM cannot release. |
| Treasury queue exclusion | A held row is absent from `treasury_queue`, from “rate to write” on the desk and the phone, and from the header count. `treasury_mark_rate_written` raises. `treasury_set_rate` raises and the row stays `quoted`. |
| Loss | An explicit loss cannot be released onto the write queue. |
| Payment | A payment mark or a SUCCESS transaction on that client and request date blocks defer and returns `unchanged` on release. Success and loss labels are unchanged. |
| Notification failure | If the notice insert fails, the release, the exception, and the closing approval still complete. The warning is `notification skipped`. The row is not rolled back, and that notice is not sent again on the next press. The closing queue still shows an overdue hold when the overdue notice fails. |
