# Phase 1 performance changes

Client-only. No commit, no deploy, no database migration.

This matches Phase 1 in `PERFORMANCE_AUDIT.md` (issues 2, 3, 4, 5, and 9): stop repeated work on the rate desk, the KAM request page, and the header, without changing RPCs, RLS, or what each button does.

## Files planned before editing

| File | Why |
|---|---|
| `src/lib/useLive.ts` | One shared Realtime channel per table list, and coalesce bursts so focus, visibility, the safety poll, and many row changes become one reload. |
| `src/pages/RateDesk.tsx` | Keep the 3-second `treasury_queue` check, skip `setQueue` and the bank/outcomes follow-up when the cards are unchanged, keep the slower reload for the rest of the desk, and move the waiting clock out of the page render. |
| `src/pages/Requests.tsx` | Reload a KAM’s open cards on Realtime and a short poll. Stop reloading history on every quote. |
| `src/components/Layout.tsx` | Stop running header badge counts on every `requests` change. Keep the same count queries on a slow poll. |
| `PHASE1_PERFORMANCE_CHANGES.md` | This note. The only new file. |

## Files changed

- `src/lib/useLive.ts`
- `src/pages/RateDesk.tsx`
- `src/pages/Requests.tsx`
- `src/components/Layout.tsx`
- `PHASE1_PERFORMANCE_CHANGES.md` (this file)

## Previous behavior

**Rate desk.** `refreshQueue` called `treasury_queue`, then `closedIds` (`request_outcomes`, with a `requests` fallback), then `setQueue` with a new array every time. A 3-second timer called that. Because the array was always new, an effect refetched banks from `requests` and earlier-deal marks from `request_outcomes` on every tick, even when the waiting list had not changed. `useLive(['requests'], load, 15000)` called the full `load()` (queue again, quotes, replies, another outcomes read, seven day slices, loss reasons, rate names) on every `requests` change, every 15 seconds, on focus, and when the tab became visible. `useTick(10000)` re-rendered the whole desk so “ელოდება N წთ” stayed current.

**Live hook.** Each caller opened its own channel (`live-<tables>-<random>`). The header and the open page both listened to `requests`. Every insert, update, and delete called `reload` immediately, and a burst could start several overlapping reloads. The payload was ignored.

**KAM requests.** `useLive(['requests'], …, 20000)` called `load()`, `loadHistory()`, and `loadApproved()` together on every request change and every 20 seconds. History is `request_outcomes` with an exact count. Open cards and “went through today” share one query: that KAM, today or still asking.

**Header.** `useLive(['requests'], loadCounts, 60000)` ran `data_freshness` and up to three exact counts (queue on `requests`, losses and follow-ups on `request_outcomes`) on every request change and every 60 seconds.

## New behavior

**Waiting list.** Every 3 seconds the desk calls `treasury_queue` only. It compares request ids and the fields drawn on the card. `waiting_seconds` is ignored, because that number changes on every read and is not shown. If the cards would look the same, it does not call `setQueue`, does not call `closedIds`, and does not run the bank or outcomes effect.

If the returned rows differ, it still filters with `closedIds` and updates the list. The 15-second reload, a coalesced Realtime event, focus, and visibility use a full queue check, so a row that `treasury_queue` still returns but outcomes now treats as closed still leaves the list on that slower path.

A full check and a 3-second check do not run two `treasury_queue` calls at once. If one is in flight, the next request waits and keeps the stronger mode (a full check is not dropped behind a light one). An older result does not paint over a newer one.

Quotes, replies, today, and loss reasons update state only when the fetched value differs, so an unchanged safety reload does not redraw those blocks.

Banks and “hide earlier deals” still load when the visible id set changes. They also load when the slow desk reload finishes (`sidesTick`), so a bank edit or a closed mark still arrives on Realtime or within about 15 seconds, not only when the waiting-card text changes. The 3-second timer does not bump that tick.

**Waiting clock.** `WaitingSince` ticks every 10 seconds and updates only the pill (“ახლახან” or “ელოდება N წთ”), the “ახალი” pill, and the card’s `new` / `late` border. The rate box, today table, and market board do not re-render for that clock. Georgian wording is unchanged and is not passed through translation.

**KAM requests.** Realtime and a 10-second poll call `load()` only (open cards and “went through today” for that KAM). History loads when the page opens, when the month, KAM, or page size changes, when “მეტის ჩვენება” increases the range, and when the existing `refresh()` runs (edit, delete, outcome). The approved/admin list (last 7 days, limit 40) reloads on open, on `refresh()`, on focus, when the tab becomes visible, and every 60 seconds. It does not subscribe to Realtime. An unchanged open, history, or approved payload does not replace state.

**Header.** Badge counts and `data_freshness` run on mount, every 60 seconds, on focus, and when the tab becomes visible. They do not run on `requests` Realtime. The count queries are the same, so each badge still means the same thing. The fast operational queue is the desk’s 3-second `treasury_queue` check, not this exact count.

**Realtime.** Still on. Callers of the same table list share one channel. A burst is one reload: 500 ms after the latest signal, and at most 2 seconds after the first signal in that burst. A reload already running is followed by at most one more. Focus, visibility, and the safety poll are unchanged in purpose and go through the same coalesce. `{ realtime: false }` keeps the poll, focus, and visibility without a subscription (header badges, and the approved list).

