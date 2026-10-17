import { groupKamRows } from './kamWorkspace';
import type { RequestRow } from './types';

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

const today = '2026-10-17';

function row(id: number, patch: Partial<RequestRow> & { loss_reason_at?: string | null }): RequestRow {
  return {
    id,
    kam_id: 'k',
    kam_name: null,
    client_id: 'c',
    client_name: 'Client',
    client_kind: 'company',
    requested_at: '2026-10-17T06:00:00.000Z',
    request_date: today,
    sells_currency: 'USD',
    gets_currency: 'GEL',
    amount: 1,
    rate: null,
    note: null,
    loss_reason: null,
    source: 'app',
    went_through: false,
    outcome: 'waiting',
    asked_at: '2026-10-17T06:00:00.000Z',
    quote_status: 'asking',
    rate_valid_until: null,
    quoted_at: null,
    decline_reason: null,
    quote_state: 'asking',
    ...patch,
  };
}

const imported = row(1, { source: 'import', import_key: 'agreement:1', request_date: today });
const written = row(2, { rate_written_at: '2026-10-17T08:00:00.000Z', quote_status: 'quoted', quote_state: 'quoted' });
const paid = row(3, { payment_confirmed_at: '2026-10-17T09:00:00.000Z', went_through: true, outcome: 'went_through' });
const both = row(4, { rate_written_at: '2026-10-17T08:00:00.000Z', payment_confirmed_at: '2026-10-17T10:00:00.000Z' });
const writtenImport = row(5, { source: 'import', import_key: 'agreement:5', rate_written_at: '2026-10-17T08:00:00.000Z' });
const yesterdayWrite = row(6, { rate_written_at: '2026-10-16T18:00:00.000Z', request_date: today });
const declined = row(7, { client_reply: 'declined', client_replied_at: '2026-10-17T11:00:00.000Z', quote_status: 'quoted', quote_state: 'quoted' });
const lost = row(8, { loss_reason: 'postponed', marked_lost_at: '2026-10-17T12:00:00.000Z', loss_reason_at: '2026-10-17T12:00:00.000Z' });

const activity = groupKamRows([], [imported, written, paid, both, writtenImport, yesterdayWrite, declined, lost], [], today);
assert(!activity.writtenToday.some((item) => item.id === 1), 'an agreement row imported today is not a written rate');
assert(!activity.paidToday.some((item) => item.id === 1), 'an agreement row imported today is not a payment');
assert(!activity.lostToday.some((item) => item.id === 1), 'an agreement row imported today is not a loss');
assert(activity.writtenToday.some((item) => item.id === 2) && !activity.paidToday.some((item) => item.id === 2), 'a written rate is not a payment');
assert(activity.paidToday.some((item) => item.id === 3) && !activity.writtenToday.some((item) => item.id === 3), 'a payment without a write stays on the payment list');
assert(activity.writtenToday.some((item) => item.id === 4) && activity.paidToday.some((item) => item.id === 4), 'write and payment are separate when both happened today');
assert(activity.writtenToday.some((item) => item.id === 5), 'an import is included when its own write time is today');
assert(!activity.writtenToday.some((item) => item.id === 6), 'a write before today stays off today even if the request date is today');
assert(activity.lostToday.some((item) => item.id === 7), 'a client decline today is today activity');
assert(activity.lostToday.some((item) => item.id === 8), 'a loss mark today is today activity');

const quoted = row(10, { quote_status: 'quoted', quote_state: 'quoted', rate: 2.7, rate_valid_until: '2026-10-17T18:00:00.000Z' });
const asking = row(11, { quote_status: 'asking', quote_state: 'asking' });
const held = row(12, { client_reply: 'approved', rate_write_deferred: true, quote_status: 'quoted', quote_state: 'quoted' });
const approved = row(13, { client_reply: 'approved', quote_status: 'quoted', quote_state: 'quoted' });
const follow = row(14, { outcome: 'did_not_go_through', request_date: '2026-10-15', quote_status: 'quoted', quote_state: 'quoted' });
const open = groupKamRows([quoted, asking, held, approved], [], [follow], today);
assert(open.awaitingClient.map((item) => item.id).join() === '10', 'a quoted rate with no reply awaits the client');
assert(open.awaitingTreasury.map((item) => item.id).sort().join() === '11,13', 'asking and an approved write wait on treasury');
assert(open.held.map((item) => item.id).join() === '12', 'a deferred approval is held');
assert(open.followUp.map((item) => item.id).join() === '14', 'a 7-day row with no loss reason is follow-up');
assert(open.stillOpen.length === 0, 'staged rows are not repeated');
