# Product, UX, and rate-competitiveness audit

Read-only audit of the repo as of 15 October 2026. Nothing in the application, SQL, or git was changed. This document is the spec for a later implementation.

It was checked against the working tree, including the phone work already in progress. `src/lib/nav.ts` is the navigation that matters. The earlier mobile audit described an older phone bar. Do not rebuild that older bar, and do not revert `KamHome`, `KamNewRequest`, `KamRequestDetail`, `PhoneMore`, or `usePhone`.

This session did not query the live database. Where a conclusion depends on rows that may or may not have been stored in production, that is marked as a data gap.

Georgian copy for treasury is **ხაზინა**. Do not introduce სახაზინო.

Roles in `src/lib/types.ts`: `admin`, `manager`, `treasury`, `kam`, `analyst`.

Verified permissions:

- `private.can_see_all()` is admin and manager only (`supabase/migrations/20261006000200_security.sql`).
- `private.can_write()` is admin and KAM. A manager sees deals and does not record win-back steps or edit requests.
- Treasury reads every request through `private.is_treasury()` on `requests_read`, not through `can_see_all()`.
- `public.analyst_deals` is `security_invoker = false` (it runs as the owner) and its `WHERE` is `private.my_role() in ('analyst', 'admin', 'treasury')` (`supabase/migrations/20261012130000_loss_visible.sql`). The analyst does not use `can_see_all()`. The manager is not in that `WHERE`. Treasury is.
- ClickHouse is not a data source. `supabase/migrations/20261008210000_clickhouse_business.sql` says it is not connected and does not copy payments. `public.transactions` is the Excel upload and manual rows the analytics page already uses. Do not design a ClickHouse join.

Currencies on new requests are GEL, USD, EUR, RUB, CNY. Older rows, including GBP, stay in `public.requests` because the three-letter check is not a closed list of those five on the column itself. The analysis list does not filter them out. The market board does not store GBP (`BOARD_CCY` in `fetch-market-rates` is USD, EUR, RUB, CNY only). A GBP request has no competitor comparison.

---

## 1. Current route/navigation inventory

Routes come from `src/App.tsx` and `PAGES` / `NAV` / `PHONE_NAV` in `src/lib/nav.ts`. A role that is not in `PAGES` for a path never gets the route. On a phone, `PhoneGate` replaces any path that fails `isPhonePage` with the desktop-only card. `/security` is outside that gate.

Phone detection is no longer `max-width: 800px`. `src/lib/usePhone.ts` treats a device as a phone when the short side is at most 480 CSS pixels (so landscape phones stay on the phone shell), or when the width is at most 480, or when a non-coarse window is dragged to 800 or narrower. A tablet is not a phone.

Desktop home (`HOME`): KAM `/requests`, treasury `/rate-desk`, admin `/team`, manager `/team`, analyst `/analysis`.

Phone home (`phoneHome`): KAM `/requests` (the new `KamHome`, not the desktop form), treasury `/rate-desk`, admin `/rate-desk`, manager `/requests` (the desktop all-deals page), analyst none.

### KAM

| Path | Page | Real job | Frequency | Destination or status | Nav now |
| --- | --- | --- | --- | --- | --- |
| `/requests` | Desktop: `Requests`. Phone: `KamHome` | See what is open, answer a quoted rate, mark went-through or lost | Many times a day | Destination. The open list is the job. History on the same page is a status archive | Desktop top-level. Phone tab საქმე |
| `/requests/new` | `KamNewRequest` | Ask ხაზინა for a rate | Many times a day | Destination | Phone tab ახალი only. Desktop has no separate route; the form is the top of `Requests` |
| `/requests/:id` | `KamRequestDetail` | One request: reply, edit, outcome | Many times a day | Detail of a request, not a nav item | Phone only |
| `/requests/history` | `KamEarlier` | Earlier requests | A few times a day | Status archive | Phone link, not a tab |
| `/follow-ups` | `FollowUps` | Two jobs. (1) App rows with `outcome = did_not_go_through` and no `loss_reason` in the last 7 days: pick a reason or confirm the payment. (2) `winback_list`: call clients back and set a step | Daily, not the live queue | (1) is a leftover status queue. (2) is a real destination | Desktop top-level. Phone under სხვა |
| `/clients` | `Clients` | Search clients this KAM has requested for (`search_my_clients`) | While starting a request | Directory, not a status | Desktop top-level. Phone under სხვა |
| `/rates` | `MarketRates` | See Kursi against competitors, and download the hour grid | Several times a day as a glance; the grid is not the job | Destination (market), separate data from requests | Desktop top-level. Phone tab კურსები |
| `/team` | `Team` | Own month: turnover, income, win rate, own portfolio, own win-back (`kam_month_summary`, `month_portfolio`, `winback_list`) | Weekly | Report | Desktop top-level (ჩემი ციფრები). Not on the phone |
| `/log` | `RequestLog` | Last 300 own app rows, classified by `classifyRequest`, filter chips | Occasional | Status browser of the same requests | Desktop top-level. Not on the phone |
| `/chat` | `Chat` | Write to a colleague | Throughout the day | Destination | Both |
| `/more` | `PhoneMore` | Clients, follow-ups, notifications, language, password, sign out | Occasional | Menu | Phone tab სხვა. KAM only (`PAGES`) |
| `/security` | `Security` | Password and sign-in | Rare | Account | Avatar, every role |

KAM cannot open the rate desk, lost list, quoted progress, desk history, analysis, analytics, KPIs, or admin.

### Treasury (ხაზინა)

| Path | Page | Real job | Frequency | Destination or status | Nav now |
| --- | --- | --- | --- | --- | --- |
| `/rate-desk` | `RateDesk` | Price the queue. Sections already on one page: waiting (`treasury` queue, oldest first), better-rate with no decision, rate-to-write (client approved, not written), today’s desk table, side column of current market rates | Continuous | Destination. The three queues are statuses inside it | Desktop top-level. Phone tab მაგიდა |
| `/quoted-progress` | `QuoteProgress` | Watch quotes that are still open and are not waiting on treasury: client has not replied, or a better-rate was already answered and is back with the KAM. Excludes rate-to-write, written, lost, and an unanswered better-rate | Several glances a day | Status filter of quoted requests | Desktop top-level. Phone tab მიმდინარეობა |
| `/lost-requests` | `LostRequests` | Approve a loss a KAM already marked (`loss_open`). Approve or comment. Admin may delete | Whenever a loss is waiting | Destination (a decision), not a report of all historical losses | Both. Badge `losses` |
| `/desk-history` | `DeskHistory` | App rows with `rate_written_at` set. They have left the desk | A few times a day | Status archive (the outbox) | Desktop only |
| `/analysis` | `Analyst` | Full deal book from `analyst_deals`: success / lost / open, GEL, loss reason, response minutes. Treasury can read. Treasury cannot correct a row (only an admin, and only while viewing as admin) | Weekly | Report | Desktop only |
| `/rates` | `MarketRates` | Same board and download as everyone else. Treasury and admin may call `fetch-market-rates` | Several times a day, plus the side column on the desk | Destination | Both |
| `/log` | `RequestLog` | Last 300 app rows, all KAMs, status chips | Occasional | Status browser | Desktop only |
| `/chat` | `Chat` | Write to a colleague. Treasury does not see every thread; admin and manager do (`can_see_all`) | Throughout the day | Destination | Both |

Treasury cannot open team, follow-ups, clients, the all-deals Requests page, analytics, KPIs, or admin.

### Admin

Admin has every operational page plus reports and `/admin`. Desktop nav is 15 links. Home is `/team`.

| Path | Page | Real job | Who else has it | Frequency for an admin | Keep as its own top-level link? |
| --- | --- | --- | --- | --- | --- |
| `/team` | `Team` | Every KAM’s month, portfolio, win-back summary | Manager, KAM (own rows) | Daily oversight | Yes. This is the management home |
| `/requests` | `Requests` with `seeAll` | All deals: month, KAM, client-approved block, edit and delete. Not the KAM form | Manager | Daily oversight | Yes, but it is not the KAM home |
| `/rate-desk` | `RateDesk` | Same desk as treasury, plus admin delete | Treasury | When covering the desk | Yes, as the desk, not as four extra links |
| `/quoted-progress` | `QuoteProgress` | Same watch list | Treasury | Glance | No. It is a desk status |
| `/lost-requests` | `LostRequests` | Same approval queue. Admin can delete | Treasury. Manager can open it and cannot approve | When losses wait | No. It is a desk decision, with a badge |
| `/desk-history` | `DeskHistory` | Written rates | Treasury | Occasional | No. Desk outbox |
| `/follow-ups` | `FollowUps` | Company-wide reason queue and win-back. Admin may set a step (`can_write`) | KAM (own), manager (read-only) | Daily | Under team, not beside the desk |
| `/clients` | `Clients` | Search every client | Manager, KAM (own) | While looking someone up | Tab on Requests |
| `/analytics` | `Analytics` | Company turnover and income from `analytics_kpis` (`public.transactions`), treasury speed (`analytics_response_times`), requests by KAM, Excel upload | Manager (no upload). Analyst sees speed and the KAM breakdown only (`seeTransactions` is admin or manager) | Weekly, and when a file is uploaded | Report |
| `/analysis` | `Analyst` | Deal book. Admin may correct amounts through `admin_correct_request` | Treasury (read), analyst (read) | Weekly | Report. Not the same page as Analytics |
| `/kpis` | `Kpis` | Hand-entered plan against actual for business, KAM, and retail (`kpi` plan rows and turnover history). Not computed from the live queue | Manager | Monthly | Report |
| `/rates` | `MarketRates` | Board, hour grid, download, refresh | All five roles | Several times a day | Yes. Different data |
| `/log` | `RequestLog` | Status chips over the last 300 app requests | KAM (own), treasury, manager | Occasional | No. Filter on Requests |
| `/chat` | `Chat` | Every thread, plus a message log for admin and manager | KAM, treasury, manager | Throughout the day | Yes |
| `/admin` | `Admin` | People, counting rules, data sync, message templates, activity audit | Nobody else | Occasional | Yes. Not a report and not the desk |

