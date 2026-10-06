# KAM platform: backend reference

Supabase backend for the Kursi.ge Business KAM platform. KAMs ask treasury for a rate, treasury answers with a rate (or sends the request back), and the client's transaction closes the request. The backend also syncs transactions from ClickHouse, computes the KAM numbers, and gives every person their own login.

## Who can do what

| Role | Who | Can see | Can change |
|---|---|---|---|
| admin | Nino | everything, incl. the audit log | everything, incl. people and counting rules |
| manager | e.g. director, owners | everything except the audit log | nothing |
| treasury | treasury dealers | every request, the rate queue, all rates given | give rates, send requests back |
| kam | each KAM | own requests, own clients and their transactions, own win-back list | ask for rates, ask again, give loss reasons, record win-back steps |

Signed-out visitors get nothing. Every access rule also checks that the account is active, so switching someone off cuts their data access immediately.

## How logins work

- Each person has their own login: their work email and a password they choose themselves.
- Nobody can sign up on their own. An admin invites a person from the admin screen, and that person gets an email with a link to set their password.
- Admins never see or set anyone's password. "Send password reset" emails the person a link.
- When someone leaves, the admin switches them off. Their login stops working, and their past requests stay in the reports under their name.
- Only `@kursi.ge` addresses can be invited.
- Optional: admins can be required to confirm with an authenticator app (`rules.admin_requires_mfa`). Recommended.
- Every change to requests, clients, people and rules is written to `audit_log` with who made it and when. Nobody can edit or delete that log.

## What's in this folder

```
supabase/migrations/
  ..._100_core_schema.sql           tables
  ..._200_security.sql              roles, access rules, audit trail
  ..._300_logic.sql                 counting rules and the functions the app calls
  ..._400_clickhouse_connection.sql link to ClickHouse (needs step 5 first)
  ..._500_sync.sql                  transaction sync, backfill, history import
  ..._600_schedule.sql              hourly and nightly jobs
  ..._700_client_autofill.sql       suggestions for the client field
  ..._800_treasury.sql              treasury role, rate queue, rates and send-backs
  ..._900_reference_rates.sql       standard and NBG rates for treasury
  ..._1000_notifications.sql        messages to Make.com by role, delivery log
  ..._1100_notification_schedule.sql  timers, retries, morning summary (needs pg_cron)
  ..._1200_admin_tools.sql          admin sync status, "Sync now", message status, live updates
  ..._1300_went_through_after_request.sql  a request only counts transactions made after it
supabase/setup/1_platform.sql       all platform migrations in one file, for the SQL editor
supabase/setup/2_clickhouse.sql     the ClickHouse connection and sync schedule
backend-tests/                      tests for a plain PostgreSQL, see "What was tested"
MAKE_SETUP.md                       how to connect Make.com, Twilio and email
supabase/functions/admin-users/     invite / switch off / reset password
clickhouse/setup.sql                view + read-only user, run on ClickHouse
```

## Setting it up

Follow DEPLOY.md. It covers Supabase, Vercel, the first admin, Make.com, ClickHouse, the history import and the rate feeds, in order.

## Decisions still needed

These are stored in the `rules` table, so changing them later needs no code:

| Setting | Now | Question |
|---|---|---|
| `month_grace_days` | not decided (counts as 0) | Does a month's portfolio include requests from the first days of the next month? September used requests up to 2 October. |
| `tier_a_min_gel`, `tier_b_min_gel` | 200,000 / 50,000 GEL (placeholders) | Thresholds for win-back priority A and B |
| `winback_window_days` | 92 | How far back the win-back list looks |
| `admin_requires_mfa` | off | Turn on once Nino has set up an authenticator app |
| `default_quote_minutes` | 15 | How long a treasury rate is valid unless treasury picks another time |
| `loss_reasons` table | 4 reasons from the mockup | Final list, in English and Georgian |

## The rate flow (migration 8)

1. The KAM asks for a rate: client, currencies, amount and an optional note. Status: **asking**.
2. It appears in treasury's queue, oldest first. Two dealers can't answer the same request: the first answer locks it.
3. Treasury either sends a rate with a validity time (**quoted**), or sends the request back with a reason (**declined**).
4. The KAM tells the client. A rate past its time shows as **expired**. After an expired rate or a send-back, the KAM can ask again, optionally with a new note.
5. The client's transaction closes the request, exactly as before (same-day SUCCESS).

Every rate and every send-back is kept in `public.quotes`, with who gave it and when, and the standard rate at that moment, so special rates can be compared with standard later. Imported history is marked as already answered.

