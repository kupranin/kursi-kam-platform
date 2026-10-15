# Mobile UX audit

This audit is for the people who will change the phone interface later. It does not change the app. Desktop stays the place for analysis, history, KPIs, the team, and admin. The phone is for the live desk: ask for a rate, answer a rate, send a rate, mark it written, chat, and see the market.

Georgian copy uses **ხაზინა** for treasury. Do not introduce სახაზინო.

Reviewed on disk in this repo (branch work as of 15 October 2026). There were no uncommitted notification edits. `NotificationBell.tsx`, `PushToggle.tsx`, `src/lib/push.ts`, `public/sw.js`, `public/manifest.webmanifest`, `supabase/functions/send-push/index.ts`, and `supabase/setup/39_push_subscriptions.sql` are the files described below.

What was opened in a browser: the live site `https://kursi-kam-platform.vercel.app/` while signed out, in headless Chrome, at 390×844, 393×852, 402×874, 430×932, 360×800, 412×915, and landscape 844×390. The sign-in card is usable in every portrait size: Georgian title, large email and password fields, a full-width sign-in button, and the language switch. In landscape the sign-in button is cut off the bottom of the screen. This session did not sign in. Signed-in screens below are judged from the components and CSS, not from taps on a live account. Cursor’s browser tab would not stay open, so there is no signed-in click-through.

Phone layout turns on at `max-width: 800px` (`src/lib/usePhone.ts`). That is the shell every recommendation below assumes, until the landscape bug in section 10 is fixed.

---

## 1. Current mobile architecture

`usePhone()` is true when the viewport is 800px wide or narrower. `Layout` then hides the desktop link row and renders `PHONE_NAV` from `src/lib/nav.ts` as a fixed bottom bar (`.tabbar`). The page gets bottom padding so content can scroll above that bar (`src/styles.css`, the `max-width: 800px` block). The top bar keeps the brand, the language switch, the notification bell, and the avatar. It hides the desktop nav, the “view as” control, and the transaction-freshness line.

`PhoneGate` (`src/components/DesktopOnly.tsx`) replaces any route that is not in that role’s `PHONE_NAV` with a short “this page is on a computer” card and a link home. An analyst has an empty phone nav, lands on that card, and can only sign out. `/security` is not behind `PhoneGate`, so password and sign-in stay reachable from the avatar on a phone.

Home redirects:

| Role | Phone home | Phone tabs, in order |
| --- | --- | --- |
| KAM | `/requests` | Requests, Follow-ups, Rates, Chat, Clients |
| Treasury (ხაზინა) | `/rate-desk` | Desk, Lost, Rates, Chat, Quoted progress |
| Admin | `/rate-desk` | Desk, Requests, Lost, Chat, Rates |
| Manager | `/requests` | Requests, Lost, Chat, Rates |
| Analyst | none | none |

Desktop `NAV` is longer. Phone already drops team numbers, the log, desk history, analysis, analytics, KPIs, and admin. That cut is right. What remains is still the desktop pages, squeezed.

Shared chrome on a phone:

- Five text tabs for KAM, treasury, and admin. Four for a manager. Labels are Georgian words at 12px, with `overflow-wrap: anywhere`, and no icons. On a 360px Android screen each tab is about 70px wide, so მოთხოვნები, დაბრუნება, დაკარგული, and მიმდინარეობა wrap onto two lines and the bar grows.
- Tab targets are at least 52px tall. Header targets are not: the bell and the avatar are 38×38.
- Badges on the bar come from `Layout`: queue, losses, follow-ups, and chat. They poll slowly (queue and losses about once a minute, chat about every 10 seconds, plus realtime on `staff_messages`).
- Toasts sit at `bottom: 20px` with z-index 50. The tab bar is fixed at the bottom with z-index 40. A toast covers the tabs.
- Actions inside `.list-row` and `.req-card` become a wrapping row of equal half-width buttons. A card with several actions becomes a grid of same-weight buttons.
- Tables keep `overflow-x: auto`. Several phone screens still set a large `min-width`, so the person scrolls sideways.

Screens a phone can open today:

- KAM: `Requests`, `FollowUps`, `MarketRates`, `Chat`, `Clients`, plus `Security` and the bell.
- Treasury: `RateDesk`, `LostRequests`, `MarketRates`, `Chat`, `QuoteProgress`, plus `Security` and the bell.
- Admin: the treasury set, plus `Requests`, minus quoted progress and clients. Team, analytics, analysis, KPIs, log, history, follow-ups, and admin settings show the desktop-only card.
- Manager: `Requests` (the all-deals view, not the KAM form), `LostRequests` (read-only; only treasury and admin can approve), `Chat`, `MarketRates`.
- Analyst: desktop-only card.

`RateDesk` already hides the right-hand column on a phone (`col-side`: “კურსები ახლა”, today’s specials, and the position card). The waiting cards, today’s deals table, the better-rate cards, and “rate to write” stay in the main column.

---

## 2. Current PWA implementation

The live site serves the same shell as the repo.

