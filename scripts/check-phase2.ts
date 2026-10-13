/**
 * Pure checks for the Phase 2 read. Does not connect to a database.
 * Run: npx tsx scripts/check-phase2.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyMatchedSuccess,
  decorateActiveRow,
  fileWon,
  lossOpenWithoutPaymentMatch,
  requestVisibleToRole,
  splitKamRequests,
  type ActiveSource,
} from '../src/lib/activeRequest';
import { DAY_COLUMNS, DESK_DAY_SINCE_FIELDS, inDeskDayQuery, onDeskToday, type DeskDayStamp } from '../src/lib/deskDay';
import { tbilisiDayStart } from '../src/lib/format';
import type { RequestRow } from '../src/lib/types';

const root = resolve(import.meta.dirname, '..');
const errors: string[] = [];
const today = '2026-10-13';
const start = tbilisiDayStart(today);
const nextDay = tbilisiDayStart('2026-10-14');

function fail(message: string) {
  errors.push(message);
}

function assert(cond: boolean, message: string) {
  if (!cond) fail(message);
}

function stamp(partial: Partial<DeskDayStamp> & { id: number }): DeskDayStamp {
  return {
    source: 'app',
    request_date: '2026-10-01',
    requested_at: '2026-10-01T08:00:00.000Z',
    ...partial,
  };
}

function active(partial: Partial<ActiveSource> & { id: number }): ActiveSource {
  return {
    client_id: '123456789',
    requested_at: `${today}T08:00:00.000Z`,
    request_date: today,
    source: 'app',
    quote_status: 'asking',
    quote_state: 'asking',
    kam_id: 'kam-a',
    ...partial,
  };
}

function deduped(rows: DeskDayStamp[], alsoIds: number[]): number[] {
  const ids = new Set<number>();
  for (const row of rows) {
    if (inDeskDayQuery(row, today, start, alsoIds)) ids.add(row.id);
  }
  return [...ids];
}

const waiting = stamp({
  id: 1,
  request_date: today,
  requested_at: `${today}T06:00:00.000Z`,
  asked_at: `${today}T06:00:00.000Z`,
});
assert(inDeskDayQuery(waiting, today, start, []) && onDeskToday(waiting, today), '1 waiting request is on the desk');

const quoted = stamp({
  id: 2,
  request_date: today,
  quoted_at: `${today}T07:00:00.000Z`,
  rate_valid_until: `${today}T08:00:00.000Z`,
});
assert(inDeskDayQuery(quoted, today, start, []), '2 quoted request is in the OR');
assert(onDeskToday(quoted, today), '2 quoted request stays today');

const accepted = stamp({
  id: 3,
  request_date: today,
  client_replied_at: `${today}T09:00:00.000Z`,
});
assert(inDeskDayQuery(accepted, today, start, []) && onDeskToday(accepted, today), '3 accepted request stays in the OR');

const better = stamp({
  id: 4,
  request_date: today,
  client_replied_at: `${today}T09:30:00.000Z`,
});
assert(inDeskDayQuery(better, today, start, []), '4 better-rate request stays in the OR');

const betterAnswered = stamp({
  id: 5,
  request_date: today,
  quoted_at: `${today}T10:00:00.000Z`,
  client_replied_at: `${today}T09:30:00.000Z`,
});
assert(inDeskDayQuery(betterAnswered, today, start, []), '5 treasury answer stays in the OR');

const written = stamp({
  id: 6,
  request_date: today,
  rate_written_at: `${today}T11:00:00.000Z`,
});
assert(inDeskDayQuery(written, today, start, []) && onDeskToday(written, today), '6 written rate stays on the desk today');

const lost = stamp({
  id: 8,
  request_date: today,
  loss_reason_at: `${today}T12:00:00.000Z`,
});
assert(inDeskDayQuery(lost, today, start, []) && onDeskToday(lost, today), '8 loss marked today stays on the desk');

const multi = stamp({
  id: 20,
  request_date: today,
  quoted_at: `${today}T07:00:00.000Z`,
  asked_at: `${today}T06:00:00.000Z`,
  client_replied_at: `${today}T09:00:00.000Z`,
  rate_written_at: `${today}T11:00:00.000Z`,
});
assert(deduped([multi, multi, multi], []).length === 1, 'a row that matches several arms is kept once');

const futureQuote = stamp({
  id: 21,
  request_date: '2026-10-12',
  quoted_at: nextDay,
});
assert(inDeskDayQuery(futureQuote, today, start, []), 'gte has no upper bound, same as the old slices');
assert(!onDeskToday(futureQuote, today), 'onDeskToday still drops the next Tbilisi day');

const imported = stamp({ id: 22, source: 'import', request_date: today });
assert(!inDeskDayQuery(imported, today, start, []), 'import is not in the day OR');
assert(inDeskDayQuery(imported, today, start, [22]), 'an explicit id is included with any source');

const yesterdayOnly = stamp({ id: 23, request_date: '2026-10-12' });
assert(!inDeskDayQuery(yesterdayOnly, today, start, []), 'yesterday with no today timestamp is out');

const openWaiting = decorateActiveRow(active({ id: 1, quote_status: 'asking' }), '');
const openQuoted = decorateActiveRow(active({
  id: 2,
  quote_status: 'quoted',
  quote_state: 'quoted',
  rate: 2.5,
  quoted_at: `${today}T07:00:00.000Z`,
}), '');
const openAccepted = decorateActiveRow(active({
  id: 3,
  quote_status: 'quoted',
  client_reply: 'approved',
  approved_rate: 2.5,
  client_replied_at: `${today}T09:00:00.000Z`,
}), '');
const openBetter = decorateActiveRow(active({
  id: 4,
  quote_status: 'quoted',
  client_reply: 'better',
  wanted_rate: 2.6,
  better_decision: null,
}), '');
const openBetterAnswered = decorateActiveRow(active({
  id: 5,
  quote_status: 'quoted',
  client_reply: 'better',
  better_decision: 'accepted',
  given_rate: 2.55,
}), '');
const openWritten = decorateActiveRow(active({
  id: 6,
  rate_written_at: `${today}T11:00:00.000Z`,
  client_reply: 'approved',
}), '');
const openPaid = decorateActiveRow(active({
  id: 7,
  payment_confirmed_at: `${today}T12:00:00.000Z`,
}), '');
const txOnly = decorateActiveRow(active({
  id: 70,
  quote_status: 'quoted',
  quote_state: 'quoted',
  loss_reason: 'postponed',
  loss_reason_at: `${today}T12:00:00.000Z`,
  marked_lost_at: `${today}T12:00:00.000Z`,
}), '');
const openLost = decorateActiveRow(active({
  id: 8,
  loss_reason: 'postponed',
  loss_reason_at: `${today}T12:00:00.000Z`,
  marked_lost_at: `${today}T12:00:00.000Z`,
}), '');
const awaiting = decorateActiveRow(active({
  id: 9,
  loss_reason: 'other',
  marked_lost_at: `${today}T12:00:00.000Z`,
  loss_approved_at: null,
}), '');
const approvedLoss = decorateActiveRow(active({
  id: 10,
  loss_reason: 'postponed',
  marked_lost_at: `${today}T12:00:00.000Z`,
  loss_approved_at: `${today}T13:00:00.000Z`,
}), '');

const rows = [
  openWaiting, openQuoted, openAccepted, openBetter, openBetterAnswered,
  openWritten, openPaid, txOnly, openLost, awaiting, approvedLoss,
];
const beforeOutcomes = splitKamRequests(rows, [], today);
assert(beforeOutcomes.open.some((row) => row.id === 1), '1 new ask is open');
assert(beforeOutcomes.open.some((row) => row.id === 2), '2 quoted card stays open');
assert(beforeOutcomes.open.some((row) => row.id === 3), '3 accepted card stays open');
assert(beforeOutcomes.open.some((row) => row.id === 4), '4 better rate stays open');
assert(!lossOpenWithoutPaymentMatch(active({ id: 4, client_reply: 'better', better_decision: null }), ''), '4 better rate is not a loss while treasury has not answered');
assert(beforeOutcomes.open.some((row) => row.id === 5), '5 answered better rate stays open');
assert(!beforeOutcomes.open.some((row) => row.id === 6) && beforeOutcomes.done.some((row) => row.id === 6), '6 written rate leaves open and is went-through today');
assert(!beforeOutcomes.open.some((row) => row.id === 7) && beforeOutcomes.done.some((row) => row.id === 7), '7 confirmed payment leaves open without a transaction lookup');
assert(txOnly.loss_open && !txOnly.went_through && beforeOutcomes.open.some((row) => row.id === 70), '7b an uncorrected payment match can look like an open loss');

const txHit = applyMatchedSuccess(txOnly, new Set([70]));
assert(txHit.went_through && txHit.outcome === 'went_through' && !txHit.loss_open, '7b the outcomes id clears the loss state before paint');
const reconciled = rows.map((row) => (row.id === 70 ? txHit : row));
const afterOutcomes = splitKamRequests(reconciled, [], today);
assert(!afterOutcomes.open.some((row) => row.id === 70), '7b payment match leaves open once outcomes includes it');
assert(afterOutcomes.done.some((row) => row.id === 70), '7b payment match is went-through today');

assert(beforeOutcomes.open.some((row) => row.id === 8) && openLost.loss_open, '8 marked lost stays open and is a pending loss');
assert(awaiting.loss_open && !awaiting.loss_approved_at && beforeOutcomes.open.some((row) => row.id === 9), '9 loss awaiting approval stays open');
assert(!approvedLoss.loss_open && approvedLoss.loss_approved_at && beforeOutcomes.open.some((row) => row.id === 10), '10 approved loss is not pending and stays on the KAM open list');

const oldAsk = decorateActiveRow(active({
  id: 40,
  request_date: '2026-10-01',
  quote_status: 'asking',
}), '');
const oldMatched = applyMatchedSuccess(oldAsk, new Set([40]));
const oldSplit = splitKamRequests([oldMatched], [], today);
assert(!oldSplit.open.some((row) => row.id === 40), 'older asking row that went through leaves the open list');
assert(!oldSplit.done.some((row) => row.id === 40), 'that older row is not "went through today"');

assert(fileWon({ import_key: 'agreement:1', legacy_status: 'შესრულდა' }), 'agreement file win is local success');
assert(!fileWon({ import_key: 'agreement:1', legacy_status: 'არ შესრულდა' }), 'other agreement status is not a file win');

assert(requestVisibleToRole('admin', 'admin-1', 'kam-b'), '11 admin sees every row');
assert(requestVisibleToRole('manager', 'mgr-1', 'kam-b'), '11 manager sees every row');
assert(requestVisibleToRole('treasury', 'tr-1', 'kam-b'), '12 treasury sees every row');
assert(requestVisibleToRole('kam', 'kam-a', 'kam-a'), '13 KAM sees their own row');
assert(!requestVisibleToRole('kam', 'kam-a', 'kam-b'), '13 KAM does not see another KAM');
assert(!requestVisibleToRole('analyst', 'an-1', 'kam-a'), '14 analyst sees no request row');

const lostPage = readFileSync(resolve(root, 'src/pages/LostRequests.tsx'), 'utf8');
assert(lostPage.includes(".eq('went_through', false)"), 'lost page still requires went_through false');
assert(lostPage.includes(".is('loss_approved_at', null)"), 'approved losses stay off the lost action list');
assert(lostPage.includes(".or('loss_open.eq.true,loss_reason.not.is.null')"), 'lost page still uses loss_open or loss_reason');
assert(lostPage.includes(".from('request_outcomes')"), 'lost page stays on request_outcomes');

const setup = readFileSync(resolve(root, 'supabase/setup/33_active_reads.sql'), 'utf8');
const migration = readFileSync(resolve(root, 'supabase/migrations/20261013120000_active_reads.sql'), 'utf8');
const sql = setup.replace(/--[^\n]*/g, '');
assert(migration.includes(setup), 'migration contains the setup SQL');
assert(/with\s*\(\s*security_invoker\s*=\s*true\s*\)/i.test(sql), 'request_active is security invoker');
assert((sql.match(/language sql\s+stable\s+security invoker/gi) ?? []).length >= 2, 'both functions are security invoker');
assert(!/security\s+definer/i.test(sql), 'new SQL does not add security definer');
assert(!/drop\s+view/i.test(sql), 'new SQL does not drop a view');
assert(!/create\s+or\s+replace\s+view\s+public\.request_outcomes/i.test(sql), 'request_outcomes is not replaced');
assert(!/from\s+public\.transactions/i.test(sql), 'new SQL does not read transactions');
assert(/function public\.request_went_through_ids/i.test(sql), 'id reconciliation function exists');
assert(/returns table \(\s*id bigint\s*\)/i.test(sql), 'id function returns only id');
assert(sql.includes('and o.went_through'), 'id function uses the outcomes went_through flag');
assert(setup.includes("o.source = 'app'"), 'day function filters source app');
assert(setup.includes('o.request_date = p_today'), 'day function includes request_date');
assert(setup.includes('o.id = any'), 'day function includes explicit ids');
assert(!/limit\s+\d+/i.test(sql), 'day function has no row cap');
for (const name of ['log_request', 'treasury_quote', 'treasury_decline', 'treasury_answer_better', 'treasury_mark_rate_written', 'kam_client_reply']) {
  assert(!new RegExp(`function\\s+public\\.${name}\\b`, 'i').test(sql), `${name} is not redefined`);
}
for (const field of DESK_DAY_SINCE_FIELDS) {
  assert(setup.includes(`o.${field} >= p_start`), `day function includes ${field}`);
}
for (const column of DAY_COLUMNS.split(', ')) {
  assert(setup.includes(column), `day function returns ${column}`);
}
const viewSql = (sql.split(/create or replace function/i)[0] ?? '');
assert(!/\bas\s+went_through\b|\bas\s+outcome\b|\bas\s+loss_open\b/i.test(viewSql), 'request_active does not compute payment outcome columns');

