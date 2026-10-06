# Messages through Make.com

The platform posts every message to a Make.com webhook, one webhook per role. Make sends it on by email, SMS or WhatsApp (Twilio).

## Which message goes to whom

| Message | Sent when | Goes to |
|---|---|---|
| `request.new` | A KAM asks for a rate | Treasury |
| `request.asked_again` | A KAM asks again after an expired rate or a send-back | Treasury |
| `request.waiting_long` | A request has waited longer than the alert time (3 min by default) | Treasury (admins too, if switched on) |
| `rate.ready` | Treasury sent a rate | The KAM who asked |
| `request.sent_back` | Treasury sent the request back, with the reason | The KAM who asked |
| `rate.expiring` | A rate expires in 2 minutes and the client's transaction hasn't arrived | The KAM who asked |
| `request.went_through` | The client's transaction arrived | The KAM who asked (treasury too, if switched on) |
| `followups.daily` | Working days at 09:30: reasons to give, priority A clients to call | Each KAM who has something to do |
| `sync.failed` | Transactions couldn't be updated from ClickHouse | Admins |

Admins switch each line on or off in `notification_rules`, from the Admin screen. Alert times are in `rules` (`treasury_alert_seconds`, `expiry_warning_minutes`).

## What Make receives

```json
{
  "event_id": 1042,
  "event": "rate.ready",
  "audience": "kam",
  "occurred_at": "2026-10-06T08:07:12Z",
  "recipients": [
    { "profile_id": "…", "name": "Natali Philauri", "email": "n.philauri@kursi.ge",
      "phone": "+995599000111", "channels": ["sms", "email"] }
  ],
  "message": {
    "en": "Rate for Nova LLC: 2.6895. Sells USD 120,000 for GEL. Valid until 12:22.",
    "ka": "Nova LLC-ის კურსი: 2.6895. ყიდის 120,000 USD-ს, იღებს GEL-ს. მოქმედებს 12:22-მდე."
  },
  "data": { "request_id": 17, "client_name": "Nova LLC", "rate": 2.6895, "valid_until": "…", "…": "…" },
  "link": "https://kam.kursi.ge/requests/17"
}
```

- **recipients** is always a list: one person for KAM messages, everyone active in the role for treasury and admin messages. Each person's `channels` says where they want messages. Admins set that in the People list.
- **message** is ready to send in English and Georgian. **data** has the separate fields, if a scenario wants to build its own text.
- **event_id** is unique, so Make can ignore a message it has already handled.
- Every call has the header `X-Kursi-Token`, so the scenario can check it comes from the platform.

## Setting up one scenario per role

Do this for **treasury**, **kam** and **admin**, and later **manager** if needed.

1. In Make, create a scenario with **Webhooks → Custom webhook**. Under advanced settings, turn on **Get request headers**. Copy the webhook address.
2. In Supabase, store that address in Vault (SQL editor, once per role):
   ```sql
   select vault.create_secret('https://hook.eu1.make.com/…', 'make_webhook_treasury', 'Make webhook for treasury messages');
   select vault.create_secret('https://hook.eu1.make.com/…', 'make_webhook_kam',      'Make webhook for KAM messages');
   select vault.create_secret('https://hook.eu1.make.com/…', 'make_webhook_admin',    'Make webhook for admin messages');
   select vault.create_secret('a-long-random-string',        'make_webhook_token',    'Shared token sent as X-Kursi-Token');
   ```
3. Click **Redetermine data structure** in Make, then send a test from the Admin screen, or with `select public.send_test_notification('rate.ready');` as an admin. Make learns the fields from it. Test messages start with "[Test]".
4. Add a **filter** after the webhook: header `X-Kursi-Token` equals your token.
5. Add **Flow Control → Iterator** over `recipients`.
6. Add a **Router** with one route per channel, each with a filter on the recipient's `channels`:
   - contains `sms` → **Twilio → Create a Message**. To: `phone`. Body: `message.ka`, or `message.en`.
   - contains `whatsapp` → **Twilio → Create a Message**. From: `whatsapp:` + your Twilio WhatsApp number. To: `whatsapp:` + `phone`. WhatsApp only lets businesses start a conversation with an approved template, so register a template for each message type with Twilio first.
   - contains `email` → **Email** (or Gmail/Outlook) → **Send an email**. To: `email`.
7. Switch the scenario on. Make answers each call with 200, and the platform marks the message **delivered**.

## If something doesn't arrive

- **Delivery log.** Admins can see every message and its status in `notification_events` (Admin screen):
  - `pending`, `sent`, `delivered`: on its way or done.
  - `failed`: Make didn't answer with 200. The platform retries up to 3 times in total; the error is in `last_error`.
  - `no_webhook`: no Make address is stored for that role yet.
  - `no_recipients`: nobody active in that role, or the KAM's login is switched off.
- **Never blocks work.** A message that can't be sent never stops the work that caused it. The request, the rate or the sync goes through anyway.