Phone admin bar today: მაგიდა, მოთხოვნები, დაკარგული, ჩატი, კურსები. That is the desktop desk plus the all-deals list plus the hour-grid page.

### Manager

Manager is read-only oversight. `can_see_all()` is true. `can_write()` is false. The manager is not in `analyst_deals`, so `/analysis` is not in `PAGES` and the view would reject the role anyway. The manager does not get the rate desk, quoted progress, or desk history.

| Path | Page | Real job | Frequency | Nav now |
| --- | --- | --- | --- | --- |
| `/team` | `Team` | Company scoreboard and win-back summary. Cannot set a win-back step | Daily | Home, top-level |
| `/requests` | `Requests` `seeAll` | All deals, filters, no KAM form. Edit and delete are not the manager’s (`can_write` is false; delete stays admin/KAM) | Daily | Top-level. Phone home, and it is the full desktop list |
| `/lost-requests` | `LostRequests` | See losses waiting on ხაზინა. `canApprove` is treasury or admin only | When losses wait | Top-level. Phone tab |
| `/follow-ups` | `FollowUps` | See the reason queue and win-back. Controls are disabled (`canAct` is KAM or admin) | Occasional | Desktop only |
| `/clients` | `Clients` | Search every client | Occasional | Desktop only |
| `/analytics` | `Analytics` | Turnover, income, speed, KAM breakdown. No upload (`isAdmin` gates the file) | Weekly | Desktop only |
| `/kpis` | `Kpis` | Plan against actual. Saving is an admin action in the page’s save path; treat the manager as a reader unless a later check shows a write grant | Monthly | Desktop only |
| `/rates` | `MarketRates` | Board and download. Cannot refresh | Several times a week | Desktop and phone |
| `/log` | `RequestLog` | Status chips, all KAMs, last 300 | Occasional | Desktop only |
| `/chat` | `Chat` | Every thread, plus the message log | Throughout the day | Both |

### Analyst

| Path | Page | Real job | Frequency | Nav now |
| --- | --- | --- | --- | --- |
| `/analysis` | `Analyst` | The deal book. This is the only request list the analyst can read. Filters: status, from, to. CSV download. No row edit | Daily or weekly | Home. Desktop only. Phone is the desktop-only card |
| `/analytics` | `Analytics` | Treasury speed and the KAM request breakdown. Transaction KPIs and the upload are hidden (`seeTransactions` is false) | Weekly | Desktop only |
| `/rates` | `MarketRates` | Board, hour grid, download. Cannot refresh (`canRefresh` is admin or treasury). Granted by `supabase/migrations/20261013190000_analyst_rates.sql` | Several times a week | Desktop only |

The analyst has no phone tabs. Chat push skips an analyst. The analyst cannot read `public.requests` directly; `analyst_deals` is the door.

### Pages that are not navigation

`/security`, login, set-password, and second factor are account screens. They stay off the product nav.

`ViewSwitch` lets an admin look at the app as another role. Phone home follows the role being viewed. A simplification has to hold under view-as, not only for the real role.

---

## 2. Duplication/overlap matrix

Names were not merged on similarity. Each row is what the code actually loads and what a person can do there.

| Current page | Real goal | Overlaps with | Recommendation |
| --- | --- | --- | --- |
| Requests, KAM desktop (`Requests.tsx`, not `seeAll`) | Create a request, answer a quote, mark went-through or lost, see today and earlier own rows | Phone `KamHome` / `KamNewRequest` / `KamRequestDetail` (same data, already split). Log (same rows, status chips). Follow-ups block 1 (a subset with no loss reason) | Keep as the KAM workspace. On desktop, keep new-request on this page. Do not make the phone form the desktop page. Fold the log’s chips into Earlier as filters |
| Requests, admin/manager (`seeAll`) | Oversee every deal | Log. Analysis (richer book, and the manager cannot open Analysis). Lost (pending approval only). Team (month totals, not rows) | Keep as the oversight workspace. It is not the KAM form and must not be the manager’s phone home |
| Rate desk | Give a rate, answer a better rate, mark a rate written, see today | Quoted progress (the quotes that are not on the action lists). Desk history (written rows, including older than today). Pair board on the card (a slice of Rates). Log | Keep one desk. Waiting, better-rate, and rate-to-write stay sections. Quoted progress and written history become tabs of this desk, not nav items |
| Quoted progress | See quotes sitting with the client | Desk “live rates” count. KAM open list (the KAM’s side of the same rows). Log chip “waiting on KAM” | Demote to a desk tab. Remove from the phone bar |
| Lost requests | Approve a loss | Analysis status `lost` (includes approved and historical losses, not a queue). Follow-ups (no reason yet, the opposite end). KAM outcome buttons (where the mark starts) | Keep the queue for treasury and admin. For a manager, a read-only filter on Requests is enough. Do not merge into Analysis: Analysis is the book, this is the inbox |
| Follow-ups, reason block | Attach a reason, or confirm the payment, on a recent miss that has no `loss_reason` | KAM open cards, which already mark lost with a reason (`mark_request_lost` requires one). This list is the older path: `outcome = did_not_go_through` and `loss_reason` is null, last 7 days | Keep the queue until it is empty in practice, as a section of Follow-ups. Do not merge it into Lost. Lost is “reason already chosen, waiting for ხაზინა” |
| Follow-ups, win-back | Work the call list and record a step | Team’s win-back block (same `winback_list`, no step control for a manager) | Keep Follow-ups as the working list for KAM and admin. On Team, leave the summary. Do not show both as equal top-level items for admin |
| Desk history | See rates that were written in the core | Analysis success (wider: written, or `payment_confirmed_at`, or a matched SUCCESS transaction, or a legacy file win). Requests “went through today” | Desk tab “written” for treasury and admin. Do not replace Analysis with it. A written rate is success; success is not only a written rate |
| Log | Scan recent app requests by status | Requests history, quoted progress, lost, desk history | Remove from primary nav. The chips become filters on Requests (KAM, admin, manager). Treasury uses the desk tabs plus Analysis |
| Analysis | Study and export every deal, correct a figure (admin) | Analytics KAM breakdown and treasury minutes (aggregates of related facts). Desk history (written subset). Requests `seeAll` (manager and admin can see rows; the analyst cannot) | Keep. It is the deal book. Manager still does not get this view. The new competitiveness page does not replace it |
| Analytics | Company results from transactions, speed, upload | Team month summary (turnover and income per KAM, from `kam_month_summary`, not from `analytics_kpis`). Analysis (row-level minutes). KPIs (plans, not actuals from this page) | Keep as a report. Do not merge with Analysis or KPIs. The upload stays admin-only on this page |
| KPIs | Enter and read the plan | Analytics actuals. Team actuals | Keep as a report tab next to Analytics. It is a planning grid, not a live desk |
| Market Rates | See the latest board and download stored hours | Desk side column and `PairBoard` (latest quotes for one pair, last two days, 800 rows). The new competitiveness page (history of worse board periods). Not a request status, and not a layer of deals on the board | Keep the page, the hour tables, and the download exactly. The new analysis is a new page. Do not turn this page into the incident dashboard |
| Team | Month scoreboard | Analytics KAM table. Follow-ups win-back. KPIs KAM turnover plan | Keep for admin, manager, and the KAM’s own numbers. Move the KAM’s own numbers out of the primary row |
| Clients | Find a client | The client field on the new-request form (`lookup` / search already there) | Demote to a tab or a search on the request workspace |
| Chat | Talk to a person | Admin message templates (outbound templates, not this thread) | Keep. Do not fold into a request |
| Admin | Accounts, rules, sync, templates, audit trail | Nowhere else | Keep one admin destination |
| Phone KAM home | The same open rows, split into needs-answer, waiting, in progress, recent | Desktop Requests | Keep the phone screens. They are the right split. The bar around them is still too wide |
| Phone rates | Same `MarketRates` component, including `PairHourTable` | Desktop rates | On a phone this page should not be a tab, and it should not render the hour table. Desktop stays as it is |

What must not be merged:

- Analysis and Analytics. One is `analyst_deals` (requests). The other is `public.transactions` plus speed. The analyst cannot see the transaction KPIs. The manager can see Analytics and cannot see Analysis.
- Lost and “lost” in Analysis. One is an approval inbox. The other is a status on the book, including losses ხაზინა has already approved.
- The quoted rate on a request and the Kursi board rate. `requests.rate` is the number ხაზინა typed (`treasury_quote`). `market_rates` where `source = 'kursi'` is the public board. A KAM client is offered that special rate, which can be better than the board. Board competitiveness does not carry request outcomes. An optional quote-versus-competitor list, if built, stays off the board timeline.
- Follow-ups and Lost. See the matrix. They are opposite ends of a loss.
- Team win-back and Follow-ups win-back. Same RPC, different job: a scoreboard versus a call list with `set_winback_step`.