Other `useLive` screens (quoted progress, lost requests, desk history, the log, chat, the bell) keep their own poll intervals and now coalesce the same way. Chat paging was not rewritten.

## Polling intervals

| What | Interval | Realtime |
|---|---|---|
| Rate desk waiting list (`treasury_queue`) | 3 seconds | No. The list is the 3-second check. A full queue check also runs inside the 15-second desk reload. |
| Rate desk quotes, replies, today, banks, earlier-deal marks | 15 seconds, plus focus and visibility | Yes, coalesced. Does not run on the 3-second timer. |
| Rate desk market board | 5 minutes | No. Unchanged. |
| Waiting clock (“ელოდება N წთ”) | 10 seconds, inside `WaitingSince` only | No |
| KAM open cards and “went through today” | 10 seconds, plus focus and visibility | Yes, coalesced, and only while the role is KAM |
| Request history | None | No. Open, filters, “more”, and `refresh()` only. |
| Approved list (admin/manager) | 60 seconds, plus focus and visibility | No |
| Header badges and transaction freshness | 60 seconds, plus focus and visibility | No |
| KAM “time ago” on open cards | 15-second `useTick` on the page | Unchanged. The clock was not split out. |
| `useLive` coalesce window | 500 ms, max wait 2 seconds | Applies to every `useLive` caller |

## Realtime behavior

- Subscriptions stay. Nothing was removed from the publication, and no column filter was added.
- One channel per table list (`live-requests`, and so on). The header no longer opens a second `requests` channel beside the page.
- Ten quick `requests` changes schedule one reload, not ten. If that reload is still running, one follow-up runs after it.
- The rate desk’s Realtime reload is the quotes/replies/today load, not the 3-second queue poll.
- A KAM’s Realtime reload is the open-card query only.
- History and header badges do not listen.

## Safeguards retained

- 3-second waiting-list check. The interval was not increased.
- 15-second safety reload of quotes, replies, and today. Not removed.
- Focus reload and visibility reload on the desk, on KAM open cards, on the approved list, and on header counts.
- Safety polls on every other `useLive` screen.
- New-request toast when a waiting card appears that was not there on the previous applied list.
- Queue generation so a slower result does not overwrite a newer waiting list.
- KAM history filter: before today, plus today’s imports that did not go through, and only `kam_id` of the signed-in KAM.
- Admin and manager history: every deal, optional KAM and month filters, exact count, page size 100.
- Header count filters: queue (asking, open better-rate, or approved; not written, not paid, and not marked lost when that column exists), open losses, and follow-ups for the last 7 days.
- Quote, decline, better-rate, mark-written, and client-reply calls still invoke the same RPCs and then a full desk or request reload.
- `draftRate` still sends the rate that was typed, including after a validity click.
- Loading copy stays `LoadingLine` / “იტვირთება”. Treasury copy stays ხაზინა / ხაზინის / ხაზინას.

## Remaining risks

- A waiting row that `treasury_queue` still returns with the same card fields, but which outcomes would now hide, stays on screen until the next full queue check (about 15 seconds, or the next coalesced Realtime/focus/visibility reload). Leaving the queue because the quote status is no longer `asking` still shows up on the next 3-second read.
- History for an admin or manager does not move until they open the page again, change month or KAM, ask for more rows, or hit an action that calls `refresh()`. A deal logged while they sit on that list can be missing until then.
- The approved list can be up to about 60 seconds behind, sooner on focus or visibility. It is not on Realtime.
- Header badges can be up to about 60 seconds behind, sooner on focus or visibility. The desk waiting list is not waiting on that badge.
- The open-card query is still `select('*')` on `request_outcomes`. It is no longer tied to the history exact count, and it is still heavier than a narrow read. That narrower read is Phase 2.
- Today’s desk list is still seven outcome slices. Also Phase 2.
- A failed 3-second poll still toasts every failure. A down database can stack the same error. Not part of Phase 1.
- `useLive` now delays a single event by about 500 ms. A continuous burst still reloads within about 2 seconds, then once more if a reload was already running.
- At midnight, the desk date line and “today” filter update on the next data refresh (the 15-second reload, or a waiting-list change), not on the old 10-second page tick.

## Deliberately not changed

- No SQL, no migrations, no RLS, no role rules.
- `request_outcomes` column order and names.
- `log_request` argument names.
- `treasury_quote`, `treasury_decline`, `treasury_answer_better`, `treasury_mark_rate_written`, `kam_client_reply`.
- Written-rate success, confirmed-payment success, and loss approval.
- `SECURITY DEFINER` on `analyst_deals` and `request_rate_names`.
- The seven day slices, indexes, route lazy-loading, phone layout, and chat paging (later phases).
- The market-board 5-minute reload and its row cap.
- `Requests.tsx` was not rewritten to isolate “time ago”. The 15-second tick still re-renders that page. Only the desk clock was split out.
- Notification read marks are still unbounded.
- `StrictMode` in `src/main.tsx`.
- No commit, push, or deploy.

## Checks

After each logical step, `npx tsc --noEmit` and `npm run build` both succeeded:

1. `useLive` coalesce and shared channel
2. Rate desk queue compare, split reload, and waiting clock
3. KAM open cards vs history vs approved
4. Header badges off Realtime
5. Bank and earlier-deal marks kept on the slow desk reload, not on the 3-second timer
