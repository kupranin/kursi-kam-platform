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

Bottom bar, five items: საქმე (`/requests`), ახალი (`/requests/new`), ჩატი, კურსები, სხვა (`/more`). Analytics, history, and admin are not in that bar. More opens Clients, Follow-ups, Notifications, Language, Security, and Sign out.

Home does not start with the new-request form. Order: ჩემი პასუხი სჭირდება, ხაზინას ელოდება, მიმდინარე, then up to five recent rows and a link to earlier history. Cards are `KamRequestCard`. One primary action, პასუხი, only when the KAM must answer a live treasury rate. The KAM’s own name is not on the card. Status text comes from the existing fields (ხაზინას ელოდება, კურსი მოვიდა, უკეთეს კურსს ელოდება, დასაწერია, დასრულებული).

New request is its own screen. Order: client, bank, pair, amount, optional second amount, optional client rate, optional comment. Client history opens from კლიენტის ისტორია and is not under the form. Submit is კურსის თხოვნა ხაზინას, sticky above the tab bar, and a lock stops a second submit. Success returns to home and toasts გაეგზავნა ხაზინას. `log_request` argument names are unchanged.

Detail opens from a card. If a live rate is waiting, დამტკიცება, უკეთესი კურსი, and უარი are one at a time on the sticky bar. Approve prefills the quoted rate. Transaction went through, Lost, Edit, and Delete stay behind სხვა ქმედებები, and only when the existing rules already allow them.

`Requests.tsx` is still the desktop page. `RequestsSwitch` sends a KAM on a phone to the mobile screens and everyone else, including a KAM on a desktop window, to that page.

## What was rendered

Local Vite has no Supabase URL, so a signed-in click was not possible. A temporary preview rendered the shell with fixture rows and was removed before the typecheck. Screenshots from that pass (not in the repo):

- `/tmp/kursi-mobile-phase1/home-390.png` — header `kursi` then საქმე, then bell and avatar. Sections start with ჩემი პასუხი სჭირდება (შპს მზე, USD/GEL, USD 50,000, კურსი მოვიდა, gold პასუხი), then ხაზინას ელოდება. Toast sits above the five-tab bar. საქმე is selected.
- `/tmp/kursi-mobile-phase1/new-390.png` — ახალი მოთხოვნა. Client, TBC / BOG / Liberty, currencies, sticky კურსის თხოვნა ხაზინას above the tab bar. ახალი is selected.
- `/tmp/kursi-mobile-phase1/detail-390.png` — შპს მზე · USD / GEL, rate 2.6521, კურსი მოვიდა, sticky დამტკიცება / უკეთესი კურსი / უარი, one set, not three forms.
- `/tmp/kursi-mobile-phase1/more-390.png` — კლიენტები, დაბრუნება, შეტყობინებები, ენა, პაროლი და შესვლა, გასვლა. სხვა is selected.
- `/tmp/kursi-mobile-phase1/home-land-844.png` — 844×390 still the phone shell, five tabs, not the desktop nav.
- `/tmp/kursi-mobile-phase1/desktop-1280.png` — `kursi business`, h1 მოთხოვნები, `#new-title`, `#open-title`, the existing new-request form. No phone tab bar.

Could not click: sign-in, `log_request`, `kam_client_reply`, the bell panel’s live notes, or the keyboard on a device. Submit, reply, and the real toast-after-create were not exercised against Supabase.

## Correct status

Separate from the shell. KAMs sometimes mark ტრანზაქცია გავიდა or დაიკარგა on the wrong deal.

`CorrectStatusButton` shows სტატუსის გასწორება only when a KAM or an admin mark is already saved: `payment_confirmed_at` (went through) or `marked_lost_at` / `loss_reason` (lost), and the row is not a written rate. The same people who can mark an outcome can correct it: the KAM on their own request, an admin on any. Manager, treasury, and analyst do not see it. View-as does not grant it.

It sits with Edit and Delete: on the desktop request rows, and on the phone detail inside სხვა ქმედებები. It is not next to დამტკიცება / უკეთესი კურსი / უარი. One step at a time: switch to the other outcome, or ნიშნის მოხსნა. Lost still uses the existing reason list and the “other” comment.

`confirm_request_payment` and `mark_request_lost` cannot change a mark once it is saved, so the correction is a new function. Paste `supabase/setup/40_correct_outcome.sql` (twin: `supabase/migrations/20261015140000_correct_outcome.sql`). It was not run. It does not change `log_request`, delete rules, or `rate_written_at`. A written rate still means the deal went through and still cannot be deleted. If a SUCCESS payment or a written rate is what set the status, the function will not turn that into a loss.
