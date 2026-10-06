# Putting the KAM platform online

This guide takes you from this folder to a working platform: the database and logins on **Supabase**, the website on **Vercel**, and messages through **Make.com**.

Parts 1 to 5 give you a working platform where KAMs ask for rates and treasury answers. Parts 6 to 8 connect real transactions, the history and the rate feeds. Your tech person can do those later.

You need accounts at supabase.com, vercel.com, github.com and make.com.

---

## Part 1. Supabase: the database and logins (about 30 minutes)

### 1.1 Create the project
1. On supabase.com, click **New project**.
2. Name it `kursi-kam`, choose the region **Central EU (Frankfurt)** and set a strong database password. Keep the password somewhere safe.
3. Wait until the project is ready.

### 1.2 Switch on three extensions
In **Database → Extensions**, switch on:
- `pg_cron`, for the scheduled jobs
- `pg_net`, for sending messages to Make
- `wrappers`, for reading ClickHouse (needed in part 6)

Vault is already on.

### 1.3 Create the platform
1. Open **SQL Editor → New query**.
2. Open `supabase/setup/1_platform.sql` from this folder in a text editor, copy everything, paste it into the editor and click **Run**.
3. It should finish with "Success". If it stops with an error, send the error text to whoever helps you; nothing is half-saved.

### 1.4 Sign-in settings
In **Authentication**:
- **Sign In / Providers:**
  - Turn off **Allow new users to sign up**. Only admins invite people.
  - Keep **Email** on.
- **Passwords** (same area):
  - Minimum length **12**.
  - Require letters and digits.
  - Turn on leaked-password protection if your plan has it.
- **Multi-Factor:** turn on **TOTP (authenticator app)**.
- **Emails → SMTP Settings:** set up your own sender, either your company mail server or a service such as SendGrid. The built-in sender is limited and meant for testing, so without this, invites may not arrive.
- **URL Configuration:** come back here in part 2, once you have the website address.

### 1.5 Deploy the user-management function
This is what lets admins invite people, switch logins off and send password resets.

**Without installing anything:**
1. Go to **Edge Functions → Deploy a new function → Via editor**.
2. Name it exactly `admin-users`.
3. Replace the sample code with the contents of `supabase/functions/admin-users/index.ts`.
4. Click **Deploy**.

**Or, with the Supabase command line:** run `npx supabase functions deploy admin-users` from this folder.

### 1.6 Copy two values for the website
In **Project Settings → API**, copy:
- the **Project URL**, like `https://abcd.supabase.co`
- the **anon public** key (in newer projects, the **publishable** key)

Never copy the `service_role` or secret key into the website.

---

## Part 2. Vercel: the website (about 10 minutes)

### 2.1 Put the folder on GitHub
1. On github.com, create a **private** repository named `kursi-kam-platform`.
2. Click **uploading an existing file** and drag in everything inside this folder.
3. Click **Commit**.

### 2.2 Create the Vercel project
1. On vercel.com, click **Add New → Project** and import the repository. Vercel recognises it as a Vite app.
2. Under **Environment Variables**, add:
   - `VITE_SUPABASE_URL` = the Project URL from 1.6
   - `VITE_SUPABASE_ANON_KEY` = the anon/publishable key from 1.6
3. Click **Deploy**. After a minute you get an address like `https://kursi-kam-platform.vercel.app`.
4. Optional: in **Settings → Domains**, add `kam.kursi.ge`, then add the DNS record Vercel shows you at your domain provider.

From now on, every change pushed to GitHub redeploys the site automatically.

### 2.3 Tell Supabase the website's address
Use your real address everywhere below.

- **Authentication → URL Configuration:**
  - **Site URL:** `https://kam.kursi.ge`
  - **Redirect URLs:** add `https://kam.kursi.ge/**`
- **Edge Functions → Secrets:** add `APP_URL` = `https://kam.kursi.ge`

---

## Part 3. The first admin (5 minutes)

1. In Supabase, go to **Authentication → Users → Add user → Send invitation**, and invite `nino@kursi.ge`.
2. In **SQL Editor**, run:
   ```sql
   insert into public.profiles (auth_user_id, email, full_name, role)
   select id, email, 'Nino Kuprashvili', 'admin' from auth.users where email = 'nino@kursi.ge';
   ```
3. Open the invitation email, choose a password, and you're in.
4. In the platform, open **Admin**:
   - **Counting rules:** set **Platform address** to your website address.
   - **People:** invite everyone else with **Invite a person**. Choose each person's role: KAM, Treasury, Manager or Admin. Add their mobile if they want SMS or WhatsApp.

Each person gets an email, chooses their own password, and lands on the screen for their role.

Recommended: under **Password and sign-in**, add an authenticator app. Then turn on **Admins confirm sign-in with an authenticator app** in Counting rules.

---

## Part 4. Make.com: messages to each role (about 30 minutes per role)

Follow **MAKE_SETUP.md**. In short:
1. One Make scenario per role (treasury, KAMs, admins), each starting with a custom webhook.
2. Store each webhook address in Supabase under **Project Settings → Vault**, or with SQL, using these names:
   - `make_webhook_treasury`
   - `make_webhook_kam`
   - `make_webhook_admin`
   - `make_webhook_token`
3. From **Admin → Messages → Send a test**, send a sample so Make learns the format.
4. Route each message to email, SMS or WhatsApp (Twilio) by the person's channels.

---

## Part 5. Check that it works

