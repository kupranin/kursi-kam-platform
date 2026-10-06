# Kursi.ge Business: KAM platform

KAMs ask treasury for rates, treasury answers, and the client's transaction closes the request. Everything is counted the same way for everyone, and each role gets its own messages.

**To put it online, follow DEPLOY.md.**

## Who sees what

| Role | Main screen | Can do |
|---|---|---|
| KAM | Requests | ask for rates (with client autofill), copy the rate for the client, ask again, give reasons, follow up win-back clients, see their own numbers |
| Treasury | Rate desk | see every request as it arrives, give rates with a validity time, send requests back with a reason, see standard and NBG rates and today's special rates |
| Admin | Team | everything: invite people, set roles, switch logins off, counting rules, data sync, messages, activity log, plus the rate desk |
| Manager | Team | see everything, change nothing |

The screens work on phones too. The interface is in English; the messages go out in English and Georgian.

## What's in this folder

| Path | What it is |
|---|---|
| `src/`, `index.html`, `package.json`, `vercel.json` | The website, a React app that Vercel builds |
| `supabase/setup/1_platform.sql` | The whole database in one file, to paste into Supabase |
| `supabase/setup/2_clickhouse.sql` | Connects ClickHouse, once the data team is ready |
| `supabase/migrations/` | The same database, step by step, for the Supabase command line |
| `supabase/functions/admin-users/` | Inviting people, roles, switching logins off, password resets |
| `clickhouse/setup.sql` | The view and read-only user to create on ClickHouse |
| `backend-tests/` | Tests for the database |
| `DEPLOY.md` | Step-by-step setup: Supabase, Vercel, first admin, Make, ClickHouse |
| `MAKE_SETUP.md` | How messages reach each role through Make.com and Twilio |
| `BACKEND.md` | Technical reference: tables, counting rules, functions |

## How it fits together

1. The website on Vercel talks only to Supabase, with the public key. Every person signs in with their own email and password.
2. Supabase holds the requests, rates, clients and rules, and checks on every query what each person may see.
3. Transactions come from ClickHouse every hour, read-only.
4. Every event becomes a message, sent to the Make.com scenario for that role, and Make sends it on by email, SMS or WhatsApp.

## Run it on your computer (optional)

This needs Node.js 18 or newer.

```
npm install
cp .env.example .env.local     # then fill in the two Supabase values
npm run dev
```

## Not built yet

- **Rate feeds:** the feeds that send our standard rates, the NBG rate and the current open position. DEPLOY.md, part 8, shows how a Make scenario can send the rates.
- **Georgian interface:** a Georgian version of the screens.
