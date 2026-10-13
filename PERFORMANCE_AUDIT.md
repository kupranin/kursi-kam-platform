# Performance and architecture audit

Internal platform for Key Account Managers (KAMs) and Treasury. This audit is a reading of the repository. It does not change the app, the database, or production settings.

The goal is a faster rate desk and request flow, clearer live updates between KAMs and Treasury, and a phone-friendly employee app, while keeping today’s workflows, permissions, and data.

---

## 1. How this audit was done

Evidence is the source tree: React pages under `src/`, `package.json`, `vite.config.ts`, `vercel.json`, `index.html`, `src/styles.css`, `DEPLOY.md`, and the SQL in `supabase/setup/` and `supabase/migrations/`. The latest intended definitions are the highest-numbered setup files (through `supabase/setup/32_loss_visible.sql`) and the matching migrations (through `20261012130000_loss_visible.sql`). If a paste was skipped in Supabase, production can differ from these files.

The waiting-list interval was read from the current `src/pages/RateDesk.tsx`, not from older notes. It is **3 seconds**. The rest of the rate desk still reloads on a **15 second** timer.

### What was not measured

- No production traces, Vercel analytics, or Supabase API logs.
- No `EXPLAIN` against the live database, so index advice is “these filters exist in the app and these indexes exist in SQL,” not a proven scan plan.
- No row counts for `requests`, `transactions`, or `staff_messages`.
- No built JavaScript size. The bundle graph is inferred from imports.
- No phone or desktop session. Mobile notes are from CSS and HTML, not from a device.
- No claim about milliseconds, Frankfurt round-trip time, or how slow a screen feels in production.

Do not treat qualitative impact below as a measured speedup.

---

## 2. Architecture snapshot

**Stack.** Vite 5, React 18, React Router 6, TypeScript. The only backend client library is `@supabase/supabase-js`. Excel upload uses the `xlsx` package. There is no React Native, Capacitor, or other native shell.

**Where it runs.** `vercel.json` is a single rewrite of every path to `index.html`. There is no `api/` folder and no Vercel serverless function. The browser loads a static Vite build from Vercel’s CDN, then talks to Supabase for data, login, Realtime, and two Edge Functions (`admin-users`, `fetch-market-rates`). `DEPLOY.md` tells the operator to create the Supabase project in **Central EU (Frankfurt)**. The repo does not record the live project id or prove that the running project is in that region. Vercel’s own region is not set in `vercel.json`.

**Where data is fetched.** Pages call `supabase.from(...)` and `rpc()` in `src/lib/supabase.ts`. The hot path is the view `request_outcomes` and the functions `treasury_queue`, `treasury_quotes_today`, and `treasury_client_replies`. Live refresh is `useLive` in `src/lib/useLive.ts`: a Realtime channel on `postgres_changes`, plus a timer, plus reload on window focus and when the tab becomes visible.

**Auth.** Email session in the browser (`persistSession`, `autoRefreshToken`, implicit flow so invite and recovery links in the URL hash are picked up). After a session exists, the app calls `my_profile` and checks MFA (`aal1` vs `aal2`). Roles in the app are `admin`, `manager`, `treasury`, `kam`, and `analyst`. `private.can_see_all()` is admin and manager. Analyst is read-only on the analysis list. Most writes go through security-definer functions that check the caller. Row Level Security is on the tables. Signed-out users get nothing.

**What must stay true while speeding this up.** A written rate is a completed deal and must not be deleted. A loss stays open until Treasury or an admin approves it. `log_request` argument names stay as they are (`p_client_id`, `p_sells_currency`, `p_gets_currency`, `p_amount`, `p_note`, `p_client_name`, `p_gets_amount`, `p_client_rate`, `p_bank`). Do not reorder or drop columns of `request_outcomes`. Do not remove `SECURITY DEFINER` from `analyst_deals` or `request_rate_names` without a replacement for the access those views provide (see issue 1 and the roadmap).

---

## 3. The 10 highest-impact opportunities

Ranked by what a KAM or a Treasury user feels on the rate desk and the request flow. Easier changes are not ranked higher.

### 1. The lists everyone watches are built on a heavy outcomes view