- `index.html` links `/manifest.webmanifest` and `/icon-180.png` as the Apple touch icon. It sets `theme-color` to `#5F245C`, `apple-mobile-web-app-capable`, and `mobile-web-app-capable`. The viewport is `width=device-width, initial-scale=1.0`. It does not set `viewport-fit=cover`, `interactive-widget`, or `apple-mobile-web-app-status-bar-style`.
- `public/manifest.webmanifest`: name `kursi business`, short name `kursi`, `id` and `start_url` and `scope` `/`, `display: standalone`, background `#FFC639`, theme `#5F245C`, `lang: ka`. Icons are 180, 192, and 512. None declare `purpose`. There is no maskable icon and no install screenshot.
- `public/sw.js` is a push worker only. It calls `skipWaiting` and `clients.claim`. It does not cache pages or assets. Install does not make the desk work offline.
- `vercel.json` serves `sw.js` as JavaScript with `Cache-Control: public, max-age=0, must-revalidate`, and the manifest as `application/manifest+json`. The SPA rewrite does not swallow files that contain a dot, so `/sw.js` stays the worker.
- `Layout` calls `ensurePushWorker()` on every signed-in load, which registers `/sw.js` at scope `/`.
- Live check, 15 October 2026: `/manifest.webmanifest` and `/sw.js` return 200 with those content types. The deployed JS bundle contains a VAPID public key, so the current Vercel build is not in the “key missing” state. The key value is public by design; it is not repeated here. A later build without `VITE_VAPID_PUBLIC_KEY` would ship an empty key, because Vite bakes it in at build time.

Installable means: Android Chrome can offer an install from this manifest, and iPhone Safari can use Add to Home Screen. The installed window is still this responsive site. There is no `beforeinstallprompt` of our own, no “what to do after install” step, and no phone-specific screens.

---

## 3. Current notification architecture

Two in-app channels, then an optional push on top.

**Inbox.** Database trigger `private.inbox_on_request` writes `user_notifications` when an app request is created or changes: new request and a repeated ask (audience `treasury`), rate quoted, treasury declined, rate written, and a corrected better-rate (the KAM’s `profile_id`), client approved (treasury and manager), client wants a better rate (treasury), client declined (treasury). Titles use ხაზინა where they name treasury. The bell reads the latest 40 rows. Realtime is published on `user_notifications`. `NotificationBell` reloads on that and every 30 seconds.

**Chat.** Rows go to `staff_messages`. Unread is not in the database. `src/lib/chatNotice.ts` stores the latest seen message id per sender in `localStorage` under `kursi-chat-read:<profile id>`. `Layout` toasts a new chat message when the chat tab is not open on that person. Opening a thread calls `markChatRead`.

**Read marks.** `user_notification_reads` is `(notification_id, profile_id)` with `read_at`. Authenticated users may `select` and `insert` only (`supabase/migrations/20261007180000_inbox.sql` and `supabase/setup/12_inbox.sql`). There is a select policy and an insert policy. There is no `update` grant and no update policy. The bell writes with `upsert` on that primary key (`NotificationBell.mark` and `markAll`) and does not look at the error.

**Push path, in order.**

1. An inbox insert or a chat insert fires `push_inbox_insert` or `push_chat_insert` (`39_push_subscriptions.sql`).
2. `private.queue_push` does nothing if `push_subscriptions` is empty. Otherwise it reads vault secret `push_dispatch_token` and asks `pg_net` to POST `{ kind, id }` to `https://tktqrdapdvnaznryiije.supabase.co/functions/v1/send-push` with header `X-Kursi-Token`. A failure is a warning. The inbox row and the chat message stay saved.
3. `send-push` checks that header against `push_dispatch_secret()` (service role only). It also accepts a service-role bearer. It does not accept a user JWT. The file says to deploy it with JWT verification off, because the gateway would reject this call before the function ran.
4. The function loads VAPID keys from its own secrets, loads subscriptions for the target people, and calls the push service. A 404 or 410 deletes that subscription row. Any other send error is logged and does not change the inbox or the chat row.
5. Inbox targets are the named profile, or every active profile whose role equals `audience`. Chat goes to the recipient, and is skipped for an analyst.
6. The worker (`public/sw.js`) shows a notification only when no window of this origin is focused. A focused window gets nothing from the worker: no banner and no message to the page.
7. A tap closes the notification and opens `payload.path`. Chat paths are `/chat?with=<sender id>`, which `Chat` already reads. Inbox paths come from `inboxPath` in `send-push`: loss approved (except a KAM) goes to `/lost-requests`; treasury goes to `/rate-desk`; a KAM goes to `/requests`; `client.approved` goes to `/requests`; everything else goes to `/log`. The path has no request id.
8. If a window exists, the worker focuses it and tries `client.navigate`. If that fails, it posts `kursi-push-open`, and `listenForPushOpen` in `src/lib/push.ts` assigns that path. If no window exists, it opens one.

**Subscribe path.** `PushToggle` lives inside the bell panel, not on its own screen. `readPushState` returns:

- `ios` on iPhone, iPod, iPad, or an iPadOS desktop user agent, until the site is standalone (Home Screen).
- `hidden` when push APIs are missing for another reason.
- `unconfigured` when `VITE_VAPID_PUBLIC_KEY` is empty.
- `denied` when permission is denied.
- `on` when permission is granted and the browser still has a subscription.
- `off` otherwise, with a button that calls `enablePush`.

`enablePush` asks for permission in the same click, subscribes with the public key, and saves endpoint, p256dh, auth, user agent, and language through `save_push_subscription`. That RPC replaces any previous owner of the same endpoint. Turning push off deletes the row and unsubscribes. A language change updates `lang` on the row.

A GET to the function URL on 15 October 2026 returned HTTP 405 and `{"error":"Use POST"}`, which is this function’s own method check, and the request reached the function without a JWT. So a function is deployed on project `tktqrdapdvnaznryiije`, and JWT verification is not blocking anonymous calls. That does not prove the deployed body matches this file beyond that sentence, and it does not prove the VAPID secrets, the vault token, `pg_net`, or the SQL triggers are in place. Those still have to be confirmed in the Supabase dashboard. This machine did not deploy the function.

---

## 4. Critical mobile UX problems

These are the reasons the current phone UI is not ready for a KAM or for ხაზინა. Priorities are defined in section 11. Every item here is a P0 unless it says otherwise.