---

## 3. Current user goals by role

**KAM.** Get a rate from ხაზინა, tell the client, record the client’s answer, and close the request as went-through or lost. Between requests, call people back and check own monthly numbers. The market is context, not the job. Chat is how they reach ხაზინა when the queue is the wrong tool.

**Treasury.** Clear what is waiting, in order: a new request, a better-rate, a rate that must be written in the core. Approve a loss. Glance at what is still with the client. Use the board while pricing. Chat when a KAM needs a person, not a form.

**Admin.** All of the above when covering a desk, plus hire and disable people, rules, the transaction file, and the deal book. The current nav makes those equal to “waiting for a rate.”

**Manager.** See whether the book and the team are healthy. Read losses waiting on ხაზინა. Read plans. Talk to the team. The manager does not price, does not approve a loss, does not edit a deal, and does not get `analyst_deals`.

**Analyst.** Explain the book and the market. Read every deal through `analyst_deals`. Read speed. Download rates. Do not operate the desk. The missing market job is when the public Kursi board was worse than competitors. That is a board fact. It is not a list of KAM requests that happened to fall in those periods. A KAM client is offered the rate ხაზინა typed on the request, which can be better than the board.

---

## 4. Proposed desktop information architecture

Navigation is the job. A status of a request is a tab or a filter inside the job that owns it.

The rate grid and its download stay on **კურსები**. The new competitiveness screen is not a mode of that page. It is a report.

### KAM — four items

1. **მოთხოვნები** (`/requests`). Goal: ask, answer, close. Absorbs the log (status chips on Earlier) and Clients (a კლიენტები tab, same `search_my_clients`). The new-request form stays at the top on desktop. Phone keeps its own routes.
2. **დაბრუნება** (`/follow-ups`). Goal: recover a client, and finish a miss that still has no reason. Absorbs nothing else. The win-back table stays here, not on Team.
3. **კურსები** (`/rates`). Goal: read the board and download hours. Unchanged.
4. **ჩატი** (`/chat`).

**ჩემი ციფრები** leaves the primary row. Put it on a quiet **ანგარიშები** item with a single page, or as a link in the header next to the avatar. It is a monthly look, not the desk. Do not place it under Follow-ups.

### Treasury — four items, plus reports

1. **კურსის მაგიდა** (`/rate-desk`). Goal: price and write. Tabs, in this order: ელოდება, უკეთესი კურსი, გასაწერი, კლიენტთან (today’s `QuoteProgress` query), გაწერილი (today’s `DeskHistory` query). Today’s table stays a strip on ელოდება or its own tab, not a second product. The side column (current board, specials, position) stays on desktop.
2. **დაკარგული** (`/lost-requests`). Goal: approve a loss. Badge stays. Not a tab of the desk, because it is a different decision and already has its own count.
3. **კურსები** (`/rates`). Unchanged, including refresh.
4. **ჩატი**.

**ანგარიშები** holds ანალიზი only, for treasury. The log leaves the nav. Treasury does not get Analytics or KPIs; they do not today.

### Admin — six items

1. **გუნდი** (`/team`). Goal: see the team. A დაბრუნება tab opens `FollowUps` for the company. The scoreboard stays the default.
2. **კურსის მაგიდა**. Same tabs as treasury. დაკარგული stays a sibling with its badge, not buried, because admin approves losses too. If six items is too many, დაკარგული is the one that can become a badged tab of the desk. Prefer the sibling: the badge is how losses get seen.
3. **მოთხოვნები**. The `seeAll` oversight page. Clients and the log’s chips are tabs and filters here. This is not `KamHome`.
4. **ანგარიშები**. Tabs: ანალიტიკა, ანალიზი, KPI, and the new competitiveness screen. Three existing report pages plus one new one. They stay separate components.
5. **კურსები**. Unchanged.
6. **ჩატი** and **ადმინი**. ადმინი stays last. Chat can sit with it. That is seven if chat and admin are both counted. Drop nothing operational to get to six: chat and admin are both real. The cut is the status pages, not these two.

Admin primary row after the cut: გუნდი, კურსის მაგიდა, დაკარგული, მოთხოვნები, ანგარიშები, კურსები, ჩატი, ადმინი. Eight is still a lot, and it replaces fifteen. Do not add the old links back “so nothing is lost.”

### Manager — five items

1. **გუნდი**. Home. Win-back on this page stays a summary. Follow-ups is not a second top-level item: the manager cannot record a step. A read-only link from გუნდი is enough.
2. **მოთხოვნები**. Oversight. Pending losses are a filter here (the manager cannot approve). Clients and the log fold in as tab and filter.
3. **ანგარიშები**. Tabs: ანალიტიკა, KPI, competitiveness. Not ანალიზი, until someone deliberately grants `analyst_deals` to the manager. Do not grant it just to fill a tab.
4. **კურსები**. Read and download. No refresh.
5. **ჩატი**.

### Analyst — three items

1. **ანალიზი** (`/analysis`). Home. A summary strip can show the speed numbers that `/analytics` already loads for this role (`analytics_response_times` and the KAM breakdown). The transaction half of Analytics stays hidden, as it is now. `/analytics` does not need its own nav item for this role.
2. **კონკურენტუნარიანობა** (new, proposed `/competitiveness`). Goal: how the public Kursi board compared with competitors. Described in sections 13–16. KAM outcomes are not on this page. An optional, separate view may compare a treasury quote with competitors. It is not this timeline.
3. **კურსები**. Unchanged. The hour grid and the download stay here.

### What leaves primary nav

Quoted progress, desk history, the log, the clients page as a top-level link, KAM “my numbers” as a peer of Requests, and admin’s duplicate copies of those. They remain reachable as tabs or filters. Their queries stay. Their routes can stay for old links and for view-as, and they should not be primary links.

---

## 5. Proposed ultra-light mobile architecture

The phone is for a reaction: something is waiting, send it, or write to a person. It is not a narrow desktop.

Phase 1 already did the right KAM split (home, new, detail, earlier, More) and the right phone detector. This section changes the bar, not those screens.

### KAM — three tabs

**საქმე, ახალი, ჩატი.**

- საქმე is `KamHome`: needs an answer, waiting on ხაზინა, in progress, recent. Badge: rows that need the KAM.
- ახალი is `KamNewRequest`. One submit. Do not also put a second new-request button on the home.
- ჩატი is the thread, not the desktop two-pane stack. Badge: unread conversations.

**კურსები is not a tab.** A KAM does not work the hour grid, and a permanent market tab competes with the three jobs. If a test shows they need a number while typing, show one line on the new-request screen for the pair they picked (Kursi buy or sell, and the best other name), from the same `latestQuotesForPair` data `PairBoard` already loads. That is context on the form, not a destination.

**სხვა** is not a fifth tab either if the header can hold it. Phase 1 already has a More tab. Keep More only as a place for rare items, and do not put it in the thumb row if three tabs fit. Practical recommendation: three tabs in the bar, and the avatar opens More (clients, follow-ups, notifications, language, password, sign out). If the avatar sheet is too small a target, More stays as a fourth tab and Rates still does not.

Clients and follow-ups stay under More, as phase 1 started. They are not bottom tabs. Follow-ups on a phone, if opened, is the reason cards only. The win-back table (`min-width` around 900) stays on a computer.

Do not put team numbers, the log, or history in the bar. Earlier requests stay the link under recent on the home.

### Treasury — three tabs

**მაგიდა, დაკარგული, ჩატი.**

Investigate result:

- **მაგიდა / ჩატი** is not enough. Approving a loss is a treasury action, it already has a badge, and it is not “a report.” It stays a tab.
- **მაგიდა / დაკარგული / ჩატი** is the bar.
- **კურსები** leaves the bar. While pricing one request, show the compact market lines `PairBoard` already has: this pair, Kursi, best other, for the side that matches the request. Not `PairHourTable`. Not `RateCompareCharts`. Not a download.
- **მიმდინარეობა** leaves the bar. It is a watch list. On the phone desk, a collapsed “კლიენტთან” count under the queue is enough. The full cards stay on the computer tab of the desk.
- No history table, no analysis, no analytics, no KPI, no hour grid.

Phone desk, top to bottom: waiting (oldest, late first), better-rate if any, rate-to-write. One card opens one rate screen: large rate, validity, sticky send, in-flight lock. Today’s six-column table does not render.

Account, language, and sign-out stay on the avatar. A More tab is not required.

### Admin

Same three tabs as treasury when the admin is on the phone: **მაგიდა, დაკარგული, ჩატი.** Not მოთხოვნები, not კურსები, not a private admin home. Team, requests oversight, reports, competitiveness, KPIs, the hour grid, and `/admin` stay on a computer. The desktop-only card is the right answer if they open those URLs. View-as stays off the phone, which is already the case.

### Manager

**სტატუსი, ჩატი.** Two tabs.