**Problem.** `public.request_outcomes` (latest text in `supabase/setup/32_loss_visible.sql`) is `security_invoker = true`. Every row joins clients and profiles, formats banks, and runs a per-row `EXISTS` against `transactions` for a successful payment on that client and day (or `matched_request_id`). `went_through`, `outcome`, and `loss_open` all depend on that check.

The rate desk, KAM requests, follow-ups, quoted progress, lost requests, desk history, the request log, and the header badges all read this view. Several of those reads ask PostgREST for an exact count (`select('*', { count: 'exact' })` in `QuoteProgress.tsx`, `DeskHistory.tsx`, `LostRequests.tsx`, and the KAM history query in `Requests.tsx`). An exact count has to evaluate the view for every matching row, not only the page on screen.

`analyst_deals` (same file, `security_invoker = false`) repeats a similar transaction `EXISTS` for the analysis list. That view is security definer on purpose: `requests_read` allows a KAM’s own rows, admin/manager (`can_see_all`), or Treasury, and it does **not** include analyst. `profiles_read` allows your own profile or admin/manager, so Treasury, a KAM, and an analyst cannot see other people’s names through RLS. `analyst_deals` and `request_rate_names` (`supabase/migrations/20261009180000_rate_people.sql`) read those names as the view owner and apply their own role check. Dropping `SECURITY DEFINER` on either view would hide rows or names. It would not make the desk faster in a safe way.

**Impact.** Treasury’s “today” list and a KAM’s request history wait on payment matching even when the user only needs the open quote. The cost grows with `transactions`, which is the large table (analytics SQL already calls out full-table payment scans as a past failure).

**Recommended solution.** Keep `request_outcomes` and its column order for history, loss, and “went through.” Add a narrow read for the open desk and the KAM’s open cards that selects from `requests` (and the small joins those cards need) and does not probe `transactions`. `treasury_queue()` in `supabase/setup/26_desk_and_history.sql` is already that shape for the waiting list. Use the outcomes view when the screen truly needs `went_through` or loss state. Leave `analyst_deals` and `request_rate_names` as security definer.

**Expected benefit.** The screens that sit open all day do less work per refresh. History and loss screens stay correct. Qualitative only.

**Complexity.** High.

**Risk.** High if the new read disagrees with loss, written-rate, or payment rules. Medium if the waiting list and “today” open rows move to `requests` while closed rows stay on the view. Test quote, client reply, written rate, loss mark, and loss approval side by side with the current lists.

### 2. One rate-desk refresh fires many overlapping queries

**Problem.** Confirmed in `src/pages/RateDesk.tsx`:

- `refreshQueue` calls `treasury_queue`, then `closedIds`, which selects from `request_outcomes` for those ids (and falls back to `requests` if that errors).
- A timer calls `refreshQueue` every **3000 ms**.
- `useLive(['requests'], load, 15000)` reloads the whole desk every 15 seconds, on every `requests` change, on focus, and when the tab becomes visible. `load` calls `refreshQueue` again, then `treasury_quotes_today`, `treasury_client_replies`, another outcomes query (limit 40), `loadDeskDay`, loss reasons, and `request_rate_names`.
- `loadDeskDay` runs **seven** parallel queries (eight if extra ids are passed), each `select` of a wide column list from `request_outcomes` with `.limit(1000)`, filtered on `request_date`, `quoted_at`, `asked_at`, `client_replied_at`, `rate_written_at`, `rate_valid_until`, and `loss_reason_at`. The same deal can come back in several slices and is merged in the browser.
- `closedIds` runs again for quotes and again for replies.
- After `queue`, `replies`, or `extraAgreed` is replaced, an effect loads banks from `requests` and the same ids again from `request_outcomes`. `setQueue` always stores a new array, so this effect runs on every 3 second tick even when the waiting list did not change.

`treasury_queue` itself is a security-definer function with a per-row “is this client new?” lookup and two lateral quote lookups. That is reasonable for a short waiting list. It becomes expensive when it is paired, every few seconds, with the outcomes view.

