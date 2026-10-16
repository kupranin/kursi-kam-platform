# Stage 1 — request workflow changes

Local only. Nothing in this change was committed, pushed, deployed, or applied to a database. No production row was updated. No table or function was dropped.

The two-choice “write the rate / hold the rate” workflow is **not deployable** until `supabase/setup/43_defer_rate_write.sql` is approved and pasted. Until that column exists, the screen keeps today’s single approve path.

## What shipped in the working tree

### A. KAM analytics

`/analytics` now branches on the viewed role.

- A KAM sees only their own requests: total, open, successful, lost, loss reasons, and request-derived GEL. The month filter is the same 18-month list plus “whole period”.
- The page reads `request_outcomes` with `.eq('kam_id', profile.id)`. It does not call `analyst_deals` or `analytics_response_times`. A KAM is not added to `analyst_deals`. RLS is unchanged. The extra `kam_id` filter also keeps an admin “view as KAM” session from loading the company.
- GEL is summed on success only. Success is the outcome view’s `went_through` / `outcome = went_through` (written rate, payment mark, transaction hit, or legacy file win — the existing rule, not a new one). The amount is `requests.gel_amount` when an admin has typed one, otherwise the same branches as `private.request_gel`: GEL side if present; RUB only when the rate is below 1; USD/EUR only when the rate is between 1 and 10; other currencies use amount × rate; a cross with no GEL side, or an unusable rate, adds nothing. Blank GEL adds nothing. Nothing is multiplied by 84.7.
- The KAM label is **მოთხოვნის ლარი / Request lari**. The page text says this is not a confirmed bank transaction and not bank-file turnover.
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

After the KAM confirms the client accepted the rate, and only when the new column can be read:

1. **გაწერეთ კურსი** — existing `kam_client_reply`. Approval is saved. `rate_write_deferred` stays false. The row goes to the treasury write queue, as today.
2. **ჯერ არ გაწეროთ კურსი** — `kam_defer_rate_write`. The same approval and approved rate are saved, and `rate_write_deferred` is set true. Treasury’s write queue and the approval inbox do not see it.

The held row stays on the KAM’s open list, including after the request date is no longer today (up to 200 held ids, then merged into the open read). Status text is **კლიენტმა დაადასტურა — გაწერას ელოდება**. A **გაწერეთ კურსი** button calls `kam_release_rate_write`, which clears the flag once and then notifies treasury and managers the way today’s approval does. The KAM can still edit the permitted comment through `edit_request`.

If the column select fails, the two buttons are not shown and the single Send button calls `kam_client_reply`. Replies do not break when setup 43 has not been pasted.

This is not payment success and not a written rate. `rate_written_at` is still the mark that the deal went through and cannot be deleted.

### D. Special bank-rate reference

The checkbox **კლიენტს აქვს ბანკის სპეციალური კურსი** is unchanged. When it is on, a reference block appears under it.

- **Valuto** is confirmed in `supabase/functions/fetch-market-rates/index.ts` (`valuto()`). It GETs `https://valuto.ge/wp-json/rest-currency-list/v3/currencies` and stores `source = valuto`, `venue = Valuto`, `venue_kind = board`, buy/sell from `CcFrom` / `CcTo`. The checkbox shows that stored quote only when one exists from the last two days for the pair. It is labeled as the TBC provider reference. It does not write `client_special_rates`.
- **Express Online** has no source, venue, URL, buy/sell map, currency list, freshness rule, or failure mode in that function. The block always says the rate is unavailable and the feed is not connected. `expresslombard` / “Express Lombard” (`https://expresslombard.ge/api/currencies/get-currencies`) is a different provider and is not used. No price is invented. No scraper was added.

Client negotiated terms stay in `client_special_rates`. Blank fields are still not sent, so stored values are not wiped. This is not `log_request`’s `p_bank`. Treasury still sees the client-reported special terms on the request.

## Files changed

New:

- `src/lib/deferWrite.ts` — column probe, held-row detection, open-list merge, comment save
- `src/lib/requestGel.ts` — client port of `private.request_gel`
- `src/components/DeferWriteBar.tsx` — held status, release button, comment
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
| Approved and held | true, `client_reply = approved`, `rate_written_at` null | KAM open list only. Not the write queue. Not the approval inbox |
| Released | set back to false once | Same as “approved and sent” |
| Written | `rate_written_at` set | Unchanged. Cannot be deleted. Not a bank transaction by itself |
| Payment mark or SUCCESS match | existing rules | Unchanged. Held release refuses a payment mark |

Guards:

- Defer uses the same checks as `kam_client_reply`: owning KAM, `can_write()`, source app, quoted, no reply yet, quote not expired, not written, not payment-confirmed, no SUCCESS transaction for that client on that day. `FOR UPDATE`. The update requires `client_reply is null`. A second defer raises.
- Quote expiry is checked when the approval is saved. It is not checked again on release, because the client already accepted.
- Release is the owning KAM. If the row is not approved, it raises. If it is already written or payment-confirmed, it returns. If the flag is already false, it returns. An explicit loss (`marked_lost_at`, `loss_approved_at`, or loss-reason text) raises and does not enter the queue. The update is `where rate_write_deferred and rate_written_at is null`. A second call does nothing.
- `treasury_mark_rate_written` refuses a held row, and its update also requires the flag false and `rate_written_at` null.
- `treasury_client_replies` excludes `client_reply = approved and rate_write_deferred`. The desk and the phone queue also drop those ids client-side, so a 14-day extra query cannot show a held row once the column exists.
- The inbox trigger skips the treasury and manager notice when a new approval is deferred. When the flag goes from true to false while the reply is still approved, it sends that same notice. Release also emits `request.client_approved`. Defer does not.
- The desktop form and the phone detail use an in-flight lock so two clicks do not send twice. The database lock is the real guard.
- Search and role filters are unchanged. A KAM still sees only their own requests. `private.can_see_all()` is still admin and manager. The analyst still reads `analyst_deals` only.
- `log_request` argument names are unchanged.
- Views `request_outcomes`, `request_active`, and `analyst_deals` were not replaced, so success and loss semantics stay.

Freshness-only `loss_open` does not hide a hold. An explicit loss is not forced back onto the open list.

## SQL waiting for approval

Paste file: **`supabase/setup/43_defer_rate_write.sql`**

Matching migration, same body, also not applied: `supabase/migrations/20261016180000_defer_rate_write.sql`

Paste it only after it is approved, and only after `42_client_special_rates.sql`. Do not re-run `1_platform.sql`. It is idempotent. It does not drop tables or functions. It does not widen RLS. It does not add a KAM to `analyst_deals`.

What it does:

1. Adds `requests.rate_write_deferred` if missing, default false, with a comment. No update of old rows.
2. Creates `kam_defer_rate_write(p_request_id bigint, p_rate numeric)`. Owner-only. Sets `client_reply = approved`, `approved_rate`, `client_replied_at`, and the flag true. Does not notify.
3. Creates `kam_release_rate_write(p_request_id bigint)`. Clears the flag once, then emits the approval event. Idempotent.
4. Replaces `private.inbox_on_request` from the current body in `20261008180000_kam_edit_delete.sql`, plus the two flag branches described above.
5. Replaces `treasury_client_replies` with the same signature and the held-row exclusion.
6. Replaces `treasury_mark_rate_written` so a held row cannot be marked written.
7. Grants execute on the two new functions to `authenticated` and revokes them from `public` and `anon`.

`kam_client_reply` is not replaced and its signature is not changed.

Until this file is pasted, the two-choice workflow is not deployable. The UI in this branch is safe to have present only because it hides the choice when the column is missing.

## Special-rate provider findings

| Reference | What exists |
| --- | --- |
| Valuto, TBC | Connected. Function `valuto()` in `fetch-market-rates`. URL `https://valuto.ge/wp-json/rest-currency-list/v3/currencies`. Stored source `valuto`, venue `Valuto`, kind `board`. Buy and sell from `buy` / `sell`, pair from `CcFrom` / `CcTo`. Shown only from a stored row newer than two days. |
| Express Online, BOG | Not connected. No identifier, no feed URL, no buy/sell fields, no currency list, no freshness window, no failure path. The UI states that. |
| Express Lombard | Connected as a different board (`expresslombard`, venue “Express Lombard”, URL `https://expresslombard.ge/api/currencies/get-currencies`). Not used as the BOG special-rate reference. |

No live quote was read in this session. Whether a current Valuto row is stored in `market_rates` was not checked.

## Legacy transaction dependencies that remain

These stay. None were dropped.

| Dependency | Why it stays |
| --- | --- |
| `public.transactions` and its RLS (`can_see_all` or `is_my_client`) | Historical payments. Outcome math and loss blocking still read them. |
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
2. Paste it after `42_client_special_rates.sql`. Do not re-run `1_platform.sql`. Do not drop anything.
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
- The two-choice path, reload, re-login, double submit, quote expiry, and loss blocking
- An old approval staying on the treasury queue (flag default false)
- Treasury phone and desktop queues hiding a held row
- Search and “view as” isolation
- Valuto appearing only when a stored quote exists
- The Express Online unavailable sentence next to saved client terms
- Desktop and phone layouts of the new bars

Those need a database where 43 has been pasted, and a signed-in KAM, treasury user, and admin.