სტატუსი is a new short list, not `Requests` `seeAll`. Three blocks, each a handful of rows: losses waiting on ხაზინა (read-only), client approvals still unwritten if the manager’s existing query can see them, and today’s new requests. No month filter, no 100-row pages, no edit, no delete. No rates tab. No lost tab: they cannot approve, and the status list is the watch. Analytics, KPIs, team, and the log are not on the phone. Say so on the desktop-only card if a link is opened.

### Analyst

No phone product. Home stays the desktop-only card, with sign out. Competitiveness, analysis, analytics, and rates are computer work. Do not add a “lite dashboard” that shows half the weekly numbers without the method.

### What the phone never gets

The hour-by-hour grid, the download, analysis, analytics, KPIs, competitiveness, team numbers, the agreement log, desk history as a table, quoted progress as a primary tab, admin user management.

---

## 6. Before → after navigation table

Desktop “before” is `NAV` today. Phone “before” is `PHONE_NAV` today, not the older audit.

| Role | Desktop before | Desktop after | Phone before | Phone after |
| --- | --- | --- | --- | --- |
| KAM | მოთხოვნები, დაბრუნება, ჩემი კლიენტები, კურსები, ჩემი ციფრები, ჟურნალი, ჩატი | მოთხოვნები, დაბრუნება, კურსები, ჩატი. Numbers under ანგარიშები or the header. Clients and the log inside მოთხოვნები | საქმე, ახალი, ჩატი, კურსები, სხვა | საქმე, ახალი, ჩატი. More moves to the avatar if the sheet is usable; otherwise სხვა stays and კურსები does not |
| Treasury | კურსის მაგიდა, გაცემულის მიმდინარეობა, დაკარგული მოთხოვნები, ისტორია, ანალიზი, კურსები, ჟურნალი, ჩატი | კურსის მაგიდა (tabs: waiting, better, to write, with the client, written), დაკარგული, კურსები, ჩატი, ანგარიშები → ანალიზი | მაგიდა, დაკარგული, კურსები, ჩატი, მიმდინარეობა | მაგიდა, დაკარგული, ჩატი |
| Admin | 15 links, home გუნდი | გუნდი (with დაბრუნება), კურსის მაგიდა, დაკარგული, მოთხოვნები, ანგარიშები (ანალიტიკა, ანალიზი, KPI, competitiveness), კურსები, ჩატი, ადმინი | მაგიდა, მოთხოვნები, დაკარგული, ჩატი, კურსები | მაგიდა, დაკარგული, ჩატი |
| Manager | გუნდი, მოთხოვნები, დაკარგული, დაბრუნება, კლიენტები, ანალიტიკა, KPI, კურსები, ჟურნალი, ჩატი | გუნდი, მოთხოვნები (losses as a filter, clients as a tab, log as filters), ანგარიშები (ანალიტიკა, KPI, competitiveness), კურსები, ჩატი | მოთხოვნები, დაკარგული, ჩატი, კურსები | სტატუსი, ჩატი |
| Analyst | ანალიზი, ანალიტიკა, კურსები | ანალიზი, კონკურენტუნარიანობა, კურსები. Speed summary sits on ანალიზი | none | none |

---

## 7. Pages to merge

Merge means one workspace, several tabs or filters. Do not delete the queries.

| Into | From | What the person still does |
| --- | --- | --- |
| Rate desk | Quoted progress | Tab კლიენტთან, same `request_outcomes` filter as `QuoteProgress` |
| Rate desk | Desk history | Tab გაწერილი, same `rate_written_at is not null` list |
| Requests (KAM, admin, manager) | Request log | Status chips from `classifyRequest` on the history section. Keep the last-300 limit or replace it with the history paging that Requests already has. Do not keep two lists |
| Requests | Clients | Tab or the existing search. `search_my_clients` stays the query |
| Team, for admin | Follow-ups | Tab დაბრუნება. KAM still has Follow-ups as its own item, because for a KAM it is a daily job and Team is not |
| Reports | Analytics, Analysis, KPIs, and later competitiveness | Tabs. Separate pages and queries. Analysis stays off the manager’s tabs |
| Analyst home | The analyst’s half of Analytics | The speed and KAM-breakdown blocks. Do not move the transaction upload |

Do not merge Analysis into Analytics, Lost into Analysis, Rates into the desk, or the quoted `requests.rate` into the board. Do not attach request outcomes to a board incident.

---

## 8. Pages to demote

Demote means off the primary nav, still available inside a workspace or only on a computer.

| Page | From | To |
| --- | --- | --- |
| Quoted progress | Treasury and admin primary, treasury phone tab | Desk tab. Off the phone bar |
| Desk history | Treasury and admin primary | Desk tab. Off the phone |
| Request log | KAM, treasury, admin, manager primary | Filters on Requests. Off the phone. Treasury uses Analysis for a full scan |
| Clients | Primary for KAM, admin, manager | Inside Requests. Phone: More or the avatar sheet |
| Team, for a KAM | Primary, beside Requests | ანგარიშები or the header. Off the phone |
| Follow-ups, for admin | Primary beside the desk | Tab on გუნდი |
| Follow-ups, for a manager | Primary | Link from გუნდი, read-only. Off the phone |
| Lost, for a manager | Primary and phone tab | Filter on the desktop Requests page. On the phone, rows inside სტატუსი |
| Analytics, for an analyst | Primary | Blocks on ანალიზი |
| Rates, on the phone | KAM, treasury, admin, and manager tabs | Off the phone nav. Desktop page unchanged |

---

## 9. Pages to remove from mobile

Remove from the phone bar and do not render the desktop component in the phone shell.

| Remove from phone | Roles that have it on the phone today | Why |
| --- | --- | --- |
| `MarketRates`, including `PairHourTable` and `RateCompareCharts` | KAM, treasury, admin, manager | Sideways hour grid. The glance a pricer needs is two lines on the request |
| `QuoteProgress` | Treasury | Watch list, not a reaction |
| `Requests` `seeAll` | Admin, manager | Month pages and a hundred-row history |
| `LostRequests` as a working page | Manager | Cannot approve. A status row is enough |
| KAM კურსები tab | KAM | Not one of the three jobs |

Already absent from the phone, and they stay absent: analysis, analytics, KPIs, team, log, desk history, follow-ups as a tab, clients as a tab, admin, competitiveness.

Keep on the phone: KAM home, new request, request detail, chat, treasury desk and one-request pricing, lost approval for treasury and admin, a manager status list, security, the bell.

---

## 10. Rate-history data audit

### What is stored

`public.market_rates` (`supabase/setup/5_kpis_and_rates.sql`, history key in `supabase/setup/7_market_rates_history.sql`):

| Column | Meaning |
| --- | --- |
| `source` | Allowed: `kursi`, `rico`, `myvaluta`, `valuto`, `expresslombard`, `crystal`, `girocredit`, `fxhub` |
| `venue` | Board or bank name, 1–80 characters. Not a fixed list beyond what the fetcher writes |
| `venue_kind` | `board`, `bank`, or `kiosk` |
| `currency`, `quote_currency` | Pair. Base / quote. Quote units for 1 base |
| `buy`, `sell`, `official` | Unconstrained `numeric`. At least one must be present. There is no amount column |
| `fetched_at` | `timestamptz`. Part of the primary key once the history script has been applied: `(source, venue, currency, quote_currency, fetched_at)` |

There is no `request_id`, no client, no KAM, and no deal amount on this table.

`public.market_rate_hours` (`supabase/setup/35_rate_hour_snapshots.sql`): one row per `(source, venue, currency, quote_currency, hour_start)`. `hour_start` is `date_trunc('hour', fetched_at)` in `Asia/Tbilisi`. The latest fetch in that hour replaces the hour. An older fetch does not. Hours with no insert stay missing. The trigger ignores kiosks, venues whose name ends in ` app`, and rows with neither buy nor sell. A backfill copies whatever `market_rates` already holds. It does not invent hours.

`public.reference_rates` is a different table: `source` `standard` or `nbg`, used as the chips on the desk (`standard_rate`, `nbg_rate` on the queue). Those are not competitors.

Request money lives on `public.requests`: `amount`, `gets_amount`, `rate` `numeric(18,6)`, `approved_rate`, `gel_amount` `numeric(18,2)`, `sells_currency`, `gets_currency`, `asked_at`, `quoted_at`, `requested_at`, `request_date`. GEL for the book is `private.request_gel`, unless an admin typed `gel_amount`.

### Who is fetched, and how often the code asks

`supabase/functions/fetch-market-rates/index.ts` loads, in one POST:

- Kursi, from the public Kursi API. `baseCurrencyCode` is the quote.
- Rico. `RUR` is stored as `RUB`.
- Myvaluta banks, and Myvaluta kiosks.
- Valuto.
- Express Lombard.
- Crystal. A ruble published per 100 is stored per 1.
- Giro Credit. Same ruble treatment.
- FX Hub cashless board and its crosses. The cash tab is a kiosk and is not stored.

Kiosk rows are deleted and replaced (`replaceLatest`). They are not on the page and not in `market_rate_hours`. Board and bank rows are inserted. If the primary key does not yet include `fetched_at`, the insert hits a duplicate and the function refuses to delete the old row. The comment in the function says to paste `7_market_rates_history.sql` so each refresh is kept. Until that is true in the database this repo cannot prove, a new fetch is not saved.