**Impact.** Treasury keeps the rate desk open. The waiting list is the handoff (“კურსს ელოდება”). The 3 second check is the right idea, and it already updates without waiting for the rest of the page. The extra queries on that tick, and the 15 second full reload, compete with sending a rate. A KAM’s new request can also trigger a full desk reload through Realtime, on top of the timer.

**Recommended solution.** Keep the 3 second `treasury_queue` check. Skip `setQueue` and the follow-up bank/outcomes effect when the id list and the fields on the cards are unchanged. Do not call `load()` from that timer. On Realtime and on the 15 second safety reload, refresh quotes, replies, and today on a slower cadence, or only when the changed row is relevant. Replace the seven day slices with one query (or one function) that ORs those “on the desk today” conditions, still limited, still in Asia/Tbilisi.

**Expected benefit.** Far fewer round trips while the desk is open. The waiting list can stay on a few-second check. Qualitative only.

**Complexity.** Medium.

**Risk.** Medium. A missed reload could leave a quoted deal on screen until the safety timer. Keep a safety reload. Do not change `treasury_quote`, `treasury_mark_rate_written`, or the delete-after-written rule.

### 3. Realtime means “reload everything,” and two listeners do it at once

**Problem.** `useLive` opens a channel named `live-<tables>-<random>`, listens to every insert, update, and delete on the table (`event: '*'`, no column filter), and calls the page’s full reload. It also polls. The header (`src/components/Layout.tsx`) and the open page each call `useLive(['requests'], ...)`, so one request change reloads badge counts and the page. The bell (`NotificationBell.tsx`) has its own channel on `user_notifications` and polls every 30 seconds.

Publication SQL adds `requests`, `staff_messages`, and `user_notifications` to `supabase_realtime`. `DEPLOY.md` says that if `requests` is missing from the publication, the desk only updates on the timer. This audit cannot see the live publication.

The payload is ignored. A KAM edit, an import, a loss approval, and a new ask all look the same: reload the screen.

**Impact.** The live path between KAM and Treasury is slower and burstier than a small waiting-list update. When Realtime is off, Treasury still sees new asks within about 3 seconds, and the rest of the desk within about 15 seconds. When Realtime is on, a busy `requests` table refreshes the open page and the header together.

**Recommended solution.** One shared listener for `requests` while the app is open. For the rate desk, apply the 3 second queue check as the live path and let Realtime only mark “something changed,” coalesced so ten updates become one reload. Pass a filter when Supabase Realtime allows it (for example `source=eq.app`) only after checking it does not hide treasury-relevant rows. Keep the focus and visibility reload. Keep the safety poll.

Chat should append the new row (issue 7) instead of downloading the table.

**Expected benefit.** A new ask or a sent rate updates the other person’s screen without rebuilding today’s table and the header counts in the same burst.

**Complexity.** Medium.

**Risk.** Medium. Dropping the safety poll would make a missed Realtime event stick until refresh. Coalescing reloads is safer than deleting the poll.

### 4. The rate desk redraws on a clock while someone is typing a rate

**Problem.** `RateDesk` is one component (about 1,200 lines). `useTick(10000)` forces a re-render every 10 seconds so “ელოდება N წთ” stays current. The 3 second queue update calls `setQueue` even when the list is the same, which re-renders the waiting cards, the reply cards, the day table, and the market board. Nothing in `src/` uses `React.memo` or route-level `lazy()`. Child editors such as `QuotedRateEditor` keep their own state, so a parent render does not by itself wipe a rate that was typed into that editor. The waiting-card rate is stored on the page, and the whole page still reconciles on each tick.

`Requests.tsx` uses `useTick(15000)` the same way for “time ago” on the KAM list.

**Impact.** On a phone, redrawing the desk every few seconds makes the rate field and the send buttons less steady. Treasury’s main action is typing a rate and pressing “კურსის შენახვა” or sending the quote.

**Recommended solution.** Move the waiting clock into a small child that ticks on its own. Keep market rates and the day table out of that render. Update queue state only when the returned rows differ.

**Expected benefit.** Typing and sending a rate stay responsive while the clock still moves. Qualitative only.

**Complexity.** Low.

**Risk.** Low, if the quote payload still reads the latest typed rate (`draftRate` already exists for that). Do not change the quote function’s arguments.