**The phone opens a desktop page, not a job.** KAM home is the full Requests page. The new-request form is first: client id, name, three bank buttons, two currency groups (five codes each), two amounts, an optional rate, a comment, and then client history once a client is chosen. “Open requests”, which is where a quoted rate waits, is under that form. ხაზინა home is the full rate desk: a waiting card that includes reference chips, a market table (`PairBoard`), a rate field, validity, two big actions, and client history (`ClientHistory`), then a today’s-deals table with `min-width: 760px`, then better-rate, then rate-to-write. The urgent second and third jobs are below a long first job.

**One card has many equal actions.** On a quoted KAM row the person sees “Client approved”, “Client wants a better rate”, and “Client declined”, then “The transaction went through” and “Lost” from `RequestOutcomeButtons`, then Edit and Delete when those apply. Phone CSS turns `.actions .btn` into half-width buttons, so they look like one grid. ხაზინა’s better-rate card puts Accept, a rate field, Send, and Decline in one wrapping row. There is no single primary action.

**Rate send can fire twice.** `RateDesk.send`, `acceptBetter`, `correctBetter`, and `decline` do not disable the button while the call is in flight. `markWritten` does, using `writingId`. A double tap on “Send rate” can quote twice. The rate field already uses `inputMode="decimal"` and the `.input.big` class, but it sits in a desktop form row with the validity chips and the buttons, and the buttons wrap under it. Nothing pins Send above the keyboard.

**Status is a paragraph.** Waiting, quoted, expired, and declined are pills plus a sentence of instruction (“Tell the client the rate and record the answer.”). The rate is inside the pill text. On a narrow screen the pill wraps (`white-space: normal`). Waiting time is a small muted line, not the first thing on the card.

**Rates on the phone is the desktop grid.** `MarketRates` renders `RateCompareCharts` and then one wide hour table per pair (`.table.rate-grid`, `width: max-content`, sticky first column, an hour column for every stored hour). The download date range and, for treasury and admin, “Refresh rates” sit in the page header. The desktop downloadable table must stay as it is on a computer. On a phone it is the wrong tool: sideways scroll through hours, under a paragraph that explains the download.

**Chat is two desktop panes stacked.** At 800px, `.chat-layout` becomes one column. The people list (a select of the whole company, then every existing thread) stays above the thread. The thread is capped at `min(520px, 58vh)`. The composer is a label, a three-row textarea, and a full-width Send under the thread, in normal flow. It is not fixed above the keyboard, and the tab bar is fixed over the bottom of the page. After a send, the new line appears only when `load()` returns. Unread counts live in `localStorage` on that device.

**The bell does not stay read.** Opening the bell does not mark anything. Tapping one row calls `mark`, paints it read in memory, and navigates to a role home (`/requests`, `/rate-desk`, or `/log`), not to that request. The write is an `upsert`. PostgreSQL requires UPDATE privilege for `INSERT ... ON CONFLICT DO UPDATE`, and this table does not grant UPDATE. The UI ignores the error. The next bell reload (a new inbox row, or the 30-second poll) reads `user_notification_reads` again and the badge comes back. The same failure hits “Mark all read”, on web and on mobile, because it is the same component. Arriving on the desk from a tab or from a push does not mark the related rows either.

**A push tap does not land on the work.** Even when send-push runs, a KAM tap opens `/requests` at the new-request form, and a treasury tap opens `/rate-desk` at the first waiting card. A better-rate note and a rate-to-write note do not scroll to those sections. If the phone app is in the foreground, the worker shows no notification at all. There is no in-app banner for inbox events. Chat has its own toast, which can sit on the tab bar.

**Safe area is declared and not applied.** Tab bar and page padding use `env(safe-area-inset-bottom)`, and the top bar uses `env(safe-area-inset-top)`. Those values stay 0 unless the viewport sets `viewport-fit=cover`, which `index.html` does not. On an installed iPhone the home indicator can cover the tab labels. The keyboard is a separate problem: the tab bar is `position: fixed` at the bottom, and the composer and the rate field are not.

**Landscape phones leave the phone UI.** An iPhone 13/14/15/16 in landscape is 844px wide. Pro and Pro Max are wider. `usePhone` is then false, the bottom bar disappears, and the desktop nav and the rate-desk side column come back. Android 412×915 in landscape is 915px wide and does the same.

---

## 5. Proposed KAM mobile information architecture

Four or five tabs. The job is to start a request and to answer a rate. Everything else is behind More.

**Bottom bar**

1. **საქმე** (Home), route such as `/requests` rebuilt as a home, or a new phone route. Badge: count of rows that need the KAM (a quoted rate with no client reply, and a better-rate answer that came back).
2. **ახალი** (New request). One purpose: create a request. Not mixed into the home scroll.
3. **ჩატი** (Chat). Badge: unread conversations, not a raw message count if that count is large.
4. **კურსები** (Rates). The compact market view in section 7. Not the hour grid.
5. **სხვა** (More).

**More** contains: Clients, Follow-ups, notifications (the push switch and the inbox list), language, password and sign-in, sign out. Do not put team numbers, the log, or history in the bar. Earlier requests can be a link on the home, under Recent, not a second home.

**Home, top to bottom, one screen of work before any history**

1. One primary button if you keep New as a tab: you do not also need a second New button. If a test shows people miss the tab, add one gold **ახალი მოთხოვნა** under the title. Do not put the form on this page.
2. **ჩემი პასუხი სჭირდება** (Needs my action). Quoted rates and treasury answers to a better rate. Newest that is about to expire first. This block is empty-state quiet when nothing is waiting: one line, not a large card.
3. **კურსი მოვიდა** (Rates received). Same rows as the block above if you want a single list. Use one list, not two copies. Split only if “needs action” and “already answered, still open” would otherwise mix. Prefer one list titled by the state of each card.
4. **ხაზინას ელოდება** (Waiting for a rate). Asking rows. Show waiting time. No reply buttons.
5. **ბოლო** (Recent activity). Today’s “went through” and the last few closed rows. Compact. “Show earlier” opens history. History is not on the first screen.