const indexes = readFileSync(resolve(root, 'supabase/migrations/20261013140100_desk_day_indexes.sql'), 'utf8');
assert(/create index concurrently/i.test(indexes), 'indexes use CONCURRENTLY');
for (const column of ['quoted_at', 'asked_at', 'client_replied_at', 'rate_written_at', 'rate_valid_until', 'loss_reason_at']) {
  assert(indexes.includes(column), `index migration mentions ${column}`);
}
assert(!/create\s+or\s+replace\s+view\s+public\.request_outcomes|drop\s+view/i.test(indexes), 'index migration does not edit request_outcomes');

const rateDesk = readFileSync(resolve(root, 'src/pages/RateDesk.tsx'), 'utf8');
assert(rateDesk.includes('treasury_queue'), 'waiting list still uses treasury_queue');
assert(rateDesk.includes("from('request_outcomes')"), 'closedIds still reads request_outcomes');
assert(rateDesk.includes('desk_day_rows'), 'today list calls desk_day_rows');
assert(rateDesk.includes('loadDeskDaySlices'), 'slices remain until the function exists');
assert(rateDesk.includes('loadDeskDaySlicesCoalesced'), 'a failed day call uses one slice batch');
assert(rateDesk.includes('desk_day_rows failed; using the day slices for this refresh'), 'a failed day call is a quiet console report');

const requests = readFileSync(resolve(root, 'src/pages/Requests.tsx'), 'utf8');
assert(requests.includes("from('request_active')"), 'open cards read request_active');
assert(requests.includes('loadHistory'), 'history function remains');
assert(!requests.includes('loadHistory();\n  }, 10000') && requests.includes("() => { void load(); }, 10000"), '10-second poll does not reload history');
assert(requests.includes('request_went_through_ids'), 'open cards reconcile matched ids on the same load');
assert(requests.includes(".select('id')"), 'missing id function falls back to id only');
assert(!requests.includes('loadDone'), 'the full went-through select is gone');
assert(requests.includes("() => { void loadApproved(); }, 60000"), '60-second poll is the approved list only');

if (errors.length) {
  throw new Error(errors.join('\n'));
}

// silence unused type import if the checker is strict about the row type
const _typed: RequestRow = openWaiting;
if (_typed.id !== 1) throw new Error('fixture');

console.log(`phase 2 checks passed (${today}, start ${start})`);
