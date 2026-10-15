# Mobile phase 1

Phone shell, KAM navigation, KAM home, the new-request screen, and KAM request detail. Desktop routes and the desktop Requests page stay in place. No push work, no schema change for the shell, no deploy, no commit.

## Phone detection

`src/lib/usePhone.ts` no longer uses `max-width: 800px` alone. A layout is a phone when:

- the short side is at most 480px and the long side is at most 1000px, or the pointer is coarse, or
- the width is at most 480px, or
- the width is at most 800px and the pointer is fine (a desktop window dragged narrow).

A phone in landscape (844×390, 852×393, 874×402, 915×412, 932×430) stays in the phone shell. An iPad (short side about 768, coarse pointer) keeps the desktop/tablet layout. The hook sets `html.is-phone`. The same sizes are covered by the CSS media query: `(max-width: 480px)`, or `(max-width: 800px) and (pointer: fine)`, or `(max-height: 480px) and (max-width: 1000px)`.

`index.html` uses `viewport-fit=cover` and `interactive-widget=resizes-content`. The header, tab bar, page, and toasts use `env(safe-area-inset-*)`. While the keyboard is open, `html.kb-open` hides the tab bar and lifts the sticky action and the toast by `--keyboard-inset`.

## What changed on every phone

Shared shell in `Layout`: compact `kursi` mark, the current screen title, the notification bell, and the avatar. Desktop navigation stays off the phone header. Language stays in the avatar menu, and on KAM More. The tab bar is fixed, at least 44px tall, icons plus one-line Georgian labels, and a badge where that role already had one. Toasts sit above the tab bar (`z-index: 70`, bottom offset past the bar).

Treasury, manager, admin, and analyst keep their existing phone destinations. They pick up the header, safe area, toast position, detection, and landscape behavior. Their home screens were not redesigned.

## KAM phone

Bottom bar, four items: საქმე (`/requests`), ახალი (`/requests/new`), ჩატი, სხვა (`/more`). კურსები is not a primary tab. Analytics, history, and admin are not in that bar. More opens Rates, Clients, Follow-ups, Notifications, Language, Security, and Sign out. Desktop navigation is unchanged, including კურსები in the desktop KAM bar.

Home does not start with the new-request form. Order: ჩემი პასუხი სჭირდება, ხაზინას ელოდება, მიმდინარე only when another active request is actually there, then up to five recent rows and a link to earlier history. Empty action, waiting, and recent sections are one quiet line. Cards are `KamRequestCard`. One primary action, პასუხი, only when the KAM must answer a live treasury rate. The KAM’s own name is not on the card. Edit, Delete, Lost, and Went through are not on the list card. Status text comes from the existing fields (ხაზინას ელოდება, კურსი მოვიდა, უკეთეს კურსს ელოდება, დასაწერია, დასრულებული).

New request is its own screen. Order: client, bank, pair, amount, optional second amount, optional client rate, optional comment. Client history opens from კლიენტის ისტორია and is not under the form. Submit is კურსის თხოვნა ხაზინას. The fields scroll in their own area, and that button sits under the list, above the tab bar. A lock stops a second submit. Success returns to home and toasts გაეგზავნა ხაზინას. `log_request` argument names are unchanged.

Detail opens from a card. A live rate shows the pair, the amount, the rate, valid-until, then the client, then the reply. დამტკიცება is the gold action, უკეთესი კურსი is secondary, უარი is a text action. One step at a time. They sit in the page under the rate, not in a bar that covers it. Approve prefills the quoted rate. Transaction went through, Lost, Edit, and Delete stay behind სხვა ქმედებები, and only when the existing rules already allow them.

`Requests.tsx` is still the desktop page. `RequestsSwitch` sends a KAM on a phone to the mobile screens and everyone else, including a KAM on a desktop window, to that page.

## What was rendered

Local Vite has no Supabase URL, so a signed-in click was not possible. A temporary preview rendered the shell with fixture rows and was removed before the typecheck. Screenshots from that pass (not in the repo):

