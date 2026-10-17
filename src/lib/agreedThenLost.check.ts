// @ts-nocheck — reads the SQL files with node:fs. The app tsconfig has no Node types.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agreedLostNote, agreedThenLost } from './agreedThenLost.ts';

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

const agreed = '2026-10-17T10:00:00Z';
const later = '2026-10-17T12:00:00Z';
const earlier = '2026-10-17T09:00:00Z';

assert(agreedThenLost({ client_reply: 'approved', client_replied_at: agreed, marked_lost_at: later }), 'an approval then marked lost qualifies');
assert(agreedThenLost({ client_reply: 'approved', client_replied_at: agreed, loss_reason: 'postponed', loss_reason_at: later }), 'an approval then an explicit reason qualifies');
assert(agreedThenLost({ client_reply: 'approved', client_replied_at: agreed, loss_approved_at: later }), 'an approval then an approved loss qualifies');
assert(agreedThenLost({
  client_reply: 'approved',
  client_replied_at: agreed,
  rate_write_deferred: true,
  marked_lost_at: later,
}), 'a held approval that was then lost qualifies');
assert(agreedThenLost({
  client_reply: 'approved',
  client_replied_at: agreed,
  marked_lost_at: later,
  rate_written_at: '2026-10-17T11:00:00Z',
}), 'a written rate still qualifies when it was later lost');
assert(agreedThenLost({
  client_reply: 'approved',
  client_replied_at: agreed,
  loss_reason: 'postponed',
  loss_reason_at: later,
  rate_written_at: later,
}), 'a written rate with a later loss reason qualifies');
assert(!agreedThenLost({
  client_reply: 'approved',
  client_replied_at: agreed,
  rate_written_at: later,
}), 'a written rate that was not lost does not qualify');
assert(!agreedThenLost({ client_reply: 'approved', client_replied_at: agreed, rate_write_deferred: true }), 'a held approval that is still open does not qualify');
assert(!agreedThenLost({ client_reply: 'approved', client_replied_at: later, marked_lost_at: earlier }), 'a loss before the client agreed does not qualify');
assert(!agreedThenLost({ client_reply: 'approved', marked_lost_at: later }), 'an approval with no reply time does not qualify');
assert(!agreedThenLost({ rate_write_deferred: true, loss_reason: 'other', loss_reason_at: later }), 'a hold without client_reply approved does not qualify');
assert(!agreedThenLost({ client_reply: 'declined', client_replied_at: agreed, marked_lost_at: later }), 'a decline is not this mark');
assert(!agreedThenLost({ client_reply: 'approved', client_replied_at: agreed, quote_status: 'declined' }), 'a treasury decline is not this mark');
assert(!agreedThenLost({ client_reply: 'better', client_replied_at: agreed, marked_lost_at: later }), 'a better-rate ask is not this mark');
assert(!agreedThenLost({ client_reply: 'approved', client_replied_at: agreed }), 'an open approval does not qualify');

const one = agreedLostNote({ count: 1, latestAt: later, latestRequestId: 9, requestIds: [9] }, 4);
assert(one?.count === 1 && one.latestAt === later, 'a later request shows the one earlier loss');
const several = agreedLostNote({ count: 2, latestAt: later, latestRequestId: 9, requestIds: [9, 3] });
assert(several?.count === 2 && several.latestAt == null, 'several losses show the count');
assert(agreedLostNote({ count: 1, latestAt: later, latestRequestId: 9, requestIds: [9] }, 9) == null, 'the lost request itself is not a later note');

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const setup = readFileSync(join(root, 'supabase/setup/56_agreed_then_lost.sql'), 'utf8');
const migration = readFileSync(join(root, 'supabase/migrations/20261017250000_agreed_then_lost.sql'), 'utf8');
assert(setup === migration, 'setup 56 and the migration are the same bytes');
assert(!/create\s+(or\s+replace\s+)?function\s+public\.client_request_history/i.test(setup), 'client_request_history is not replaced');
assert(!/drop function public\.client_request_history/i.test(setup), 'client_request_history is not dropped');
assert(/create or replace function public\.client_agreed_then_lost/i.test(setup), 'the read is a new function');
assert(/grant execute on function public\.client_agreed_then_lost\(text\) to authenticated/i.test(setup), 'authenticated can execute the read');
assert(!/create or replace function private\.request_display_class/i.test(setup), 'display class is not redefined');
assert(!/and r\.rate_written_at is null/.test(setup), 'an agreed loss qualifies after the rate was written');
assert(/r\.client_reply = 'approved'/.test(setup), 'the read requires an approval');
assert(!/or v_rate_written is not null/.test(setup), 'a written rate can be marked lost');
assert(/v_confirmed is not null/.test(setup), 'a payment confirmation still cannot be marked lost');

console.log('agreed then lost ok');