### 5. A KAM’s request screen reloads the open list and the history together

**Problem.** `src/pages/Requests.tsx` loads three queries, then `useLive(['requests'], () => { load(); loadHistory(); loadApproved(); }, 20000)` runs all three on every request change and every 20 seconds.

- Open cards: `request_outcomes` with `select('*')`, filtered to that KAM and today or `quote_status = asking`. No limit.
- History: `select('*')` plus exact count, `.range(0, shown - 1)` with `PAGE_SIZE` 100. Admin and manager see every deal. A KAM sees older rows plus some imports.
- Approved list (admin/manager): `select('*')`, limit 40, then another `request_rate_names` lookup.

Follow-ups (`FollowUps.tsx`) load `select('*')` for the last seven days with no limit, and that page does not subscribe, so it can sit stale until revisit. The log (`RequestLog.tsx`) is better: a column list and `.limit(300)`, still on the same view, every 30 seconds.

**Impact.** When Treasury sends a rate, the KAM’s open card should update. The current listener also rebuilds history. History is the large read. The open card, which is the workflow, waits in the same function.

**Recommended solution.** Reload the open cards on Realtime and on a short poll. Reload history when the user opens that section, changes month or KAM, or presses “more,” not on every quote. Select the columns the card renders. Ask for exact counts only where the badge number is required, or count from `requests` for the open set.

**Expected benefit.** The KAM sees the new rate sooner, and scrolling history does not repeat on every Treasury action.

**Complexity.** Medium.

**Risk.** Medium for filters. The history rule (KAM: before today, plus today’s imports that did not go through; admin/manager: everything) has to stay. A wrong filter would hide a deal or show another KAM’s book.

### 6. First load ships every screen, including Excel parsing

**Problem.** `src/App.tsx` statically imports every page. `Analytics.tsx` statically imports `src/lib/transactionFile.ts`, which imports `xlsx`. Vite therefore pulls the spreadsheet parser into the graph that every role downloads, including KAM and Treasury, who have no upload screen. There is no `React.lazy`. `vite.config.ts` sets no manual chunks.

`index.html` loads Fira Sans and Noto Sans Georgian from Google Fonts with `display=swap` and a preconnect. The stylesheet is still in the document head, so first paint waits on that CSS request as well as on the script. There is no service worker to keep the shell for the next open.

**Impact.** Opening the app on a phone, especially the first time or after a deploy, downloads desk code plus admin upload code before anyone can ask for a rate. This matters if the site becomes the employee app.

**Expected benefit.** A faster first open for KAM and Treasury. Repeat visits improve further once a shell can be cached. Bundle kilobytes were not measured.

**Recommended solution.** Lazy-load routes so `/rate-desk` and `/requests` do not import Analytics. Dynamic-import `xlsx` only when an admin picks a file. Self-host the two font files that the UI actually uses, with `font-display: swap`.

**Complexity.** Low.

**Risk.** Low. Route permissions in `PAGES` stay as they are. A lazy route needs the same loading line the app already shows (“იტვირთება”).

### 7. Chat reloads the whole transcript, so it is a weak live channel

**Problem.** `src/pages/Chat.tsx` selects every `staff_messages` row (`id, sender_id, recipient_id, body, created_at`) with no limit, on mount, after every send, on every Realtime event, and every 20 seconds (`useLive` default). The thread is filtered in the browser. Admin and manager can open a log of every pair, which uses the same full download. Indexes exist on sender and recipient (`supabase/migrations/20261007130000_staff_chat.sql`). The query does not use them as a “this conversation, newest page” read.

The operational handoff is the rate desk, not chat. Chat is still the only free-text line between colleagues.

**Impact.** Chat gets slower as history grows, and a new message redraws every conversation. It will not feel like a reliable Treasury–KAM channel on a phone.

**Recommended solution.** Load the latest page for the open pair (the sender/recipient indexes support that). Append a Realtime insert for that pair. Keep the safety poll slow. Leave the admin log as a separate, paged read so a normal chat does not download it.

**Expected benefit.** Opening a conversation and receiving a reply stay quick as months of messages accumulate.

**Complexity.** Medium.

