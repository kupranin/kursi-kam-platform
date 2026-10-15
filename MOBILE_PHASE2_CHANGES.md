# Mobile Phase 2 — Treasury

Phone treasury now has its own desk. The desktop rate desk is unchanged and is not mounted on the phone.

Fixture preview (`?preview=phone`, `?preview=desk`, and the preview role switch) was used only for screenshots and is removed. `npx tsc --noEmit` and `npm run build` both passed after that removal. Local Vite has no Supabase keys, so none of the live treasury actions were exercised against the database.

## 1. Files changed

- `src/lib/nav.ts` — treasury phone tabs are Desk, Chat, More. Treasury More pages stay authorized. Desktop `NAV` is unchanged. KAM, admin, manager, and analyst phone tabs are unchanged.
- `src/App.tsx` — `/rate-desk` is `/rate-desk/*` and renders `RateDeskSwitch`.
- `src/pages/RateDeskSwitch.tsx` — phone treasury and phone admin get the mobile desk. Everyone else gets `RateDesk`.
- `src/components/mobile/TreasuryHome.tsx` — mobile home.
- `src/components/mobile/TreasuryQuote.tsx` — send a rate.
- `src/components/mobile/TreasuryBetter.tsx` — answer a better-rate request.
- `src/components/mobile/TreasuryWrite.tsx` — mark a rate written.
- `src/components/mobile/TreasuryBits.tsx` — shared facts and the waiting clock.
- `src/components/mobile/treasuryLoad.ts` — the same queue reads the desktop desk already uses, plus placement so one request is not shown twice.
- `src/components/mobile/useTreasuryDesk.ts` — the existing 3-second waiting-queue check and the 15-second reply refresh.
- `src/components/mobile/PhoneMore.tsx` — treasury More menu. Other roles keep the existing KAM menu.
- `src/components/Layout.tsx` — Desk stays selected on `/rate-desk/*`. More stays selected for treasury secondary pages and password. Nested desk screens title as მაგიდა until the screen sets its own title.
- `src/styles.css` — treasury phone scrollport, rate field, fact rows, and reference chips. Phone-only. `RateDesk.tsx` was not edited.

## 2. Treasury mobile navigation

Treasury phone bar is exactly three tabs:

- მაგიდა — `/rate-desk` (home)
- ჩატი — `/chat`
- სხვა — `/more`

More keeps the treasury workflows that used to be tabs: დაკარგული მოთხოვნები, მიმდინარეობა, ისტორია, კურსები, ჟურნალი, plus notifications, language, password, and sign-out. Analysis stays off the phone. Authorization is unchanged: those routes were already in treasury `PAGES`, and `/more` was added there so the tab is allowed. Desktop `NAV` still lists the full treasury bar and does not list More.

KAM stays საქმე, ახალი, ჩატი, სხვა. Admin and manager phone bars were not rebuilt. An admin on a phone who opens მაგიდა still gets this treasury desk, because the desk route is shared. Lost requests and rates stay on the admin bar, so they are not hidden by the treasury More menu.

## 3. Desk structure

`TreasuryHome` answers what needs action now. It does not mount `RateDesk`.

- კურსს ელოდება — `treasury_queue`, oldest `asked_at` first. Client, pair and direction, amount, bank, KAM, waiting time, one action კურსის გაგზავნა.
- უკეთესი კურსი — client replies with `client_reply = better` and no decision yet. Original rate, requested rate, pair, amount, KAM, elapsed time, one action პასუხი. Oldest `client_replied_at` first.
- დასაწერია — approved replies still open. Client, accepted rate, amount, KAM, one action კურსი ჩაიწერა.
- დაკარგული — a count from the existing pending-loss read, and a link to `/lost-requests`. No loss table on the home.

`placeQueues` drops a waiting row that is already in a later section. A better-rate row and a write row are different `client_reply` values on the desktop desk, so they do not share an id. If they ever did, the write row is the one that stays.

## 4. Rate-entry interaction

Tapping a waiting card opens `/rate-desk/quote/:id`. The screen shows the client, pair, amount, direction, bank, KAM, request note, and the reference chips already on the queue row (standard, NBG, last given today, last for this client). It does not mount the market-rate hour grid or the pair board.

