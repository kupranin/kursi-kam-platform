# KAM phone — manual acceptance

Language on both phones: Georgian. Use a real KAM account and a real treasury account. An admin “view as” is not a substitute when it hides the KAM’s own actions.

## Safe conditions

Run this only after the phone work is on the live site.

- The phone UI is in local commits `5d3d750` and `b6eac81` on branch `2026-07-08-1sxs`. https://kursi-kam-platform.vercel.app/ does not show the phone UI until that branch is published from GitHub Desktop and Vercel has finished.
- The site uses the existing Supabase project `tktqrdapdvnaznryiije`. Do not paste SQL, change the database, or create extra requests outside this list.
- Agree the test client with treasury before anyone starts. Use a client id and name the team already uses for trials, or a client everyone can recognize and later mark so it is not treated as a live desk deal. Tell treasury, before the first request, that it is a test.
- Tests 3–9 write real rows on the live project. Use only that agreed test client, one request at a time. Do not bulk-create. Treasury must know which request is the test.
- Stop if a real client request is in the treasury queue and nobody can tell it apart from the test.
- iPhone: open the published site in Safari. Android: Chrome. A phone shows the bottom bar. A computer keeps the desktop Requests page. Do not shrink a computer window to imitate a phone.
- Two people, or one person with the KAM login and the treasury login.
- `supabase/setup/40_correct_outcome.sql` is not required for tests 1–14. Do not paste it for this test. After a success or loss mark, **სტატუსის გასწორება** may be visible under **სხვა ქმედებები**. It does not save until that file has been pasted. Do not mark a correction of “went through” or “lost” as a pass.

Treasury quotes from the existing rate desk: on a computer, **კურსის მაგიდა**; on a phone, the bottom tab **მაგიდა**. There is no separate treasury home.

---

### 1. KAM signs in on an iPhone and Android phone

1. On the iPhone, open the published site in Safari. Sign in with the KAM’s **სამუშაო ელფოსტა** and **პაროლი**, then tap **შესვლა**.
2. Repeat with the same KAM on Android in Chrome.

**Expected:** Both phones open **საქმე**. The bottom bar is **საქმე**, **ახალი**, **ჩატი**, **სხვა**.

Pass: [ ]

**If it fails:** Blocker — the KAM cannot reach the phone desk.

### 2. KAM sees the correct action-required requests

1. On **საქმე**, read **ჩემი პასუხი სჭირდება**.
2. Compare it with **ხაზინას ელოდება**. If nothing needs an answer yet, repeat this check after test 5, on the one test request.

**Expected:** **ჩემი პასუხი სჭირდება** lists only requests where treasury has sent a rate that is still valid and this KAM has not answered. Each of those shows the rate, **მოქმედებს …-მდე**, the pill **კურსი მოვიდა**, and **პასუხი**. A request still waiting on treasury stays under **ხაზინას ელოდება** and is not in the action list. If nothing needs an answer, the action section says **ახლა პასუხი არ გჭირდებათ.**

Pass: [ ]

**If it fails:** Major — the KAM can miss a live rate or answer the wrong request.

### 3. KAM creates a request

1. Tap **ახალი**.
2. Enter the agreed test client’s **კლიენტის ID** and **კლიენტის სახელი**.
3. Choose at least one bank: **TBC**, **BOG**, or **Liberty**.
4. Under **კლიენტი ყიდის** and **კლიენტი იღებს**, pick two different currencies. The buttons are **GEL**, **USD**, **EUR**, **RUB**, and **CNY**.
5. Enter **თანხა**. Leave **კლიენტის ისტორია** closed.
6. Check that **კურსის თხოვნა ხაზინას** does not cover the currency buttons, then tap it.

**Expected:** A message says **გაეგზავნა ხაზინას.** The phone returns to **საქმე** and the request is under **ხაზინას ელოდება**. Client history does not open by itself.

Pass: [ ]

**If it fails:** Blocker — the phone cannot start a rate request.

### 4. Treasury receives the request

1. Treasury signs in on a computer or on the current phone desk.
2. Open **კურსის მაგიდა** (computer) or **მაგიდა** (phone).
3. Find the test client in **კურსს ელოდება**.

**Expected:** That one test request is there, with the client, bank, currencies, and amount. Treasury can tell it from any real request.

Pass: [ ]

**If it fails:** Blocker — treasury never sees the request, so no rate can be given.

### 5. Treasury sends a rate

1. On that same queue card, type a normal test rate in **კურსი**.
2. Under **მოქმედებს**, choose **5 წთ**, **15 წთ**, or **30 წთ**.
3. Tap **კურსის გაგზავნა**.

**Expected:** Treasury sees a confirmation that the rate was sent and the time it is valid until. The request leaves **კურსს ელოდება**.

Pass: [ ]

**If it fails:** Blocker — the KAM never receives a rate.

### 6. KAM sees the received rate and its validity

1. On the KAM phone, open **საქმე**.
2. Open the test request from **ჩემი პასუხი სჭირდება**.

**Expected:** The rate is the large focus, with **მოქმედებს …-მდე** and the pill **კურსი მოვიდა**. Under it, in order: **დამტკიცება** (gold), **უკეთესი კურსი**, **უარი**. Only one of these is open at a time.

Pass: [ ]

**If it fails:** Major — the KAM cannot see which rate to answer, or when it expires.

### 7. KAM accepts a rate

1. On a quoted test request, tap **დამტკიცება** only.
2. Leave **დამტკიცებული კურსი** as the rate treasury sent, or type that same rate.
3. Tap **გაგზავნა**.