**New request** is its own screen. Order: client (id with numeric keyboard, name), bank (the three existing chips), pair (sell currency, buy currency), one amount (the other side stays optional and collapsed), optional client rate, optional comment, then a sticky **კურსის თხოვნა ხაზინას**. Client history is behind “this client’s history”, not under the form by default. After a successful send, go back to Home and show the new row in Waiting, with a toast above the tab bar.

**A request card on the home** shows only: client name, pair and amount, direction (sells / gets), waiting time or “valid until”, status, the rate when one exists, and one primary button. KAM name is unnecessary on the KAM’s own list. Edit, delete, “transaction went through”, and “lost” move into the card’s detail screen so the list stays one action.

**Detail screen** (opened from the card, and from a notification): the rate large, valid-until, client, pair, amount, banks, comment, the text the KAM copies to the client (`CopyLine` can stay here). Primary actions for a quoted rate, in one thumb zone at the bottom:

- **დამტკიცება** (Accept). Confirms the client took the rate. If the approved rate is usually the quoted rate, prefill it and make Send the only extra step. Do not ask them to retype it when it matches.
- **უკეთესი კურსი** (Better rate). Opens a large numeric field for the rate the client wants, then Send.
- **უარი** (Decline). One reason field, then Save.

Those three are the reply. They are not equal list buttons. Accept is the gold button. Better rate is the second. Decline is a text button. “Transaction went through” and “Lost” appear only after the rate is accepted or when the row is still open and those outcomes are the real next step, on this detail screen, not beside the reply buttons.

---

## 6. Proposed Treasury mobile information architecture

ხაზინა’s phone is a queue. Oldest waiting request is the job. Market tables, today’s spreadsheet, and position math stay on the computer (the side column is already hidden; the today’s table should leave the phone home too).

**Bottom bar**

1. **საქმე** (Home / desk). Badge: requests waiting for a rate, plus better-rate rows still unanswered, plus rates not yet marked written. Three numbers can be one badge if the home makes the split obvious. Prefer a badge only for “someone is waiting on me now” (new requests and better-rate), and a second quieter count on the home for rate-to-write.
2. **დაკარგული** (Lost). Badge: losses waiting for approval. This stays a tab because approving a loss is a treasury action and it already has a count.
3. **ჩატი** (Chat).
4. **კურსები** (Rates), compact market view.
5. **სხვა** (More): quoted progress, recent desk activity, notifications, language, password, sign out. Quoted progress is a watch list. It should not be a primary tab.

**Home, top to bottom**

1. **ელოდება** (Waiting requests). Oldest first. If any row has been waiting past the time you already treat as late (the card already has a `late` class), show those first and mark them urgent. One compact card per request. Tap opens that request. Do not expand the rate form for every card in the list.
2. **უკეთესი კურსი** (Better rate). Only rows with no decision. Hidden when empty, except a single “none” line so the person trusts the screen.
3. **გასაწერი** (Rate to write). Approved rates not yet marked written. Primary action on the card: **კურსი გაწერილია**.
4. **ბოლო** (Recent activity). A few lines: client, pair, rate, status. Not the six-column today’s table. Full today stays on the computer (desk history already exists there).

**One request** (the screen after tapping a waiting card):

- Client, pair, both amounts, direction, KAM first name, how long it has waited, banks, the client’s requested rate if any, the KAM comment if any.
- Market context that already exists: Kursi’s rate for this pair and the best competitor, as two lines from the data `PairBoard` already loads. Not the full source table. Not client history, unless they tap “history”.
- A large rate field, numeric/decimal keyboard, focused when the screen opens.
- Validity as three large choices (5, 15, 30 minutes), default unchanged.
- A sticky **კურსის გაგზავნა**. Disabled from the moment of tap until the call returns. If the rate is far from the standard, the existing second step (“Send anyway”) replaces that button once. It does not add a second live button beside it.
- **კურსს ვერ ვიძლევი** is a text button above the sticky bar, opening the existing reason chips. Those chips stay large (they are already 44px).

**Better-rate screen:** show treasury’s rate and the rate the client wants, large. Primary **დადასტურება** if ხაზინა can accept the wanted rate. Secondary: one large field for a corrected rate and **გაგზავნა**. Decline is a text button that asks for a short reason. One of these is in flight at a time. All three buttons disable while a call runs.

**Rate to write:** client, pair, amount, the rate to type into the core system, copy of the client id, copy of the chat handoff text, then **კურსი გაწერილია**. The blocked-client switch can stay on this screen, as it does now, full width. It is not a second primary button: the written-rate button stays gold.

### Manager and admin

Do not give them the desktop nav on a phone.

**Manager bar:** საქმე, დაკარგული (view, since a manager cannot approve), ჩატი, კურსები, სხვა. Home is a short list: losses waiting on ხაზინა, client approvals from the last day, and a handful of recent requests. It is not the month-filter history that `Requests` shows when `seeAll` is true. Analytics, KPIs, team, and the log stay on a computer, reached from More only as “open on a computer” if you must mention them.

**Admin bar:** same as treasury when the admin is doing desk work (საქმე, დაკარგული, ჩატი, კურსები, სხვა). More holds requests overview, quoted progress, and the line that team, analytics, analysis, KPIs, and admin settings are on a computer. The “view as” control stays off the phone, which is already the case. An admin using the phone should see the same treasury home, not a fifteenth link.

---

## 7. Screen-by-screen redesign