**Risk.** Low for the send path (`insert` into `staff_messages` with RLS). Medium if the admin log is cut over to the same query and suddenly hides old messages. Keep the log complete, just paged.

### 8. The phone layout is a desktop page with one breakpoint

**Problem.** `index.html` sets `width=device-width, initial-scale=1` and `theme-color`. `src/styles.css` has one breakpoint, `max-width: 800px`. That block does real work: safe-area padding, a wrapping header, a horizontally scrolling nav, full-width fields, 44px buttons, and 16px inputs (so iOS does not zoom on focus).

Treasury’s nav is eight links (`src/lib/nav.ts`): კურსის მაგიდა, გაცემულის მიმდინარეობა, დაკარგული მოთხოვნები, ისტორია, ანალიზი, კურსები, ჟურნალი, ჩატი. On a phone they sit in one scrolling strip (`flex-wrap: nowrap; overflow-x: auto`). The day table is `.desk-day .table { min-width: 760px }`, so “today” is a sideways table. Rate cards are closer to a phone layout than the tables are. There is no bottom bar for the two actions that matter (new request, waiting queue).

There is no web app manifest, no service worker, no Apple touch icon, and no `apple-mobile-web-app-capable` / standalone display. Login uses the implicit hash flow (`src/lib/supabase.ts`), which is brittle in some in-app browsers.

**Impact.** A KAM can use the site on a phone today. It does not yet behave as an employee app: install, return, and the rate desk as the home action. Store apps (issue 8 in the roadmap) would wrap this UI and inherit the sideways tables.

**Recommended solution.** After the desk is cheaper to refresh (issues 1–4), make the rate desk and the request form the phone layouts: stack the day list as cards under 800px, put the waiting queue and “new request” on a short bottom nav, and keep tables for history. Add a manifest and icons when you want “Add to Home Screen.” Decide store versus home-screen before any native project (see section 5).

**Expected benefit.** Treasury can send a rate and a KAM can log a request with one hand, without sliding the nav or the 760px table.

**Complexity.** Medium for the two main screens. High if every admin table is rewritten.

**Risk.** Medium for layout regressions on desktop. Low for data, if this is CSS and structure around the same buttons and RPCs. Keep the 44px targets and 16px inputs.

### 9. The header repeats the same heavy counts on the same events

**Problem.** `Layout.tsx` calls `data_freshness` and, depending on role, up to three exact counts. The queue badge queries `requests` (with a second query if `marked_lost_at` errors). The loss badge and the follow-up badge count `request_outcomes` with `head: true` and `count: 'exact'`. `useLive(['requests'], loadCounts, 60000)` runs this on every request change as well as every 60 seconds. That is a second listener beside the page (issue 3), aimed at the same view as issue 1.

The bell loads 40 notifications, then every `notification_id` the user has ever read, with no limit, every 30 seconds.

**Impact.** Badge numbers are useful (queue, დაკარგული მოთხოვნები, follow-ups). They currently add outcomes-view work on the same moment the desk is trying to refresh. On a slow link the header and the list stall together.

**Recommended solution.** Count the queue from the same `treasury_queue` result the desk already has, or from the `requests` filter alone, on the slower timer. Do not count losses through `request_outcomes` on every keystroke of the desk; a 60 second poll is enough for a badge. Limit or cache read-marks for the bell (ids of the 40 visible notes).

**Expected benefit.** The open screen and the badge stop competing. Badges stay a minute stale at most, which matches the current poll.

**Complexity.** Low to medium.

**Risk.** Low if the badge can lag. The queue badge must keep matching who is actually waiting (asking, and the approved / better-rate cases the header already ORs in). Compare the badge to the waiting list before shipping.

### 10. Desk filters do not have matching indexes in the SQL

**Problem.** Indexes created in the repo for `requests` include `(client_id, request_date)`, `(kam_id, request_date)`, `(request_date)`, `(requested_at)`, a partial index on `asked_at` where `quote_status = 'asking'`, a partial index on `client_replied_at` where a better rate is still open, and a partial index for loss approval. Transactions have client/date indexes and a partial index on `matched_request_id`.