### Rates treasury sees (migration 9)

- **Our standard rates**: we buy and we sell, GEL per 1 unit, plus cross rates such as USD priced in EUR.
- **NBG official rate**. Cross rates are worked out through GEL.
- **Special rates already given today**, by deal direction.

Each request in the queue comes with the standard rate, the NBG rate and the last special rate given today for the same direction.

The rates arrive through `load_reference_rates`, which only the service key can call. Send it a list of rates from the core system (standard) and from NBG:

```sql
select public.load_reference_rates('standard',
  '[{"currency":"USD","buy":2.6750,"sell":2.7150,"as_of":"2026-10-06T07:15:00Z"},
    {"currency":"USD","quote_currency":"EUR","buy":0.8640,"sell":0.8700}]');
select public.load_reference_rates('nbg', '[{"currency":"USD","official":2.6948}]');
```

## Messages to each role (migrations 10–11)

Treasury hears about new requests, requests asked again and requests waiting too long. KAMs hear when a rate is ready, when a request is sent back, when a rate is about to expire, when the client's transaction arrives, and get a morning summary of follow-ups. Admins hear when the transaction sync fails.

Each message goes to the Make.com webhook for that role, in English and Georgian, with the recipients' email, phone and preferred channels. Make sends it on through email or Twilio. Admins can switch each message type on or off. Failed deliveries are retried, and a message that can't be sent never blocks the work behind it. Details, sample payload and the Make setup are in MAKE_SETUP.md.

## The counting rules (migration 3)