Each source in one run shares one `fetched_at` (`new Date().toISOString()`, millisecond text, stored as `timestamptz`). The next source gets a later timestamp, because the stamp is taken inside the loop. A “snapshot of the market” is not one clock time. It is a cluster of stamps a few seconds to a couple of minutes apart. The HTTP timeout on the cron call is 120 seconds.

The cron in `supabase/setup/6_market_rates_schedule.sql` is `*/30 * * * *` (`kam-market-rates`), calling `private.refresh_market_rates()`, which POSTs the function. Admin and treasury can also press განახლება. There is no `DELETE` from `market_rates` or `market_rate_hours` anywhere in `supabase/`. The UI download refuses a range longer than 62 days. That cap is in `MarketRates.tsx`. It is not a retention policy.

Index today: `market_rates_fetched_idx` on `fetched_at`, and `market_rate_hours_hour_idx` on `hour_start`.

### What the screen uses

`/rates` loads `loadRateHours` for today: `market_rate_hours` if the table exists and has rows, otherwise it buckets `market_rates` to one row per Tbilisi hour (`bucketRateHours`, latest `fetched_at` in the hour). `buildCurrentBoard` then keeps, per source identity and pair, the latest of those rows. `RateCompareCharts` draws only `USD/GEL`, `EUR/GEL`, and `RUB/GEL`. `CNY/GEL` and the crosses (`EUR/USD`, `EUR/RUB`, `USD/RUB`, `USD/CNY`, `EUR/CNY`) are in the hour tables when stored, and they are not in the chart.

The download is `buildStoredHourGrid`: columns are hours that exist, Buy and Sell under each hour, five decimal places (`rateText` uses `toFixed(5)`). Empty hours are not filled.

The desk’s `PairBoard` reads `market_rates` for the last two days, limit 800, for one pair and its inverse.

Display of a request rate is also five decimals (`fmtRate`). Stored request rates are `numeric(18,6)`. Market `buy` and `sell` have no declared scale. The chart treats two rates as tied when `toFixed(5)` matches (`sameRate` in `RateCompareCharts.tsx`).

### Buy and sell

From `RateCompareCharts.tsx` and `rateGrid.ts`, and this is the rule to keep:

- A pair `BASE/QUOTE` is how many quote units for 1 base. `USD/GEL` is lari per 1 dollar. `RUB/GEL` on the board is lari per 1 ruble (the fetcher divides a per-100 quote). Do not multiply or divide a ruble board rate by 84.7.
- **Buy** is the rate when the client sells the base to the bureau. A higher buy is better for the client.
- **Sell** is the rate when the bureau sells the base to the client. A lower sell is better for the client.
- If a source publishes the opposite pair, the code inverts (`1/rate`) and swaps buy with sell, inside a plausible band (`SCALE` in `rateGrid.ts`). A Kursi row that was stored on the GEL quote but holds a cross-sized number is relabeled, not inverted.
- Identities in `rowIdentity`: Kursi board, Rico board, TBC, BOG, then Valuto, Express Lombard, Crystal, Giro Credit, FX Hub, then any other `venue_kind = 'bank'` as its own row. Kiosks and `… app` venues are dropped. Two raw rows that map to TBC become one identity.

`dealPair(sells, gets)` turns a request into that pair: both sides foreign → base is what the client sells; client sells GEL → base is what the client gets, quote GEL; otherwise base is what the client sells, quote GEL. `rateUnit` uses the same split: “1 BASE-ზე QUOTE”.

### The ruble rule on a request, not on the board

`private.request_gel` (`supabase/setup/14_analyst.sql`):

- If the GEL side’s amount is filled, that amount is the lari figure. It is not multiplied by the rate.
- If the GEL amount is empty and the other side is RUB and the rate is **below 1**: lari = rubles × rate.
- If the RUB rate is **1 or more**: the lari figure stays empty. A figure like 84.7 is rubles per 1 dollar, not lari per 1 ruble. Do not divide by it and do not multiply by it.
- USD or EUR use amount × rate only when the rate is from 1 to 10. A cross (neither side GEL) has no lari figure from this function.
- A typed `requests.gel_amount` wins over the formula.

The market board’s RUB/GEL rate is already lari per 1 ruble, in the band 0.008–0.15. The 84.7 exception is about `requests.rate`, not about `market_rates.buy`.

### Can history reconstruct competitiveness?

**Only for periods that have stored fetches, and only at the grain those rows actually have.**

- If the history primary key is live and the 30-minute job has been inserting, `market_rates` can rebuild a board about every 30 minutes, clustered by `fetched_at`. That is the series to use. It is reproducible: nothing in the repo deletes those rows.
- `market_rate_hours` can rebuild one point per Tbilisi hour, the last fetch in the hour. A worse patch that started and ended inside the same hour is invisible there. Two polls in one hour become one. This table is the right source for the existing download. It is the wrong source for an incident that is shorter than an hour.
- If production still has the old primary key, later refreshes were skipped and the table holds a single generation of rows. Competitiveness before the history key cannot be reconstructed. Do not backfill invented rates. Do not copy today’s board onto last week.
- This audit did not count rows. The first implementation task in section 20 is to count distinct `fetched_at` per source and day before building the dashboard.

### Can a request be tied to a board incident?

No. A board incident is the public Kursi board against competitors. It has no request on it.

KAM clients are offered a special rate. ხაზინა types it on the desk. `treasury_quote` stores it on `requests.rate`, with `quoted_at`, and inserts a `quotes` row (`action = 'quoted'`). The column comment calls that “the rate treasury gave.” The desk lists those rows as special rates (`last_given_today` is the latest special rate for that direction). `market_rates` where `source = 'kursi'` is the public board, fetched from the public Kursi API. It is not the offer. The special rate can be better than the board. The owner’s operating fact is that KAM requests get that better rate.

A request lost while the board was worse than competitors was not necessarily offered a worse rate. Request counts, amounts exposed, lost deals, and “lost while Kursi was worse” are not facts about that deal. They do not belong on the incident, the chart, or the weekly board questions.

### Optional comparison: the quote, and only the quote

A separate view may compare the rate the client was actually given with the best competitor at that time. It is not a marker on the board timeline, and it is not an incident column.

Include a row only when all of the following are true:

- `requests.source = 'app'`. An imported agreement keeps the rate from the old file. Backfilling `quote_status = 'quoted'` on import does not make that file rate a treasury quote from this desk.
- `requests.rate` is present and greater than zero, and `quoted_at` is set. That is the quote. `approved_rate` is the figure the client accepted when they approved. It does not fill in when `rate` is empty.
- A comparable competitor cluster exists at or before `quoted_at`, and the gap from the cluster to `quoted_at` is at most 45 minutes (the 30-minute schedule, plus slack for a slow run). If the nearest prior cluster is older than that, the row is **no snapshot**. It is not “the quote was fine” and not “the quote was worse.”
- The cluster has at least one competitor on the same pair and the same side (section 11). The Kursi board row in that cluster may be shown beside the quote as the public board at that time. It is not the client rate. If the board row is missing, the quote is still compared with the competitors. If the pair is not one the board stores (GBP, or anything outside the canonical list after orientation), the row is not comparable.

Leave out, and do not fill from the board:

- Still waiting (`quote_status = 'asking'`, no rate).
- Sent back (`treasury_decline` clears `rate`).
- Any other row with no quote.

`quoted_at` and `fetched_at` are both `timestamptz`. The match can be to the second. The economic match cannot, because the eight sources are not stamped together. Use the competitor cluster, not “the single nearest row of any source.”

There is no foreign key from `requests` to `market_rates`. This time comparison is only for the optional quote list. It does not attach the request to an incident.

The request’s GEL figure, when the book has one (`gel_amount` or `private.request_gel`), stays on the analysis page. It is not an “amount exposed” total on a board incident. A RUB quote of 1 or more is not lari per 1 ruble. Do not convert it. Section 11 states the rule.

---

## 11. Exact definition of "Kursi worse"

Compare one side at a time. Never put buy and sell on one signed scale without the flip below. The current chart’s `buyDiff` is `competitor buy − Kursi buy` (positive means the competitor pays more, so Kursi is worse). Its `sellDiff` is `competitor sell − Kursi sell` (positive means the competitor charges more, so Kursi is better). Those two positives mean opposite things. The dashboard must not plot `buyDiff` and `sellDiff` as one Y axis.

“Kursi” in this section is the public board (`market_rates.source = 'kursi'`), unless a sentence names the treasury quote.

### Owner correction

The owner rejected tying KAM deals to board competitiveness. KAM requests get a better rate than the public board. ხაზინა quotes a special rate on the request, and that quote is what the client is offered. The public board can be worse than competitors at the same time the quote is not.

A lost request during a worse board period is not “lost while Kursi was worse,” and it is not “lost because the rate was worse.” The coincidence is not a measurement of the deal. Do not put that metric back as a KPI, a chart overlay, an incident-log column, or a weekly question. The owner rejected the coincidence itself, not only the word “because.”

Keep two separate things:

**A. Board competitiveness.** The public Kursi board against competitors over time. Incidents, the chart, the log, and the weekly board questions carry the board only. No request count, no amount, no lost count, no loss reason, no request marker.