`loadDeskDay` filters `quoted_at`, `asked_at` (not only the asking partial index), `client_replied_at` (not only the better-rate partial index), `rate_written_at`, `rate_valid_until`, and `loss_reason_at`, usually with `source = 'app'`. Those columns are not indexed in the SQL files. Quoted progress orders by `quoted_at`. Desk history orders by `rate_written_at`. The outcomes view’s payment `EXISTS` can use `(client_id, tx_date)` and the matched-request index; that part is in better shape.

This is not an `EXPLAIN`. Postgres may still choose a scan of `request_date` or a sequential scan once the table is large. The app’s query shape is what makes the gap matter.

**Impact.** As app requests accumulate, “today on the desk,” quoted progress, and written-rate history get slower even after the duplicate fetches in issue 2 are removed. The waiting list is partly protected by `requests_asking_idx`.

**Recommended solution.** After issue 1’s narrow read exists, index the columns that read still uses. Likely candidates, to be confirmed with `EXPLAIN` on production-like data: `(source, request_date)`, `(quoted_at)`, `(rate_written_at)`, `(rate_valid_until)`, `(loss_reason_at)`. Add them with `CREATE INDEX CONCURRENTLY` in a migration that does not rewrite views. Do not drop the asking partial index; `treasury_queue` uses it.

**Expected benefit.** List queries stay stable as history grows. No number is claimed without a plan.

**Complexity.** Low for the migration. Medium to roll out safely on a live database (locks, and confirming the planner uses them).

**Risk.** Low for behavior. Index builds take space and a short lock window if they are not concurrent. They do not change RLS or workflows.

---

## 4. Prioritized roadmap

### Do first (phase 1) — stop repeated work, no schema change

1. On the rate desk, keep the 3 second waiting-list check and stop it from refetching banks and outcomes when the list is unchanged (issue 2, issue 4).
2. Stop the 15 second and Realtime path from calling the full `load()` on every tick. Coalesce reloads (issue 3).
3. Split the waiting clock out of the page render (issue 4).
4. On the KAM request page, refresh open cards without refreshing history (issue 5).
5. Slow the header counts so they do not run on every request change (issue 9).

These are client changes. They preserve RPCs, RLS, and what each button does.

### Do second (phase 2) — make one desk read cheap

1. Add a desk/open-request read that does not scan `transactions` (issue 1). Keep `request_outcomes` for history, loss, and went-through.
2. Replace the seven day slices with one limited query.
3. Add the missing indexes only after `EXPLAIN` on a copy of the data (issue 10).

### Do third (phase 3) — first open and the phone

1. Lazy-load routes and load `xlsx` only for upload (issue 6).
2. Phone layout for the rate desk and the request form (issue 8 and section 5).
3. Home-screen install (manifest, icons) if that is the chosen employee app. Do this after the desk is fast, so the installed app is the fast one.

### Leave until later

- Chat paging and live append (issue 7). It matters, and it is not the rate handoff.
- Analysis (`analyst_deals`) and analytics RPCs. They are heavy and already paged (`PAGE = 100` on the analysis screen). They are not the all-day KAM/Treasury loop.
- Market board on the desk: `loadMarketRateData` can page up to 20,000 `market_rates` rows for two days, every five minutes, on top of `market_rate_grid`. Move that off the first desk paint when the desk itself is cheap.
- Rewriting admin screens.

### Do not change

- Who can do what: KAM logs and replies, Treasury quotes and writes, Treasury or admin approves a loss, analyst reads, manager reads, admin administers. View-as must not widen the real database role.
- Row Level Security and the reason `analyst_deals` and `request_rate_names` are security definer.
- Column order and names of `request_outcomes`. `CREATE OR REPLACE VIEW` fails or breaks callers if columns move. The setup files say not to drop the view with `CASCADE`.
- A written rate or a confirmed payment is success. Do not delete those rows. See `supabase/migrations/20261009170000_no_delete_written.sql` and `supabase/setup/29_no_delete_written.sql`.
- Loss approval: the row stays until `loss_approved_at`. Approving does not delete it. A KAM cannot approve their own loss.
- `log_request` argument names listed in section 2. The KAM form calls them by those names.
- Quote, decline, better-rate, and mark-written function names and the meaning of their arguments (`treasury_quote`, `treasury_decline`, `treasury_answer_better`, `treasury_mark_rate_written`, `kam_client_reply`).