The rate field uses `inputMode="decimal"`. Display and validation stay on `fmtRate` (5 decimals) and `parseRate`. Validity is 5, 15, or 30 minutes, defaulting from `rules.default_quote_minutes` the same way the desktop card does. The primary button is კურსის გაგზავნა. A rate more than 3% from the standard rate asks for მაინც გაგზავნა before send. The button is disabled while `treasury_quote` is in flight, and a lock blocks a second submit. Decline (კურსს ვერ ვიძლევი / `treasury_decline`) is a separate step, not shown beside the rate form. After success the existing toast is raised and the screen returns to the desk. The quote RPC name and arguments are unchanged: `p_request_id`, `p_rate`, `p_valid_minutes`.

## 5. Better-rate interaction

`/rate-desk/better/:id` shows the original treasury rate, the client-requested rate, amount, client, pair, and KAM. The first step offers three actions and no forms: მოთხოვნილი კურსის მიღება, სხვა კურსის შეთავაზება, უარი. Choosing a corrected rate or a decline opens that step alone. Accept, correct, and decline call `treasury_answer_better` with `accepted`, `corrected`, or `declined`, the same arguments as the desktop desk. A lock blocks a second submit. The mobile screen does not include the quoted-rate editor.

## 6. Rate-written interaction

`/rate-desk/write/:id` confirms the existing `treasury_mark_rate_written` call. The button is კურსი ჩაიწერა. The copy says writing the rate tells the KAM the rate is written, and that this does not confirm payment and does not mark the deal successful. The desktop button label is still კურსი გაწერილია.

## 7. Lost-approval access

The home shows the pending count and links to `/lost-requests`. More links to the same page. `LostRequests` and `LossApproval` are unchanged. `canApprove` is still the real role treasury or admin, so a KAM cannot approve their own loss. Outcome math is unchanged. სტატუსის გასწორება stays the KAM/admin correction and is not on this screen.

## 8. Performance impact

The phone home reads `treasury_queue`, `treasury_client_replies`, the same short approved slice (`request_active` / `request_outcomes`, limit 40, last 14 days), closed ids, banks for the visible ids, and `countPendingLosses`. It does not load the desk-day table, `treasury_rates`, `treasury_quotes_today`, the hour-grid comparison, or the all-day deals table.

The waiting queue still refreshes every 3 seconds. Replies and the loss count refresh with the existing 15-second live check. The loss count is not on the 3-second poll. Quote, better, and write screens refresh only their own row. No faster polling was added.

## 9. Responsive test results

Checked with Chrome device metrics, fixture data, then the fixture was removed. Document scroll overflow was false at every size. Tab labels stayed on one line. Tab targets were 44px tall.

| Check | Result |
| --- | --- |
| 360×800, 390×844, 393×852, 402×874, 412×915, 430×932 | Quote and home fit. No horizontal overflow. |
| 390×844 home, quote, better, write, More | Actions sit above the tab bar. |
| 390×520 with the keyboard inset | Tab bar hidden. Rate field stays above კურსის გაგზავნა. |
| Landscape 844×390, 852×393, 874×402, 915×412, 932×430 | Home scrolls between the header and the tab bar. |
| Desktop 1280×900 | `phone` is false. No phone tab bar. Desktop desk headings are present. |

Screenshots: `/tmp/kursi-mobile-phase2/` (`home-390.png`, `home-bottom-390.png`, `quote-390.png`, `better-390.png`, `write-390.png`, `more-390.png`, `keyboard-390.png`, `home-land-844.png`, `quote-land-844.png`, `desk-1280.png`, plus the other widths).

On a short landscape home, a tall waiting card can meet the tab bar at the fold. Scrolling brings the action up to the tab bar (measured button bottom equal to the tab top, not under it). On landscape quote, the rate and send button stay in view; the validity choices can sit just above the fold and scroll back into view.

## 10. Unverified live workflows

Not run against Supabase:

- `treasury_quote` and `treasury_decline`
- `treasury_answer_better` for accepted, corrected, and declined
- `treasury_mark_rate_written`
- `approve_request_loss`
- Realtime updates, the success toast, and the request leaving the waiting section after a real send

The desktop screenshot shows `TypeError: Failed to fetch` because this environment has no Supabase keys. That toast is the existing desk error, not a new one.

## 11. Desktop regression risks

`RateDesk.tsx` was not rewritten. Desktop navigation arrays were not edited.

A treasury or admin session that matches the existing phone rules (short side at most 480 and long side at most 1000, width at most 480, or width at most 800 with a fine pointer) unmounts `RateDesk` and shows the mobile desk. A wider desktop window still mounts `RateDesk`, including the waiting queue, better-rate cards, rate-written cards, today's deals, and market rates. The 1280×900 check confirmed those section headings are still in the page.

Admin and manager phone bars are the previous bars. KAM More is the previous menu. Analysis is still desktop-only.