- `/tmp/kursi-mobile-phase1/home-390.png` — header `kursi` then საქმე, then bell and avatar. Sections start with ჩემი პასუხი სჭირდება (შპს მზე, USD/GEL, USD 50,000, კურსი მოვიდა, gold პასუხი), then ხაზინას ელოდება. Toast sits above the five-tab bar. საქმე is selected.
- `/tmp/kursi-mobile-phase1/new-390.png` — ახალი მოთხოვნა. Client, TBC / BOG / Liberty, currencies, sticky კურსის თხოვნა ხაზინას above the tab bar. ახალი is selected.
- `/tmp/kursi-mobile-phase1/detail-390.png` — შპს მზე · USD / GEL, rate 2.6521, კურსი მოვიდა, sticky დამტკიცება / უკეთესი კურსი / უარი, one set, not three forms.
- `/tmp/kursi-mobile-phase1/more-390.png` — კლიენტები, დაბრუნება, შეტყობინებები, ენა, პაროლი და შესვლა, გასვლა. სხვა is selected.
- `/tmp/kursi-mobile-phase1/home-land-844.png` — 844×390 still the phone shell, not the desktop nav.
- `/tmp/kursi-mobile-phase1/desktop-1280.png` — `kursi business`, h1 მოთხოვნები, `#new-title`, `#open-title`, the existing new-request form. No phone tab bar.

Could not click: sign-in, `log_request`, `kam_client_reply`, the bell panel’s live notes, or the keyboard on a device. Submit, reply, and the real toast-after-create were not exercised against Supabase.

## Correct status

Separate from the shell. KAMs sometimes mark ტრანზაქცია გავიდა or დაიკარგა on the wrong deal.

`CorrectStatusButton` shows სტატუსის გასწორება only when a KAM or an admin mark is already saved: `payment_confirmed_at` (went through) or `marked_lost_at` / `loss_reason` (lost), and the row is not a written rate. The same people who can mark an outcome can correct it: the KAM on their own request, an admin on any. Manager, treasury, and analyst do not see it. View-as does not grant it.

It sits with Edit and Delete: on the desktop request rows, and on the phone detail inside სხვა ქმედებები. It is not next to დამტკიცება / უკეთესი კურსი / უარი. One step at a time: switch to the other outcome, or ნიშნის მოხსნა. Lost still uses the existing reason list and the “other” comment.

`confirm_request_payment` and `mark_request_lost` cannot change a mark once it is saved, so the correction is a new function. Paste `supabase/setup/40_correct_outcome.sql` (twin: `supabase/migrations/20261015140000_correct_outcome.sql`). It was not run. It does not change `log_request`, delete rules, or `rate_written_at`. A written rate still means the deal went through and still cannot be deleted. If a SUCCESS payment or a written rate is what set the status, the function will not turn that into a loss.

## Round 2

The gold კურსის თხოვნა ხაზინას action no longer uses a fixed bottom offset or a fixed form padding. The new-request screen is a column that fills the visible viewport (`--app-h` from `visualViewport`, minus the measured header). The field list scrolls. The action bar is measured with a border-box `ResizeObserver` and published as `--sticky-h`. The list’s bottom margin is that variable, so the scrollport always ends where the bar starts. The tab bar is measured the same way into `--tabbar-h`. Its padding already includes `env(safe-area-inset-bottom)`, and the border-box observer follows that padding, including a later change in the system inset. While the keyboard is open, `html.kb-open` hides the tab bar (`--tabbar-h` becomes 0) and `--app-h` is the shortened visual viewport, so the action stays at the bottom of what is still visible. Other phone pages keep a bottom padding of the measured tab bar, and while the keyboard is open that padding is the keyboard overlap plus the safe-area inset.

KAM’s phone bar is only საქმე, ახალი, ჩატი, სხვა. Labels are one line, targets are at least 44×44. `/rates` stays a phone page for a KAM because More links to it (`KAM_MORE_PAGES`). Desktop `NAV` still has კურსები.