**B. Optional quote comparison.** For a request that has a treasury quote, show that quote against the best competitor at `quoted_at`. A request still waiting, or a deal with no quote, has no client rate. Do not fall back to the board rate and treat it as the offer. Do not draw these rows on the board timeline. Do not say the deal was lost because of the gap. Outcome and loss reason stay on the analysis book.

### Step 1. One comparable observation

A comparable observation is one pair, one side, one cluster:

- Cluster = all board and bank rows with `fetched_at` inside a 10-minute window of each other. A healthy cron run finishes well inside the 120-second timeout, so 10 minutes groups one run and does not group the next half hour. If two refreshes ever land inside 10 minutes (a person pressed განახლება during the cron), keep the later Kursi stamp and the other identities nearest to it, and do not average the two boards.
- Orient each row with the same rules as `orientSnapshot` (canonical pair, invert and swap buy/sell when the stored pair is backwards, relabel a Kursi GEL misfile).
- Collapse venues with `rowIdentity`. Drop kiosks and app venues.
- Kursi is the `kursi` identity. Everyone else in the cluster with a positive rate on that side is a competitor. `reference_rates` and `official` are not competitors.
- Round the comparison the way the screen does: tie when `toFixed(5)` is equal. A difference that exists only past the fifth decimal is a tie, not a miss. Say that in the UI so a sixth decimal in `numeric` is not argued as a loss.

### Step 2. Best competitor

- **Buy.** Best competitor buy = maximum competitor buy. Best is the highest.
- **Sell.** Best competitor sell = minimum competitor sell. Best is the lowest.
- If several identities share that five-decimal rate, the observation is still one best rate. Keep every tied name. The “best competitor” label is those names. Do not pick one arbitrarily for the standing. For a single column, show them joined, and keep the full list on the detail.

If Kursi has no rate on that side, standing is **no Kursi rate**. That is not “worse.” If no competitor has that side, standing is **only Kursi**. That is not “worse.”

### Step 3. Signed advantage

Positive always means Kursi is better for the client. Zero means tied at five decimals. Negative means worse.

- Buy advantage = `round5(Kursi buy − best competitor buy)`.
- Sell advantage = `round5(best competitor sell − Kursi sell)`.

`round5` is the same half-up five-decimal subtraction the chart uses (`gap` in `RateCompareCharts.tsx`), so a printed `0.00000` is zero.

### Step 4. Standing

| Advantage | Standing |
| --- | --- |
| No Kursi rate on that side | no Kursi rate (gap) |
| No competitor rate on that side | only Kursi |
| `> 0` | best |
| `= 0` | tied |
| `< 0` | worse |

**Worse** is only the last row. Tied is not worse. Best is not worse. A pair can be worse on buy and best on sell at the same time. Those are two observations.

### Step 5. Which side a treasury quote uses

Board incidents do not take their side from a request. Buy and sell are two board observations. This step is only for the optional quote comparison.

After `dealPair`:

- The client sells the base (`sells_currency` is the base). The bureau is buying the base. Compare the quote with competitor **buy**. A higher rate is better for the client.
- The client sells the quote (the GEL seller, or the quote side of a cross). The bureau is selling the base. Compare the quote with competitor **sell**. A lower rate is better for the client.

The quote is one number, `requests.rate`. On a buy comparison it stands where “Kursi buy” stands in step 3. On a sell comparison it stands where “Kursi sell” stands. The board’s own buy or sell is not substituted for the quote.

Examples:

| Request | Pair | Side | Quote is worse than the best competitor when |
| --- | --- | --- | --- |
| Sells USD, gets GEL | USD/GEL | Buy | Quote < best other buy |
| Sells GEL, gets USD | USD/GEL | Sell | Quote > best other sell |
| Sells RUB, gets GEL | RUB/GEL | Buy | Quote < best other buy, and only if the quote is below 1 (lari per 1 ruble) |
| Sells GEL, gets RUB | RUB/GEL | Sell | Quote > best other sell, and only if the quote is below 1 |
| Sells EUR, gets USD | EUR/USD | Buy | Quote < best other buy |
| Sells USD, gets EUR | USD/EUR after inversion | Buy of the inverted pair | Higher inverted buy is better; the quote is worse when it is below the best other |

Do not decide the side from the words “buy” and “sell” on the request form. The form says “client sells” and “client gets.” The board’s buy is “client sells the base.”

**Ruble quotes.** The board’s RUB/GEL rate is already lari per 1 ruble. A request rate below 1, on a RUB/GEL deal, is lari per 1 ruble and may be compared with that board. A request rate of 1 or more is not a lari rate. A figure like 84.7 is rubles per 1 dollar. That row is **not comparable**. Do not divide it, do not multiply it, and do not invent a conversion so it can sit next to the board.

### Gaps to show on the board

- **Absolute gap** = the advantage in step 3 (quote units per 1 base), from the board rate. Sign included.
- **Tetri**, only when `quote_currency = 'GEL'`. Tetri per 1 base = advantage × 100. One tetri is 0.01 GEL. A USD/GEL advantage of `−0.00500` is `−0.50` tetri per dollar. Do not show tetri on EUR/USD or USD/RUB.
- **Basis points** = `advantage / Kursi board rate × 10_000`, when the Kursi board rate is not zero. Sign follows the advantage, so buy and sell do not flip. Percent is the same ratio × 100.

The optional quote view uses the same three gaps, with `requests.rate` in place of the Kursi board rate. It does not multiply the gap by the deal size. It does not sum GEL exposure. `private.request_gel` still refuses a RUB rate of 1 or more; that empty lari figure is not filled in here either.

### Language

Say “the board was worse” about the public board. Say “the quote was below the best competitor” or “the quote was above the best competitor” only on the optional quote view, about that quote.

Do not say “lost while Kursi was worse.” Do not say “lost because the rate was worse.” The stored loss reasons stay on the analysis book: `better_rate` (“სხვაგან უკეთესი კურსი” / “Better rate elsewhere”), `postponed`, `funds_not_received`, `liquidity`, `other`. `better_rate` is the KAM’s recorded reason. It is not a board measurement, and it is not proof that the quote lost the deal.

---

## 12. Competitiveness incident methodology

An incident is a run of time on the public board. It is not a poll, and it is not a deal.

### Market incident (A) — the public board

One incident is one pair and one side (buy or sell) of `market_rates` where the Kursi identity is `source = 'kursi'`. No request is part of the incident.

- **Starts** at the `fetched_at` of the Kursi row in the first cluster whose standing is worse.
- **Continues** while each next comparable cluster for that pair and side is still worse.
- **Does not end** only because the best competitor’s name changed. Kursi is still worse than whoever is best. Store the names at the start, at the widest gap, and at the end.
- **Ends** at the `fetched_at` of the first later cluster whose standing is best, tied, or only Kursi.
- **Also ends** when the series breaks. If the next comparable cluster is more than 90 minutes after the previous one, close the incident at the last worse cluster. Do not paint the hole as still worse. Ninety minutes is three missed half-hours, and it matches the old grid’s near-window (`WINDOW_MIN` in `rateGrid.ts`). A missing hour is a hole, not a zero.
- A cluster with no Kursi rate, or with no competitor, is not “better” and not “worse.” It breaks the run the same way a 90-minute hole does.
- Do not open an incident for a single poll that is a tie, best, only Kursi, or a data gap.

**Duration** is from the start `fetched_at` to the end `fetched_at`. When the end is a better or tied cluster, the true flip was somewhere in between. The stored end is the first observation that is no longer worse. Say that on the detail. Do not add a full hour to a `market_rate_hours` row and call it the duration. If the only available grain is the hour table, label the incident “hour grain” and do not pretend it started at `:00`.

**Max gap** is the most negative board advantage in the run: the public board’s widest miss versus the best competitor. It is not the gap on a KAM quote. **Average gap** is the time-weighted mean of the advantage across the run: each cluster weighs the minutes until the next cluster, and the last worse cluster weighs the minutes until the ending observation. If the grain is hourly and timestamps inside the hour were discarded, weight each hour equally and say so. Weight by time only. A request amount is not an input to a board incident.

**Kursi board rate** on the incident is the public board rate at the max-gap cluster, with the start rate and the end rate available on the detail. One number for the whole run hides a move. The log shows the max-gap board rate. The chart shows every cluster. Label it as the board. It is not the rate the client was offered.

### What is not an incident

A request is not an incident and not a marker on one. Do not attach it because `quoted_at` or `asked_at` falls inside a worse board run. Do not attach every request that day. Do not set `loss_reason` from the gap. Do not update `outcome`.

The optional quote comparison in section 10 is a second list. It uses the treasury quote against competitors at `quoted_at`. It does not join the incident. A quote can be better than the best competitor while the board is worse, and a board incident can exist with no quotes at all. Those stay separate.

Deal status (`success`, `lost`, or `open` on `analyst_deals`) is the analysis book. It is not a column of the board incident and not a column of the quote list.

---

## 13. Proposed dashboard

New desktop page, proposed route `/competitiveness`, Georgian title **კონკურენტუნარიანობა**. The first screen answers how the public Kursi board compared with competitors this week, for the owner and the analyst. It is a tab under ანგარიშები for admin and manager, and a primary item for the analyst. It is not in the KAM or treasury nav. Treasury keeps the live board on `/rates` and on the desk. KAM outcomes are not on this screen.