- **Turnover** = `abs_gel + cross_gel`, every payment status. The not-successful part is reported separately.
- **Income** = `total_income`, every payment status, with nothing added on top (it already includes cross income).
- **Went through**: a `SUCCESS` transaction from the same client on the same Tbilisi date as the request, made after the request was asked (1 minute's leeway). Imported history uses the date only, because the old file has no times. KAMs never set a status.
- **Owner**: the KAM with the most requests for the client in the month, with ties going to the latest. If `clients.assigned_kam_id` is set, it overrides this.
- **Portfolio**: clients with a request from the 1st of the month to month end plus the grace days. Their turnover counts the calendar month.
- **Win-back**: clients who asked within the window and have had no successful transaction since their last request. A client leaves the list on its own when a transaction arrives.
- **Non-client operations** (position close in bank, fastoo, bitnet, unipay) are excluded in the ClickHouse view.

## Sync

- **Hourly** (at :05): re-reads the last 2 days, so "Today's requests" stays current.
- **Nightly** (03:00 Tbilisi): re-reads the last 7 days, to catch payment statuses corrected after the fact.
- **Every 5 minutes**: fetches 180 days of history for any client new to the platform.
- Only transactions of clients on the platform are copied.
- Every run is logged in `private.sync_runs`. `data_freshness()` gives the time shown as "Transactions updated" in the app.

## API for the frontend

```js
// sign in / set password (the invite and reset links land on /set-password)
await supabase.auth.signInWithPassword({ email, password })
await supabase.auth.updateUser({ password })

await supabase.rpc('my_profile')                  // name and role of whoever is signed in
await supabase.rpc('data_freshness')              // "Transactions updated 11:00"

// request form: autofill while typing (digits match the ID, letters match the name,
// empty shows recent clients). KAMs only get clients from their own book.
await supabase.rpc('search_my_clients', { p_query: '4051', p_limit: 8 })
// -> client_id, name, kind, last_request_date, last_sells_currency, last_gets_currency
//    (use the last currencies to pre-select the currency buttons)
await supabase.rpc('lookup_client', { p_client_id: '405123987' })   // a full ID of any client
// if lookup_client says known = false, or name is empty, show a required "Client name" field
// and send it as p_client_name; log_request refuses a new client without a name
await supabase.rpc('log_request', { p_client_id, p_sells_currency: 'USD', p_gets_currency: 'GEL',
                                    p_amount: 120000, p_note: null, p_client_name: null })   // asks treasury
await supabase.rpc('ask_again', { p_request_id, p_note: null })   // after an expired rate or a send-back
await supabase.rpc('delete_request', { p_request_id })            // own request, within 15 minutes
// request_outcomes has quote_state (asking | quoted | expired | declined), rate, rate_valid_until, decline_reason

// KAM home
await supabase.from('request_outcomes').select('*').eq('request_date', today).order('requested_at')
await supabase.from('request_outcomes').select('*')
  .eq('outcome', 'did_not_go_through').is('loss_reason', null).gte('request_date', weekAgo)
await supabase.from('loss_reasons').select('*').eq('active', true).order('sort_order')
await supabase.rpc('set_loss_reason', { p_request_id, p_reason: 'better_rate' })  // p_reason: null = undo

// win-back
await supabase.rpc('winback_list')
await supabase.rpc('set_winback_step', { p_client_id, p_step: 'called', p_note: null })

// scorecard (KAMs automatically get only their own row)
await supabase.rpc('kam_month_summary', { p_month: '2026-09-01' })
await supabase.rpc('month_portfolio',   { p_month: '2026-09-01' })

// treasury
await supabase.rpc('treasury_queue')                 // waiting requests, oldest first, with KAM, note and last rate
await supabase.rpc('treasury_quote',   { p_request_id, p_rate: 2.6895, p_valid_minutes: 15 })  // returns valid-until
await supabase.rpc('treasury_decline', { p_request_id, p_reason: 'Amount too large' })
await supabase.rpc('treasury_quotes_today')          // "Your quotes" list
await supabase.rpc('treasury_rates')                 // "Rates now": standard buy/sell, crosses, NBG
supabase.channel('requests').on('postgres_changes',
  { event: '*', schema: 'public', table: 'requests' }, reload).subscribe()   // live queue

// admin: messages
await supabase.from('notification_rules').select('*')                         // who gets what
await supabase.from('notification_rules').update({ enabled: false })
  .eq('event_type', 'request.went_through').eq('audience', 'treasury')
await supabase.from('notification_events').select('*').order('id', { ascending: false }).limit(50)  // delivery log
await supabase.rpc('send_test_notification', { p_event: 'rate.ready' })
await supabase.functions.invoke('admin-users', { body: { action: 'set_contact', profile_id,
  phone: '+995599123456', channels: ['sms', 'email'] } })

// admin
await supabase.from('rules').update({ month_grace_days: 2 }).eq('id', true)
await supabase.functions.invoke('admin-users', { body: { action: 'list' } })
await supabase.functions.invoke('admin-users', { body: { action: 'invite', email, full_name, role: 'kam' } })
await supabase.functions.invoke('admin-users', { body: { action: 'deactivate', profile_id } })
```

Errors from the functions are written to be shown to the user as they are, e.g. "Check the ID: companies have 9 digits, people 11".

## What was tested

Migrations 1, 2, 3 and 5 were run on PostgreSQL 16, with a local table standing in for ClickHouse. The tests covered:

- logging requests, including ID clean-up and validation messages
- each role seeing only what it should, and signed-out visitors seeing nothing
- outcomes, the September scorecard, portfolio ownership and the win-back list
- payment-status corrections being picked up by the sync
- the delete window and the authenticator-app switch
- switching an account off, and the audit trail
- the history import
- client autofill: matching by ID start, by name, and IDs that lost their leading zero; KAMs seeing only their own clients
- new clients (or clients on file without a name) being refused without a name
- messages: the right role gets each event, KAM messages go only to the KAM who asked, "once" messages aren't repeated, Make's answers are recorded and failures retried, switched-off messages aren't sent, a broken connection doesn't block a request, and only admins can read the log or send tests
- reference rates: loading through the service key only, treasury seeing them and KAMs not, each queued deal carrying its standard and NBG rate, and every rate given recording the standard rate
- the treasury flow: queue, giving a rate, no double answers, send-back with a reason, ask again after expiry or send-back, KAMs and managers unable to give rates, KAMs seeing only their own quotes

The admin-users function was type-checked against supabase-js.

To rerun the tests on any machine with PostgreSQL 15 or newer: `cd backend-tests && DB=kamtest ./run.sh`. It should end with 0 checks not passed.

The web app was also tested end to end: its real queries ran over HTTP through PostgREST (the same layer Supabase uses) for every role, 40 checks. Then the built app ran headlessly against that database, 25 checks: a KAM asking for a rate with autofill, treasury answering with Enter and the typo guard, the KAM seeing the rate, the admin screens, and a manager being kept out of Admin.

Not tested here, because they need the real services: the live ClickHouse connection (migration 4), the schedules (migrations 6 and 11), the real pg_net and Make.com calls (a stand-in recorded the calls instead), and sending emails.

Known limit: a transaction deleted in ClickHouse is not deleted from the copy. Ask if that can happen at the source.

Still to build: two feeds into `load_reference_rates`, one from wherever the standard rates are kept and one from NBG. The open-position panel on treasury's screen needs a feed of the current position from the core system, and the admin screen's sync health and "Sync now" button need a small admin-only function.