Home still leads with ჩემი პასუხი სჭირდება, then ხაზინას ელოდება. მიმდინარე is omitted when that bucket is empty. Empty copy is a 13px line, not a card. ბოლო stays a short recent list. A rate-received card shows client, pair, amount, rate, validity, status, and one პასუხი. A waiting card shows client, pair, amount, and the waiting time. No outcome buttons on either card.

The rate screen puts the pair, amount, rate, valid-until, and client above დამტკიცება / უკეთესი კურსი / უარი. The rate is 40px. Approve stays gold. Better rate is an outline button. Decline is text. The reply calls are unchanged.

### What the phone home actually loads

`RequestsSwitch` does not mount the desktop `Requests` page for a KAM on a phone, so that page’s history pager, approved list, and all-KAM profile query do not run. The phone home uses `loadKamDesk` only (the existing `request_active` read plus a short recent slice). Those reads were not changed.

`Layout` on a phone only counts badges that are on the phone tabs. For a KAM that is the action count on `request_active` and the chat count. It does not query the treasury queue, losses, or follow-ups. The desktop “transactions updated” line is not mounted, and this pass skips that header `data_freshness` call on a phone. `loadKamDesk` still calls `data_freshness` when it decorates active rows. That stays, because it is part of the active-read path.

Nothing on the KAM home is a desktop block hidden with CSS while it keeps fetching. The desktop nav, view-as, header language switch, and freshness line are not rendered on a phone. The notification bell is still mounted in the header. It was left as it is.

### What was checked

Local Vite still has no Supabase URL. A temporary fixture preview rendered the shell and was removed before the typecheck. Chrome headless, not a device keyboard. Screenshots (not in the repo):

- `/tmp/kursi-mobile-phase1-r2/new-390x844.png` — both currency rows fully above კურსის თხოვნა ხაზინას. Four tabs. ახალი selected.
- `/tmp/kursi-mobile-phase1-r2/new-360x800.png` — same on a 360-wide Android size.
- `/tmp/kursi-mobile-phase1-r2/new-844x390.png` — landscape. The currency rows are scrolled fully above the gold button. The phone shell stays.
- `/tmp/kursi-mobile-phase1-r2/new-390x480-keyboard.png` — viewport shortened and the amount field focused, so the tab bar is hidden. The currency rows sit fully above the gold button.
- `/tmp/kursi-mobile-phase1-r2/home-390.png` — ჩემი პასუხი სჭირდება, then ხაზინას ელოდება with the waiting time and no button, then ბოლო. No მიმდინარე section.
- `/tmp/kursi-mobile-phase1-r2/detail-390.png` — rate 2.65210 above დამტკიცება, უკეთესი კურსი, and უარი.
- `/tmp/kursi-mobile-phase1-r2/better-390.png` and `decline-390.png` — one reply step at a time, rate still above the field.
- `/tmp/kursi-mobile-phase1-r2/more-390.png` — კურსები, კლიენტები, დაბრუნება, შეტყობინებები, ენა, პაროლი და შესვლა, გასვლა.
- `/tmp/kursi-mobile-phase1-r2/rates-390.png` — კურსები opened from More, still the four-tab shell, not the “open on a computer” card.
- `/tmp/kursi-mobile-phase1-r2/chat-390.png` — ჩატი is the selected tab.
- `/tmp/kursi-mobile-phase1-r2/home-land-844.png` — landscape home, four tabs.
- `/tmp/kursi-mobile-phase1-r2/desktop-1280.png` — no phone tab bar. Desktop links include კურსები.

The same currency clearance (the pair’s box ends above the action, no horizontal page scroll, labels on one line) also held at 393×852, 402×874, 412×915, 430×932, and the matching landscape sizes. Growing the tab bar’s bottom padding to 48px moved `--tabbar-h` with it and the page ended at the top of the tab bar.

Not exercised on a device: a real iOS or Android keyboard, `log_request`, or `kam_client_reply`. A browser that focuses a field and neither shrinks `visualViewport` nor reports a keyboard overlap would leave the action at the bottom of the layout viewport.