Shared rules for every phone screen: one primary button, at least 48px tall, in the thumb zone; status as a short pill plus the rate, not a paragraph; no sideways scroll on the working screen; loading is the existing `LoadingLine` plus the last data if a refresh fails (the desk already keeps the last list on some errors; do that on the new homes too); empty states stay one sentence. Toasts move to sit above the tab bar, and above the keyboard when it is open. Header bell and avatar grow to 44px. Language switch stays, but it must not wrap the top bar onto a second row on a 360px screen: brand can shorten to the K mark plus “kursi” on a phone.

### KAM home (საქმე)

Replace the current stack in `Requests` (stats, new-request card, open list, went-through, history). Keep the data `splitKamRequests` already computes. Show the four blocks in section 5. The open-row paragraph, the three reply buttons, outcome buttons, edit, and delete do not render on the list card. The list card’s primary button is the next action: **პასუხი** when a rate needs a client reply, nothing but the status when it is waiting on ხაზინა. Tap the card to open detail.

**P0.**

### KAM new request (ახალი)

Move the form that is now the first card of `Requests` onto this screen. Cut the hint paragraphs down to one line that shows after a failed submit (the hints already exist for errors). Currency stays the five codes in `CURRENCIES`. Amount uses the decimal keyboard, which it already requests. Submit sticks to the bottom, above the tab bar, and disables while `busy` is true (the button already disables; keep that). After success, leave this screen.

**P0.**

### KAM request detail

New screen, still fed by the open row. Header: client and pair. Body: rate, valid-until or waiting time, amounts, banks, comments. Bottom: Accept, Better rate, Decline, as in section 5. Copy-for-the-client stays on this screen, not on the list. Edit and delete stay available behind a text button so a mistaken request can still be fixed. They are not beside Accept.

**P0.**

### KAM follow-ups

Today this is a phone tab. The top block (why a request did not go through) is a reasonable phone task: one client, reason chips, and “the transaction went through”. Keep that, but move the screen under More. The win-back table (`min-width: 900`) is a desktop table. On the phone, if it stays at all, it becomes a card: priority letter, client, last request, next step as a full-width select. Do not ship the 900px table. The priority filter chips can stay.

**P1** for the card layout. **P0** for taking it out of the primary bar, because the bar is how people reach the real work.

### KAM clients

`Clients` is a search box plus a table with `min-width: 640`. Search is useful and can stay under More. Results should be rows: name, id, last pair, last date. No horizontal scroll. Tapping a client can start a new request with that client filled in, which saves typing. That link is a **P1**. The table itself on a phone tab is a **P1** once Clients leaves the bar.

### Rates (KAM, treasury, manager, admin)

`MarketRates` on a computer stays as it is, including `PairHourTable`, the date range, and **კურსების ჩამოტვირთვა**. Do not change that table’s columns, hours, or download.

On a phone, do not render `PairHourTable`. Render the comparison that `RateCompareCharts` already builds, simplified:

- A currency-pair selector. The pairs already exist as `.fx-pair` buttons. On a phone they stack one per row (`src/styles.css`). Make them a horizontal selector of pair names (USD/GEL, EUR/GEL, and the crosses you already support), one row, no status essay on the button.
- Kursi’s rate, buy and sell, large.
- Best competitor buy and best competitor sell, with the provider name.
- One line of position: ahead, level, or behind, using the standing text the chart already computes.
- Provider rows only as compact cards (name, buy, sell) if the person opens “all providers”. The plot, the ruler, the legend, and the long buy/sell explanation do not appear on the phone. The tooltip that becomes a fixed panel above the bottom of the screen (`.fx-tip` at `max-width: 800px`) goes away with the plot.

Refresh stays available to treasury and admin, as a button on this screen, not beside a download form. Download stays on the computer. If a phone user needs a file, More can say the download is on a computer. Do not put the date-range form on the phone rates screen.

**P0**, because Rates is on the primary bar today and the hour grid is not usable at 360–430px. The desktop table is unchanged.

### Chat (KAM and treasury, and manager/admin)

Rebuild `Chat` for a phone as two steps.

- List: existing threads, most recent first, unread badge from incoming messages newer than the stored mark, preview, time. A way to start a thread (the current select, or a single “new” that opens the people list). Hide the message log for managers on the phone, or put it under a text button. It is a record, not a conversation.
- Thread: the other person’s name and role, messages, and a composer fixed above the keyboard and above the tab bar. The composer is one line that grows, plus Send. No field label. Safe area padding under the composer. Sending shows the message in the thread immediately, then confirms when the insert returns; on failure, mark that bubble failed and let them retry. Realtime already reloads `staff_messages`; keep that so the other side appears without a manual refresh. Opening the thread still marks it read locally, and should also clear the tab badge.

Back from the thread returns to the list, not to a stacked page where both are open. The select-and-list-and-thread stack is the current bug.

**P0.**

### Treasury home and one-request screen

Described in section 6. Implementation notes tied to today’s `RateDesk`:

- The queue list uses the waiting rows you already sort oldest-first. The card shows client, pair, amounts, KAM, waiting time (`WaitingSince`), and a primary **კურსის გაცემა** that opens the one-request screen. Do not render `PairBoard`, `ClientHistory`, the reference chips, or the rate input in the list.
- Today’s deals (`desk-day`, table `min-width: 760px`) leave the phone home. Recent activity is a short list. The full table stays on desktop width.
- Better-rate and rate-to-write move up, immediately under the waiting list, and are not under that table.
- English switch: large parts of the queue card are hardcoded Georgian (“კლიენტი ყიდის”, the reference labels, the better-rate hints). When you touch those screens, put those strings through `t()` so the English switch covers the desk. **P1**, done in the same pass as the new cards so you do not translate the old layout twice.

**P0** for the structure, the single Send, and the double-submit lock.

### Treasury lost requests