---

## 5. Mobile and PWA readiness

This is issue 8 in the ranked list, plus what “employee app” still requires.

**Already in good shape.** Viewport meta tag. Theme color `#5F245C`. Touch height on buttons (44px), inputs (48px, 16px type), and segment buttons (48px). Safe-area padding on the header and the bottom of the page. Cards and forms stack under 800px. The rate field uses `inputMode="decimal"`. Georgian and English strings already exist, so a phone UI does not need a new copy system.

**Not ready for an installed employee app.**

| Need | In the repo |
|---|---|
| Web app manifest, icons, standalone display | Absent |
| Service worker / offline shell | Absent |
| Install hints (`apple-touch-icon`, mobile-web-app meta) | Absent |
| Phone navigation for the main job | Horizontal scroll of the full desktop nav |
| Day list on a narrow screen | Table with `min-width: 760px` |
| Native iOS/Android project | Absent. The app is a website |

A home-screen PWA can be this same Vite app plus a manifest, icons, and a small service worker that caches the shell. Login still needs a network. A store app needs a wrapper (and a decision about cookies, the hash login flow, and push). Building the wrapper before issues 1–4 and the phone layout would ship a slow desktop page inside a phone frame.

Push notifications are not in the client. In-app notices are the bell, polled and subscribed as in issue 9. SMS and WhatsApp are described as Make.com in `DEPLOY.md`, outside this UI.

---

## 6. Appendix — real issues that did not make the top 10

- **Market rates on the desk and on კურსები.** `src/lib/marketBoard.ts` pages `market_rates` in batches of 1,000, up to 20,000 rows, then the desk repeats that every five minutes. The rates page does the same. It is not the quote button, and it shares the open desk’s network.
- **Queue errors toast every 3 seconds.** `refreshQueue` shows `toast(..., 'error')` on every failed poll. A down database would stack the same message. Show it once until a poll succeeds.
- **No React error boundary.** A render error blanks the app. Loading states exist (`LoadingLine`, “იტვირთება”, and several “სია ჯერ არ იტვირთება” messages). Some failures are swallowed (header counts, market board, follow-up win-back).
- **Follow-ups have no live reload and no limit** (issue 5). Stale is the user-visible part; the unbounded `select('*')` is the cost when the page is opened.
- **Notification read marks are unbounded** (issue 9).
- **Dev-only double fetch.** `src/main.tsx` wraps the tree in `StrictMode`, which runs effects twice in development. Production builds do not do that. Do not “fix” polling by removing StrictMode.
- **Auth volume is small.** One session read and `my_profile` per sign-in, plus MFA assurance. Not the desk problem. The implicit hash flow is a mobile-browser risk (section 5).
- **Analytics upload** loops `import_transactions` and `finish_transaction_upload` from the browser. That is an admin task, already called out in SQL comments as something that must not scan every payment. Leave it off the KAM/Treasury critical path.

---

## 7. What we still need from you

These are the gaps this repo cannot answer. Do not paste keys, the service role, or database passwords.

1. Is the live Supabase project in Frankfurt (Central EU), as `DEPLOY.md` instructs, or somewhere else? The static site’s region matters less than the database region, because every screen calls Supabase from the phone.
2. Which screen feels slow in real use: the waiting list on კურსის მაგიდა, the “today” table, the KAM request page, history, chat, or analytics? One sentence is enough.
3. Rough size, from the Supabase table editor or a count someone already has: rows in `requests`, `transactions`, and `staff_messages`.
4. Is `requests` actually listed under Database → Publications → `supabase_realtime` in the live project? `DEPLOY.md` says live updates stay on the timer when it is missing.
5. A short Supabase API or Postgres log for a busy minute on the rate desk (query names and durations). `EXPLAIN` for `request_outcomes` filtered to today’s app rows would confirm issue 1 and issue 10. No connection strings.
6. For the employee app: a home-screen icon (PWA) or an App Store / Play Store build? That choice changes phase 3 and does not change phases 1 and 2.