- [ ] You can sign in, and the top bar shows your name.
- [ ] An invited KAM gets the email, sets a password and sees **Requests**.
- [ ] The KAM asks for a rate, and it appears on the treasury person's **Rate desk** within seconds.
- [ ] Treasury types a rate and presses Enter, and the KAM sees it with **Copy for client**.
- [ ] **Admin → Messages** shows the messages as delivered once Make is connected.
- [ ] **Admin → Activity** lists what everyone did.

At this point the platform works without transactions. Requests stay "waiting" for their outcome until part 6 is done.

---

## Part 6. Connect ClickHouse: real transactions (data team, about 1 hour)

1. **On ClickHouse:** run `clickhouse/setup.sql` after changing the lines marked `ADJUST` to the real table and column names. It creates one view and a read-only user. Then open the ClickHouse port to Supabase only.
2. **In Supabase:** store the connection in Vault (SQL Editor). The password never goes into a file.
   ```sql
   select vault.create_secret('tcp://kam_platform_reader:PASSWORD@CLICKHOUSE_HOST:9000/kursi',
                              'clickhouse_kam_platform', 'Read-only ClickHouse user for the KAM platform');
   ```
3. **Run the connection:** run `supabase/setup/2_clickhouse.sql` in the SQL Editor.
4. **Check it:** run `select count(*) from ch.client_transactions where tx_date >= current_date - 1;`, then click **Admin → Data sync → Sync now**.

From then on:
- **Hourly:** transactions update every hour.
- **Nightly:** a full re-check runs at 03:00.
- **New clients:** a client new to the platform gets 6 months of history within 5 minutes.

---

## Part 7. Import the history (optional, about 30 minutes)

This brings in the cleaned agreement file, so September and earlier count in the numbers and in win-back.

1. Make a CSV with the columns of `private.import_requests`:
   - `row_no`, `request_date`, `client_id`, `client_name`, `kam_email`
   - `sells_currency`, `gets_currency`, `amount`, `rate`
   - `legacy_status`, `legacy_loss_reason`

   From the cleaned file:

   | Cleaned file column | Staging column |
   |---|---|
   | ორიგინალი სტრიქონი # | row_no |
   | თარიღი | request_date |
   | საიდენტიფიკაციო კოდი | client_id |
   | კლიენტის სახელი | client_name |
   | გაყიდვების მენეჯერი (email) | kam_email |
   | სტატუსი | legacy_status |
   | currency, amount and rate columns, where present | sells_currency, gets_currency, amount, rate |

   Claude can prepare this CSV from the cleaned file.
2. Load it into `private.import_requests`, either with the Table Editor (switch the schema to `private`) or with `\copy` in psql.
3. Run `select * from private.run_history_import();`.

Rows that can't be imported keep the reason in `import_error`. Past KAMs get a profile without a login, so their history keeps an owner; if they're invited later, the invite attaches to that profile.

---

## Part 8. Rate feeds (to build)

Treasury's **Rates now** panel and the **Rates for this deal** buttons show our standard rates and the NBG rate once something sends them in.

A Make scenario can do this without code:
1. **Trigger:** a schedule, for example every 5 minutes for standard rates and daily for NBG.
2. **Get the rates:** an HTTP module reads them from wherever they are kept, such as the core system or the NBG website.
3. **Send them to the platform:** an HTTP module does a POST:
   - **URL:** `https://YOUR-PROJECT.supabase.co/rest/v1/rpc/load_reference_rates`
   - **Headers:** `apikey: <service_role or secret key>`. With the older `service_role` key, also add `Authorization: Bearer <same key>`. Plus `Content-Type: application/json`.
   - **Body:**
     ```json
     { "p_source": "standard",
       "p_rates": [ { "currency": "USD", "buy": 2.6750, "sell": 2.7150 },
                    { "currency": "USD", "quote_currency": "EUR", "buy": 0.8640, "sell": 0.8700 } ] }
     ```
     For NBG: `{ "p_source": "nbg", "p_rates": [ { "currency": "USD", "official": 2.6948 } ] }`

The service key can change everything, so keep it only inside Make's connection settings, never in the website.

The **current open position** for treasury needs a similar feed from the core system. It isn't built yet. Until then, the rate desk shows only how valid quotes would change each currency.

---

## If something doesn't work

| What you see | What to do |
|---|---|
| The website says "Almost there" | The two Vercel environment variables are missing or misspelt. Add them, then **Deployments → Redeploy**. |
| An invite email doesn't arrive | Set up SMTP (1.4). Check **Authentication → Logs**. |
| The email link opens the sign-in page instead of "Choose your password" | Check the Redirect URLs (2.3). Each link works once and expires; use **Send password reset** in Admin → People. |
| "No access yet" after signing in | The login has no profile, or it's switched off. Check Admin → People, or for the first admin, step 3.2. |
| Admin → People shows an error | The `admin-users` function isn't deployed (1.5), or `APP_URL` isn't set (2.3). If it says "Invalid JWT", turn off **Enforce JWT verification** for that function: it checks the admin itself. |
| New requests don't appear on the rate desk until refresh | Live updates are off. Check that `requests` is listed under **Database → Publications → supabase_realtime**. The pages also refresh every 15 to 20 seconds on their own. |
| Rates now is empty | The rate feeds (part 8) haven't sent anything yet. |
| Transactions "not synced yet" | Part 6 isn't done, or the sync failed. See Admin → Data sync for the error. |