`LostRequests` is already one card per loss: client, KAM, amounts, reason, and `LossApproval`. Tighten it. Drop the long page intro to one line. On the card show client, pair, amount, KAM, the KAM’s reason, and a primary **დანაკარგის დადასტურება**. The comment field can stay optional and collapsed until they focus it. Delete stays admin-only and is not the primary button. The “client declined and no reason was chosen” explanation becomes one line on that card, not a paragraph on every such card if you can say it once.

**P1.** The screen is already close. It should not block the first phone release if the card’s approve button is obvious. Move the essay-length copy down to **P1**.

### Quoted progress

Read-only cards in `QuoteProgress`: client, pair, rate, status pill, valid-until. Fine as a watch list under More. Remove it from the treasury tab bar. The intro paragraph can shrink to one line. No new actions.

**P1** (placement). **P2** (shorter copy).

### Manager requests

The manager phone home must not be the current `Requests` all-deals list (month select, KAM select, 100-row pages, edit and delete). Give the manager the short home in section 6. The full list remains the desktop page.

**P1.**

### Admin on a phone

Admin sees the treasury home, not a unique admin home. Routes that already use `DesktopOnly` stay there: team, analytics, analysis, KPIs, log, desk history, follow-ups, admin. Do not add them to the phone bar.

**P1** for the nav change. The desk P0s apply whenever an admin uses the desk on a phone.

### Login, second factor, set password

Portrait sign-in on the live site is in good shape at the sizes listed above. Landscape clips the sign-in button because `.auth-wrap` centers a card that is taller than a 390px-tall viewport. Let the page scroll, and align the card to the top when the height is short, so the button can be reached. Same for `SecondFactor` and `SetPassword`, which use the same wrap.

**P1.**

### Desktop-only card

Keep it for analyst and for true desktop tools. The copy can name the screen (“კურსების ჩამოტვირთვა კომპიუტერზეა”) rather than a generic “this part is not on the phone”, so a mistap is understandable.

**P2.**

### Notification bell

On a phone the panel should be a full-screen sheet, not a 360px dropdown that can extend under the tab bar (`.bell-panel` is `max-height: 70vh`, `width: min(360px, 86vw)`, anchored to the bell). The sheet lists notes and holds the push switch. Tapping a note marks it read, closes the sheet, and opens the request detail in section 8. The 38px bell grows to 44px.

**P0** for the read behavior and the tap target. **P1** for the sheet layout.

---

## 8. Notification problems

The report from use matches the code: notes do not stay marked read, on web or on mobile, and push is not a reliable signal. Treat these as separate faults. Fixing the worker will not fix the badge.

### Read state does not persist (P0)

`NotificationBell.mark` and `markAll` write `user_notification_reads` with `upsert` on `notification_id,profile_id`. The table’s grants for signed-in users are select and insert only. There is no update policy. An upsert is an insert-on-conflict-update, so the database rejects it. The component does not read the error. It adds the id to a local `Set`, so the row looks read until the next `load`. `load` runs on mount, on realtime changes to `user_notifications`, and every 30 seconds, and it rebuilds that set from the table. The badge returns.

What “after each entry” does today:

- Opening the bell does not mark rows.
- Tapping a row tries to mark that one row, then navigates away. The write does not stick.
- “Mark all read” uses the same upsert.
- Opening `/requests` or `/rate-desk` from a tab, or from a push, does not mark the notes that pointed there.
- A push tap does not write `read_at` either.

What to build: one server-side mark that inserts the read row for the signed-in person (a conflict does nothing, or it only refreshes `read_at`). Call it when they open that note, when they open that request on the phone or the web, and when a push tap opens that request. Check the error and do not paint the row read if the write failed. Reload must keep showing it read. Web and mobile share this component, so one fix covers both.

Also narrow the note the person marked. The bell’s `href` ignores `request_id`. A KAM always goes to `/requests`. Treasury always goes to `/rate-desk`. A manager’s `client.approved` goes to `/requests`. Anything else goes to `/log`, and `/log` is not a phone page, so a phone tap shows the desktop-only card. Store a phone path that `PhoneGate` allows: the request detail for that id, the better-rate screen, the rate-to-write screen, lost requests, or the chat thread. Do not send a phone user to `/log`.

### Push is a chain, and several links can be open (P0)

A note appears on the lock screen only if every step below succeeds. Check them in this order when push “does not arrive”.