Default range: this week, Monday 00:00 through now, `Asia/Tbilisi`. Default pair: `USD/GEL`. Default side: both, as two series or a side switch, never as one mixed line. Default competitor filter: all.

### KPI row

Show a card only when the range has comparable board observations. Every card is a board fact. This row has no request count, no amount, and no lost count.

| Card | Definition | Hide or dash when |
| --- | --- | --- |
| Time best or tied | Share of minutes in the range whose standing is best or tied, over minutes that had a comparable observation. Holes are not in the denominator | No comparable observations |
| Time worse | Share of those same minutes whose standing is worse | Same |
| Incidents | Count of market incidents that overlap the range | Always, including 0, once the series has been read |
| Minutes worse | Sum of incident overlap with the range, in minutes | Same |
| Median gap, average gap | Of the worse observations only, time-weighted, in quote units. Median of those observations | No worse observation. Do not average in the best hours |
| Max gap | Most negative advantage in the range, with the pair, side, and time | No worse observation |

The three cards that used to sit under that row are removed: requests while worse, value of those requests, and lost while worse. They treated a board period as the rate the client was offered. It was not. Do not add them back under a softer label.

Under the cards, one line: grain used (“30-minute fetches” or “one point per stored hour”) and the share of the range that had no comparable observation. A week that is 40% holes must not read as a calm week.

### Filters

- Today, 7 days, this week, previous week, custom dates. Weeks and “today” are `Asia/Tbilisi`. Custom is inclusive dates.
- Pair. The canonical list that actually has rows in the range, not a hard-coded three. Include `CNY/GEL` and crosses when they were stored. The current chart’s three-pair limit does not apply here.
- Direction: buy, sell, or both.
- Competitor: optional. Filters to incidents and observations where that identity was among the best. It does not recompute “worse than Rico” when Rico was not the best. The definition stays “worse than the best.” The filter only hides runs where this name was never the best.
- There is no KAM filter. The board page has no requests on it. A KAM cut belongs on the analysis book. If the optional quote list is built, a KAM filter there still does not change these incidents.

### Interaction

Hover or click a worse span: cluster time (Tbilisi), pair, side, Kursi board rate, best competitor names, best rate, advantage, tetri if GEL, basis points. The span does not list requests. If the series has a hole, say the hour was not stored. Do not leave the detail blank as if the board was fine.

Click an incident in the log to open the same detail. The chart and the log select the same incident.

---

## 14. Proposed charts

Keep `RateCompareCharts` on `/rates` as the picture of the latest board. Do not extend it into a week by adding a date slider on top of a snapshot chart.

### The week chart

- **X** = time, `Asia/Tbilisi`, the clusters (or the stored hours, if that is all that exists).
- **Y** = signed advantage from section 11, using the public board rate. **0 is tied.** Above 0, the Kursi board is better. Below 0, the Kursi board is worse. Buy and sell use the advantage definition, so a negative sell is a worse sell, not an inverted one. The line is not `requests.rate`.
- One pair and one side per line. USD/GEL and RUB/GEL must not share an axis: a ruble gap is about a tetri, a dollar gap is several. If “both sides” is on, draw two panels, same X, each with its own Y.
- Shade incident spans under the line. Do not shade holes. A hole is a break in the line.
- No second axis. The line is the board gap. Deal size is not on this chart.

### What not to draw

- The existing buy/sell ruler, the provider scatter, and the “plus is not always an advantage” caption. Those explain one snapshot. They are already on `/rates`.
- A pie of “wins.” The time shares are the KPI cards. A pie hides the holes.
- Request ticks, lost or open colors, or any deal overlay on this line.
- A bar of loss reasons. Loss reasons live on the analysis book.

CSV of the chart’s observations is the export. Columns: `fetched_at`, pair, side, Kursi board rate, best competitor names, best rate, advantage, standing. That is the reproducible board series. It has no request id.

---

## 15. Incident log design

Below the chart. One row per market incident that overlaps the filter. Sortable. Filterable by the same pair, side, and competitor filter. Default sort: start, newest first.

Columns, and only these, because each one has a source:

| Column | Source |
| --- | --- |
| Date | Tbilisi date of the start |
| Start | Start `fetched_at`, Tbilisi time |
| End | End `fetched_at`. Blank only if the incident is still open at the last cluster |
| Duration | Minutes between start and end. Footnote on the column: end is the next observation, not the minute the board flipped |
| Pair | Canonical pair |
| Direction | Buy or sell, with the one-line meaning (client sells the base / client buys the base) |
| Kursi board rate | Public board rate at the max gap. Not `requests.rate` |
| Best competitor rate | Best rate at that same cluster |
| Competitor | Names tied for best at the max gap |
| Max gap | Most negative advantage, five decimals, sign included |
| Average gap | Time-weighted advantage |

Client, KAM, amount, outcome, and loss reason are not columns. They are not on the detail either. The columns that used to count linked requests, sum `amount_gel`, estimate a disadvantage from the board gap times the deal size, and split went-through / lost / open are removed.

### Detail

Opens on click.

- The market fields above, plus start rate, end rate, and the competitor names at start and at end.
- Every cluster in the run: time, Kursi board rate, best names, best rate, advantage.

The detail is the market run. It does not list requests, offered rates, amounts, outcomes, `loss_phase`, or loss reasons. No column for “cause.” No edit. No button that writes back to `requests`.

---

## 16. Weekly report design

Same board dataset as the dashboard, for one week against the previous week. On screen, and a CSV (the app already downloads CSV through `downloadCsv`). Excel is the same rows if a later pass wants `.xlsx`. A PDF is not worth a generator: the report is cards, one chart, and the incident table. Print the page if someone needs paper.

Do not build a scheduler, a Monday email, or a cron for this report now. When the on-screen report is trusted, a later note can send the CSV. That is not part of this implementation.

Access: admin, manager, analyst. Not KAM. Not treasury, unless a later decision adds treasury on purpose. The page is the dashboard with the range locked to a week and a previous-week column. It can be the same route with `?week=`.

### A. Board week

These questions are about the public board only.

| # | Question | Answer | If the data is missing |
| --- | --- | --- | --- |
| 1 | How did the board compare? | Time best or tied, time worse, incident count, minutes worse. This week and previous week | “No stored board for this week” if there are no clusters. Do not copy last week |
| 2 | What were the worst board periods? | The incidents, ordered by max gap, then by duration | Empty log, not a placeholder hour |
| 3 | Which pair and direction? | A small table: pair, side, minutes worse, max gap | A pair with no Kursi board rate is listed under gaps, not under worse |
| 4 | Which competitors? | For each worse observation, who was best. The report ranks identities by minutes they were the best while the Kursi board was worse | Names only from `rowIdentity`. Do not invent a provider that was not stored |
| 5 | How big was the board gap? | Median, average, and max advantage on the worse observations. Tetri for GEL pairs. Basis points beside them | Dash when the Kursi board rate is missing |
| 6 | Against the previous week | The same board cards, side by side. Minutes worse, incident count, max gap | If the previous week has no stored board, say so. Do not show a 0% change |

Questions that assumed the board gap explained KAM deals are removed, and they are not renumbered back in:

- Which requests happened while the board was worse.
- How much amount was exposed.
- How many of those were lost.
- What loss reasons were recorded on those requests.

Loss reasons stay on the analysis book. This report does not count them.

### B. Optional quote list

A separate table, not a block under the board chart and not rows inside the incident log. Build it only if someone still wants a request-level rate comparison. It is not required for the board week.

It includes an app request only when `requests.rate` is present and `quoted_at` is set. It compares that treasury quote with the best competitor at `quoted_at`, under the 45-minute rule and the ruble rule in sections 10 and 11. A waiting request, a decline, or any row with no quote is left out. The board rate is not written in as the offer.

The list shows time, client, KAM, pair, side, quoted rate, best competitor names, best competitor rate, and the advantage of the quote. It may count how many quotes were better, tied, worse, not comparable (including a RUB rate of 1 or more), or missing a snapshot.

It does not show outcome, loss reason, amount exposed, or a lost count. It does not say the deal was lost because of the gap.

---

## 17. Required data/backend changes

Prefer no new storage. The snapshots, once kept, are the reproducible history. Recomputing a week from `market_rates` does not use today’s board for yesterday’s clusters, because each cluster reads the `buy` and `sell` stored at that `fetched_at`.

### Confirm before building

In SQL, not in the app:

- Does `market_rates`’s primary key include `fetched_at`?
- For a recent weekday, how many distinct `fetched_at` values does `source = 'kursi'` have, and what is the typical gap?
- Does `market_rate_hours` exist, and does it have more than one `hour_start` per pair?

If the key includes `fetched_at` and a trading day has many Kursi stamps about 30 minutes apart, **no new rate table is required.** Historical competitiveness can be computed from `market_rates`.

If the day has one stamp, history was not kept. The smallest safe addition is operational, not a new design: apply the history primary key (`7_market_rates_history.sql` / `20261006001900_market_rates_history.sql`) if it is not applied, confirm the cron and the function, and let new fetches append. Past days with no rows stay blank. Do not synthesize them from `market_rate_hours` and call them 30-minute incidents. The hour table remains a fallback grain, labeled as such.

### What to add when the rows exist

A security-definer function, not a client loop over 20,000 rows:

1. **`private.market_clusters` logic** (a SQL function or a view the function uses). Reads `market_rates` for board and bank, excludes kiosks and `% app`, orients pairs the way `orientSnapshot` does. The orientation rules today live in TypeScript and in the fetcher. The SQL must follow those bands and the Kursi misfile, or the dashboard will disagree with `/rates`. Port the rules. Do not invent a simpler invert.
2. **Standing function** implementing section 11, including five-decimal tie.
3. **Incident function** implementing section 12, for a `tstzrange`. Returns the board log columns. Stable incident identity: `(pair, side, start fetched_at)`. That identity does not need a table. It is stable as long as the underlying rows are not deleted. Nothing in the repo deletes them. The function does not read `requests`.
4. **Optional quote function**, only if section 16.B is built. A separate function. It reads app requests that have `rate` and `quoted_at`. For the analyst this has to be security definer, because the analyst cannot select `public.requests`. It compares `requests.rate` with the best competitor in the prior cluster, using the 45-minute rule and the ruble rule. It returns the quote, the competitor rate, and the advantage. It does not return outcome, loss reason, or amount totals. It does not join incidents. It does not write `requests`. If this view is not in the build, do not add a stub that counts requests inside incidents.

An incident table is not required for correctness. Add one later only if a week query is too slow after the indexes in section 19, and then fill it from the same function so a rebuild matches the screen. A stored incident must keep the `fetched_at` values it was built from. Do not store only the rates and recompute the gap from a later board.

Do not add a request column such as `worse_at`, `lost_while_worse`, or a board-gap flag on `requests`. That would freeze the coincidence the owner rejected.

`market_rate_hours` stays the download’s table. Do not change its trigger, its replace-within-the-hour rule, or the CSV columns.

`analyst_deals` stays the deal book. Do not add manager to its `WHERE` as a side effect of this page. The board function does not need the deal-status `CASE`. The optional quote function does not return that status either.

---

## 18. Permission model

| Capability | Admin | Manager | Analyst | Treasury | KAM |
| --- | --- | --- | --- | --- | --- |
| Read `market_rates` and `market_rate_hours` | Yes, already | Yes, already | Yes, already | Yes, already | Yes, already |
| Refresh the board | Yes | No | No | Yes | No |
| Download the hour grid | Yes | Yes | Yes | Yes | Yes, on desktop |
| New competitiveness page, board incidents, weekly board report | Yes | Yes | Yes | No | No |
| Optional quote list (quoted rate vs best competitor only) | Yes, if that list is built | Yes, if that list is built | Yes, if that list is built | No | No |
| See only own requests on that page | n/a | n/a | n/a | n/a | Do not build a KAM cut. The page is not theirs |
| `analyst_deals` | Yes | No. Leave it that way | Yes | Yes, already | No |
| Approve a loss | Yes | No | No | Yes | No |
| Phone access to competitiveness | No | No | No | No | No |

The board function checks `private.my_role() in ('admin', 'manager', 'analyst')` and returns nothing otherwise. It reads `market_rates` only. Table RLS on `market_rates` is not enough on its own for a security-definer function, because a KAM may already select that table and a definer function would bypass RLS. The role check has to be inside the function.

The optional quote function, if it exists, uses the same role check and is security definer so the analyst can read the quote fields. It returns the quote and the competitor rate. It does not return outcomes. A manager may see that list even though the manager is not on `analyst_deals`. That is a narrower door than adding the manager to `analyst_deals`. Do not grant `analyst_deals` in the same change. Do not justify the function as a way to see which deals were lost while the board was worse.

KAM and treasury keep the raw board they have today. They do not get the incident log or the weekly board totals. A treasury pricing screen may still show “best other right now” for the pair in hand. That is the live `PairBoard`, not this report, and it is not the special rate stored on the request.

---

## 19. Performance considerations

A trading day at a 30-minute cadence is about 48 clusters. Each cluster is a few dozen board rows plus Myvaluta banks. A week is tens of thousands of `market_rates` rows at the top end, not millions. A year is comfortable in Postgres if the filter is selective. Do not add another database.

- Add an index on `market_rates (fetched_at, source, currency, quote_currency)` including `buy`, `sell`, `venue`, `venue_kind`, or a plain btree the planner can use for `fetched_at` range plus `venue_kind in ('board','bank')`. The existing index is only `fetched_at`. Measure before adding a second one if that index already serves the range scan.
- `market_rate_hours (hour_start, currency, quote_currency)` matters only for the hour-grain fallback and for the existing download.
- Compute incidents in SQL. `MarketRates.tsx` already pulls pages of 1,000 up to 20,000 rows into the browser for the grid. The dashboard must not do that for a quarter.
- Cache a week response on the client for the session. Do not materialize it in a table in the first version.
- The incident scan is one ordered pass per pair and side after the clusters are built. It is a window on `fetched_at`. It does not join `requests`. The optional quote comparison, if built, is a separate query: the latest competitor cluster at or before `quoted_at`, only for app rows that already have a rate. It is not on the incident path. Index `requests (quoted_at)` only if that separate query needs it. Check existing indexes first. `requests_app_quoted_at_idx` is already specified for the desk.
- Holes make the query faster, not slower. Do not fill them.
- RLS and security definer: the function should read `market_rates` as the owner and still filter the role, so the analyst path does not depend on a policy that was written for the grid. Revoke execute from `anon`. Grant to `authenticated`.
- Do not recompute a closed week with a later orientation rule without saying the rule changed. If `SCALE` or the misfile logic changes, old weeks can change standing. Pin the rule version in the function comment. Stored rows stay. Only the interpretation moves, and that should be a conscious change.
- The 62-day download cap is a UI limit. The competitiveness page should default to a week and refuse an unbounded “all time” on the first load. A custom range up to 92 days is enough for a quarter. Longer can be a CSV from the function, not a chart of every cluster.

---

## 20. Recommended implementation phases

### P0 — Navigation and workflow

Desktop: cut primary nav as in sections 4 and 6. Desk tabs for quoted progress and written history. Requests absorbs the log’s filters and client search. Reports group for Analytics, Analysis, and KPIs. No new rate math.

Phone: KAM bar to საქმე, ახალი, ჩატი. Treasury and admin to მაგიდა, დაკარგული, ჩატი. Manager to a status list and ჩატი. Analyst unchanged (no tabs). Remove the hour grid from every phone route. Keep phase 1’s KAM screens and the short-side phone detector.

Do this before the competitiveness page so the new report is not a seventeenth admin link.

### P1 — Rate-competitiveness data foundation

Count production `fetched_at` values. If history is missing, apply the existing history key and confirm the 30-minute job. Do not backfill.

Port orientation and the board standing in section 11 (steps 1–4) and the incident rules in section 12 into SQL functions. Step 5 is the optional quote list only. Do not port it into the incident function. Add the index the range scan needs. No dashboard yet. A SQL check: for one known hour, the function’s Kursi board rate and best-competitor rate match the hour grid’s five decimals when both are looking at the same fetch.

### P2 — Dashboard and incident log

The page in sections 13–15, for admin, manager, and analyst. Chart, board cards, log, detail. No request markers. No “lost while the board was worse” copy.

### P3 — Weekly report

The board questions in section 16.A, this week against the previous week, plus CSV. The optional quote list in section 16.B is not part of this report. No email and no scheduler.

### P4 — Polish, not this project’s build

Avatar sheet versus a More tab on the KAM phone. One market line on the KAM new-request form. A stored incident table if P2 is slow. The optional quote-versus-competitor list (section 16.B), as its own table, using `requests.rate` only, not on the board chart. A Monday CSV later. English strings on any new treasury card, through `t()`. None of these block P0–P3.

### Sequence

P0 first, because the nav is in the way of every role this week and does not depend on rate history. P1 next, because P2 is false if the fetches were not kept. P2 when a sample week matches the grid. P3 when the cards are believed. P4 after someone has used the report.

---

## Data gaps (do not paper over)

- Production may still be on the old `market_rates` key. Then there is no history to analyze. The code path that skips a duplicate insert is the evidence, not a row count.
- Sources in one refresh do not share `fetched_at`. A cluster is an approximation of “the same run.”
- The hour table destroys intra-hour moves on purpose.
- `RateCompareCharts` ignores CNY and crosses. The stored grid may still have them. The new page should follow the rows, not the chart’s three pairs.
- GBP has no competitor pair on the board. A GBP request is not comparable.
- A RUB request rate of 1 or more is not lari per 1 ruble and has no GEL figure from `private.request_gel`. The board’s RUB rate is lari per 1 ruble. Do not convert one into the other.
- `requests.rate` is the treasury quote. It can be better than `market_rates` where `source = 'kursi'`. This audit did not compare live rows. The product stores them as different numbers, and the owner’s fact is that KAM clients are offered the quote. Board incidents do not include requests.
- `loss_reason = better_rate` is the KAM’s statement. It is not a measurement that the board was worse, and it is not a measurement that the quote was worse.
- Manager is not on `analyst_deals`. Leave that view as it is. The optional quote function, if built, is the narrow door for a quote-versus-competitor list. It is not a door onto lost deals. Do not open the whole analysis view to fill it.
- ClickHouse was never connected. Went-through for a matched payment means `public.transactions`, the upload the analytics page already runs. That status is the analysis book, not a competitiveness column.