**Expected:** **უკეთესი კურსი** and **უარი** are hidden while this form is open. A message says **გაეგზავნა ხაზინას და მენეჯერებს.** The status becomes **დასაწერია**. The request leaves **ჩემი პასუხი სჭირდება**.

Pass: [ ]

**If it fails:** Blocker — the agreed rate never goes back to treasury.

### 8. KAM requests a better rate and Treasury responds

1. Create one new test request (tests 3–5) and wait until the rate is on the KAM phone.
2. Tap **უკეთესი კურსი** only. Enter the rate the client wants and tap **გაგზავნა**.
3. Treasury opens **კლიენტს უკეთესი კურსი სურს** on the rate desk and either taps **დადასტურება**, or types **გასწორებული კურსი** and taps **გაგზავნა**.
4. The KAM refreshes **საქმე**.

**Expected:** After the KAM sends, the request is under **ხაზინას ელოდება** with **უკეთეს კურსს ელოდება**. After treasury answers, it returns to **ჩემი პასუხი სჭირდება** with the rate treasury confirmed or corrected, and **მოქმედებს …-მდე**.

Pass: [ ]

**If it fails:** Major — the better-rate path fails. Accept and decline are separate tests.

### 9. KAM declines a rate

1. Create one new quoted test request.
2. Open it and tap **უარი** only.
3. Enter a short **მიზეზი** and tap **შენახვა**.

**Expected:** The other actions are hidden while the reason is open. A message says **მიზეზი შენახულია.** The status is **უარი**, and the screen shows **კლიენტმა უარი თქვა** with that reason. It is not under **ჩემი პასუხი სჭირდება**.

Pass: [ ]

**If it fails:** Major — a client refusal is not recorded. Accept still has its own test.

### 10. Existing transaction-success and loss workflows remain correct

Use test requests that are still open. The accepted request from test 7 can be the success. The declined request from test 9 can be the loss. Do not use **სტატუსის გასწორება**.

1. Open the accepted test request, tap **სხვა ქმედებები**, tap **ტრანზაქცია გავიდა**, and confirm.
2. On the other open test request, tap **სხვა ქმედებები**, tap **დაიკარგა**, choose a reason (for **სხვა**, add a comment), tap **ხაზინისთვის გაგზავნა**, and confirm.
3. Treasury opens **დაკარგული მოთხოვნები** (phone tab **დაკარგული**) or today’s deals on **კურსის მაგიდა**, finds that test loss, and taps **დანაკარგის დადასტურება**.

**Expected:** Success shows **ტრანზაქცია გავიდა.** and the pill **დასრულებული**. The loss shows **დაკარგულად მოინიშნა. ხაზინის დადასტურებას ელოდება.** and the pill **დაიკარგა, ხაზინას ელოდება**. After treasury confirms, the loss is no longer waiting on treasury.

Pass: [ ]

**If it fails:** Blocker — a live deal can be closed with the wrong outcome, or a loss never reaches treasury.

### 11. New Request form remains fully usable with the physical mobile keyboard

1. On iPhone and Android, open **ახალი**.
2. Tap **თანხა**, then **კომენტარი ხაზინას**, and type with the phone keyboard.
3. Scroll to the currency buttons and to **კურსის თხოვნა ხაზინას**.

**Expected:** The keyboard does not cover the field being typed. The bottom tabs move out of the way while typing. **კურსის თხოვნა ხაზინას** stays tappable and does not cover **GEL / USD / EUR / RUB / CNY**. **კლიენტის ისტორია** stays closed until it is tapped.

Pass: [ ]

**If it fails:** Major — the new-request form cannot be completed with the phone keyboard.

### 12. All four mobile tabs work

On the KAM phone, tap each bottom item once.

**Expected:**

- **საქმე** shows **ჩემი პასუხი სჭირდება**, **ხაზინას ელოდება**, **მიმდინარე** when something is in progress, and **ბოლო**.
- **ახალი** opens **ახალი მოთხოვნა**.
- **ჩატი** opens **ჩატი**.
- **სხვა** lists **კურსები**, **კლიენტები**, **დაბრუნება**, **შეტყობინებები**, **ენა**, **პაროლი და შესვლა**, and **გასვლა**.

The bottom bar stays visible, and the open tab is marked.

Pass: [ ]

**If it fails:** Major — the KAM cannot move between home, a new request, chat, and more.

### 13. Rates can be opened from More

1. Tap **სხვა**.
2. Tap **კურსები**.

**Expected:** The rates page opens with the title **კურსები**. Rates are not a fifth bottom tab.

Pass: [ ]

**If it fails:** Minor — rates remain in the computer nav. This phone link is the shortcut.

### 14. Desktop functionality remains unchanged

1. On a computer, at a normal window size, sign in as the KAM.
2. Read the top navigation and the Requests page.
3. Open **კურსები** from that top navigation.
4. Sign in as treasury on the computer and open **კურსის მაგიდა**.

**Expected:** The KAM sees the desktop page **მოთხოვნები**, with no phone bottom bar. The top nav still includes **მოთხოვნები**, **დაბრუნება**, **ჩემი კლიენტები**, **კურსები**, **ჩემი ციფრები**, **ჟურნალი**, and **ჩატი**. **კურსები** is still its own desktop item. Treasury still works from **კურსის მაგიდა**.

Pass: [ ]

**If it fails:** Blocker — the computer desk is still how treasury and many KAMs work.