| Step | What has to be true | What we know |
| --- | --- | --- |
| Event saved | `inbox_on_request` or a chat insert | Inbox and chat already write rows. Push does not create a new kind of alert. |
| Trigger | `push_on_inbox` / `push_on_chat` exist | They are in `39_push_subscriptions.sql`. Confirm that file was pasted in the SQL editor. If it was not, nothing calls the function. |
| Subscriptions exist | At least one row in `push_subscriptions` | `queue_push` returns immediately when the table is empty, with no error the user sees. |
| Vault and pg_net | Secret `push_dispatch_token`, extension `pg_net` | If either failed, the SQL file only raises a warning. The inbox row still exists. The push is skipped. |
| Function | `send-push` deployed, JWT verification off | A GET on 15 October 2026 reached the function and returned 405 `Use POST`. JWT is not blocking an anonymous call. Confirm the deployed source is this file, and that `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (`mailto:…`) are set on the function. This machine did not deploy it. |
| Keys match | The public key in the Vercel build equals the function’s public key | The current live bundle contains a public key. If the function secret is a different pair, subscribe succeeds and every send fails. |
| Client subscribed | User tapped the button, allowed permission, and `save_push_subscription` ran | The button is inside the bell. If they never opened the bell, there is no row. |
| Worker delivered | `sw.js` is registered and the push service accepted the send | 404 or 410 deletes the row. The phone can still believe notifications are on. |
| Worker showed it | No focused window of this origin | If the desk is open and focused, the worker returns without showing anything. |
| Tap opened the job | Path is a phone screen for that role and that request | Today the path is a section home, or `/log`. |

**Permission denied.** `PushToggle` shows “turn them on in the browser settings” and hides the button. That is correct. Say which settings: Android Chrome site settings, or iPhone Settings → Notifications → kursi, for the Home Screen app. **P1** copy. The block itself is **P0** only in the sense that a denied phone will never get push; the product cannot override it.

**Expired subscription.** The function deletes the row on 404 or 410. `readPushState` still returns `on` while the browser holds a subscription object. The person sees “Notifications are on for this device” and nothing arrives. When the server drops a row, the client should subscribe again on the next sign-in, or the toggle should stop saying on if a test send cannot be proven. At minimum, do not tell them they are on when the server has no row. **P0.**

**Foreground versus background.** Background (app not focused): the worker can show the note. Foreground: the worker swallows it, and the inbox has no toast. The list may still update (KAM requests poll about every 10 seconds with realtime; the treasury queue polls every 3 seconds). A person who is in chat will not see a new rate. On a phone, show an in-app banner for an inbox event when the app is open, with the same tap target as the push, and still show the system notification when the app is not focused. Do not drop the focused case with no replacement. **P0.**

**Android Chrome.** Can subscribe in the browser tab. Install is not required. The button must be visible without hunting through the bell (put it on More and on first sign-in). **P0** for a visible switch. Permission prompt has to stay in the tap that calls `enablePush` (the code already does this; keep it).

**Installed iPhone.** Web push needs iOS 16.4 or newer and the Home Screen app, opened from the icon, not a Safari tab. `pushSupport` already refuses to prompt in Safari and shows the Add to Home Screen sentence inside the bell. That sentence is easy to miss, it does not say Share → Add to Home Screen, and it does not say the phone needs iOS 16.4. After they install, they still have to open the bell and tap the button. Make that the first-run step on an iPhone that is not standalone, and again the first time the installed app opens, before they are expected to hear about a rate. **P0.**

**Tap target.** Include the request id and the screen: KAM quote → that request’s reply; treasury new request → that request’s rate screen; better rate → that better-rate screen; rate to write → that write screen; loss → lost requests, scrolled to that loss; chat → the thread, which already works via `?with=`. Mark the inbox row read on that open. **P0.**

**Service worker registration.** It runs from `Layout` after sign-in. A signed-out visitor does not register it. That is fine. Confirm in production that `/sw.js` is not cached stale (Vercel already sends `max-age=0, must-revalidate`). There is no `controllerchange` reload; an already-open tab keeps the old page until the next load. **P2.**

**VAPID reaching the client.** `VITE_VAPID_PUBLIC_KEY` must be present at Vercel build time. The current production bundle has one. Empty key shows “შეტყობინებები ჯერ არ არის ჩართული” and `enablePush` throws `unconfigured`. After any key rotation, redeploy Vercel or the phone will subscribe with the old public key. **P0** as an operations check, not a layout change.

---

## 9. Android-specific problems

Android Chrome is a first-class client, including a 360×800 phone. The portrait sign-in captures at 360 and 412 looked the same as the iPhones: the card fits, the button is on screen. Signed-in layout was not clicked.

**Install.** Manifest `display: standalone`, plus 192 and 512 icons, is enough for Chrome to install. The icons do not set `purpose`. Chrome’s mask will crop a non-maskable icon. Add a maskable 192 and 512, and keep a full-bleed “any” icon. **P1.** The gold `background_color` is the splash; the aubergine `theme_color` is the bar. Check the splash on a real device so the K mark is not clipped. **P2.** There is no in-app install button. Chrome’s own prompt is the only one. **P2**, after the phone UI is actually worth installing.

**Standalone.** `start_url` is `/`, which sends a signed-in person to their phone home and a signed-out person to login. Good. The worker does not cache, so airplane mode shows a network error. Do not pretend the desk works offline. **P2** if you later add a one-line offline message.

**Push.** Chrome can subscribe in the tab. The permission dialog must be the direct result of the button tap (already true). A denied permission stays denied until they change site settings. The toggle copy should say that. Notification click uses the worker’s `notificationclick`. On Android, `client.navigate` often works; the postMessage fallback is there if it does not. The tap still opens the wrong screen until section 8 is fixed. **P0** via section 8.

**System navigation versus the tab bar.** Chrome often reports `safe-area-inset-bottom` as 0, and the page does not set `viewport-fit=cover`, so the fixed tab bar sits on the bottom edge. In the browser, the URL bar and the gesture or three-button bar take space and the tab labels can sit under them or feel cramped. In standalone, the gesture bar overlaps a 4px-padded tab bar. Give the tab bar a minimum padding even when the inset is 0, and set `viewport-fit=cover` so a real inset is added on top of that minimum. **P0.**

**Keyboard.** Viewport has no `interactive-widget=resizes-content`. Combined with a fixed tab bar, focusing the rate field or the chat box lets the keyboard cover the field, or leaves the tab bar floating above the keyboard and eating the button. The treasury Send button and the chat composer have to sit in the visual viewport above the keyboard. Hide the tab bar while a field is focused if that is what keeps Send visible. **P0** on the rate screen and on chat.

**Width.** 360px is the tight case for five Georgian tab labels. The new bars use shorter words (საქმე, ახალი, ჩატი, კურსები, სხვა, დაკარგული). Check those at 360 so none wrap. **P1** once the new labels exist. Today’s five-tab wrap is **P1** and goes away with the new bar.

**Landscape.** 412px-wide phones become about 915px wide and currently get the desktop chrome. Keep the phone shell for a coarse pointer even when the width is over 800. **P0** with the iPhone landscape bug. It is one rule.

---

## 10. iPhone-specific problems

Portrait sign-in was checked at 390, 393, 402, and 430. The card fits and the button is visible. Landscape 844×390 clips the sign-in button. Signed-in screens were not tapped.

**Home Screen push.** A Safari tab will not show the enable button. `PushToggle` shows the Home Screen sentence instead, and only inside the bell. Requirements to spell out on that step: iOS 16.4 or later, Share, Add to Home Screen, then open kursi from the icon, then turn notifications on. Until that happens, a KAM on an iPhone gets no push. The in-app bell still updates if they have the site open. **P0.**

**Safe area.** `apple-mobile-web-app-capable` is set. `apple-mobile-web-app-status-bar-style` is not, and `viewport-fit=cover` is not. The CSS insets therefore do nothing. In the installed app the status bar is the default strip, not the aubergine bar, and the home indicator can cover the tab labels. Set `viewport-fit=cover`, set the status bar so the web view can use the safe area, and keep the padding that is already on `.tabbar` and `.page`. Also pad the top bar by the top inset, which the CSS already tries to do. **P0.**

**Keyboard and the home indicator.** The same sticky Send and sticky composer as Android. On iPhone the fixed tab bar commonly jumps above the keyboard and hides the field the person is typing in. Hide the tab bar while the rate field or the chat field is focused, and keep Send in view. **P0.**

**Landscape.** Width 844, 874, or 932 turns off `usePhone`. The person rotates the phone to type a rate and gets the desktop nav and the wide desk. Treat a phone-sized height, or a coarse pointer, as the phone shell. **P0.**

**Login landscape.** The centered auth card is taller than the landscape viewport, so **შესვლა** is cut off. Top-align and allow scroll. **P1.**

**Icons.** `apple-touch-icon` points at `icon-180.png`. That is the right link. The manifest also lists the 180 icon; iOS uses the link tag. No change required for the icon file. **P2** only if the installed icon looks soft; then export a sharper 180.

**Tap from a notification.** iOS is less consistent about `client.navigate` than Android. The worker already falls back to `postMessage` and to `openWindow`. Keep that, and still point the path at the request screen. If the app was killed, `openWindow` of that path must be a URL the signed-in app can route, including the query, without landing on DesktopOnly. **P0** with section 8.

---

## 11. Prioritized implementation plan

P0 means a KAM or ხაზინა should not be asked to work from the phone until it is done. P1 is the next release. P2 can wait. Do the desktop hour-by-hour rates table last, and do not change its columns or its download. Build the phone rates view beside it.

### P0

1. **Phone shell.** Bottom bar as in sections 5 and 6 (KAM, treasury, manager, admin). More holds the rest. Shorter labels. Badge on საქმე and on ჩატი and on დაკარგული. Toast above the bar. Bell and avatar at least 44px. `viewport-fit=cover` and a real minimum bottom inset so the home indicator and the Android gesture bar do not cover the tabs.
2. **Phone detection.** Stay on the phone shell for a landscape phone (coarse pointer or short height), not only `max-width: 800px`.
3. **KAM home, new request, and request detail.** Home is waiting, needs-action, and recent. New request is its own screen with a sticky send. A quoted rate has one primary reply path: Accept, Better rate, Decline, on the detail screen, with Accept prefilled when the rate matches. List cards are compact: client, pair, amount, direction, time, status, rate, one button.
4. **Treasury home and one-request screen.** Waiting list, oldest and late first, compact cards. Better-rate and rate-to-write on the home, not under the today’s table. The today’s wide table is not on the phone. The rate screen has a large decimal field, pair, amount, client, KAM, the existing market lines in compact form, and a sticky Send that stays disabled until the call finishes. The far-from-standard check still requires the second confirmation. Accept, correct, and decline on a better rate get the same in-flight lock.
5. **Chat.** List, then thread. Unread on the list. Composer fixed above the keyboard and the safe area. The sent line shows immediately. Realtime still loads the reply.
6. **Rates on the phone.** Pair selector, Kursi rate, best competitors, one position line, optional provider cards. The downloadable hour table renders only above the phone breakpoint, unchanged.
7. **Read state.** Persist `read_at` with a write the database allows. Mark the note when they open it and when they open that request. Do this on web and mobile. Surface a failure instead of painting the badge clear.
8. **Push tap and push honesty.** Path includes the request and a phone screen that role can open. Foreground gets an in-app banner, because the worker currently shows nothing when a window is focused. iPhone first-run explains Home Screen and iOS 16.4, then the enable button in the installed app. Android can enable from More without opening the bell first. If the server has dropped the subscription, stop saying notifications are on. Confirm in the dashboard: SQL from `39_push_subscriptions.sql` applied, vault secret present, `pg_net` enabled, function secrets set, public key matches the Vercel build.

### P1

- Follow-ups and clients under More; follow-ups as cards; clients as rows, with “new request for this client”.
- Lost-request cards: one approve button, short copy. Quoted progress under More.
- Manager home is a short watch list, not the full history table.
- Admin phone nav matches treasury, with desktop tools left on DesktopOnly.
- English strings on the treasury cards go through `t()`.
- Notification list is a full-screen sheet on a phone.
- Login, second factor, and set password scroll in landscape.
- Maskable Android icons.
- Chat unread stored for the person, not only in `localStorage`, so a second phone does not show old threads as new. Until then, say that unread is per device.
- Permission-denied copy names the real settings screen.

### P2

- Desktop-only card names the screen they tried to open.
- Shorter quoted-progress intro.
- Install splash check, optional in-app “add to home screen” after the phone UI is good, offline sentence.
- Service worker `controllerchange` refresh.
- Tab icons, if the short labels are still slow to scan in a hallway test.

### What not to build on the phone

Analysis, analytics, KPIs, the team page, the agreement log, desk history as a spreadsheet, admin user management, and the hour-by-hour rates grid. Those stay the desktop product. The phone does not get a smaller copy of each of them.
