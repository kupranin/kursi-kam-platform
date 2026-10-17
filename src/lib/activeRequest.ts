import type { RequestRow } from './types';

/**
 * Columns on request_active. Same names and order as supabase/setup/33_active_reads.sql.
 * No went_through, outcome, or loss_open: those stay on request_outcomes.
 */
export const ACTIVE_COLUMNS = [
  'id',
  'kam_id',
  'kam_name',
  'client_id',
  'client_name',
  'client_kind',
  'requested_at',
  'request_date',
  'sells_currency',
  'gets_currency',
  'amount',
  'gets_amount',
  'client_rate',
  'rate',
  'note',
  'loss_reason',
  'loss_reason_at',
  'loss_reason_note',
  'source',
  'asked_at',
  'quote_status',
  'rate_valid_until',
  'quoted_at',
  'decline_reason',
  'quote_state',
  'client_reply',
  'approved_rate',
  'wanted_rate',
  'better_decision',
  'given_rate',
  'client_decline_reason',
  'client_replied_at',
  'bank',
  'rate_written_at',
  'payment_confirmed_at',
  'payment_confirmed_by',
  'loss_approved_at',
  'loss_approved_by',
  'loss_approval_comment',
  'loss_approver_name',
  'marked_lost_at',
  'import_key',
  'legacy_status',
].join(', ');

export interface ActiveSource {
  id: number;
  kam_id?: string | null;
  kam_name?: string | null;
  client_id: string;
  client_name?: string | null;
  client_kind?: string | null;
  requested_at: string;
  request_date: string;
  sells_currency?: string | null;
  gets_currency?: string | null;
  amount?: number | null;
  gets_amount?: number | null;
  client_rate?: number | null;
  rate?: number | null;
  note?: string | null;
  loss_reason?: string | null;
  loss_reason_at?: string | null;
  loss_reason_note?: string | null;
  source?: 'app' | 'import' | null;
  asked_at?: string | null;
  quote_status?: 'asking' | 'quoted' | 'declined' | null;
  rate_valid_until?: string | null;
  quoted_at?: string | null;
  decline_reason?: string | null;
  quote_state?: string | null;
  client_reply?: 'approved' | 'better' | 'declined' | null;
  approved_rate?: number | null;
  wanted_rate?: number | null;
  better_decision?: 'accepted' | 'corrected' | null;
  given_rate?: number | null;
  client_decline_reason?: string | null;
  client_replied_at?: string | null;
  bank?: string | null;
  rate_written_at?: string | null;
  payment_confirmed_at?: string | null;
  payment_confirmed_by?: string | null;
  loss_approved_at?: string | null;
  loss_approved_by?: string | null;
  loss_approval_comment?: string | null;
  loss_approver_name?: string | null;
  marked_lost_at?: string | null;
  import_key?: string | null;
  legacy_status?: string | null;
}

/** Agreement-file win. Same test as request_outcomes, no transaction lookup. */
export function fileWon(row: { import_key?: string | null; legacy_status?: string | null }): boolean {
  return !!row.import_key && row.import_key.startsWith('agreement:') && row.legacy_status === 'შესრულდა';
}

/**
 * loss_open from request columns only.
 * Matches request_outcomes when there is no successful payment match.
 * freshnessDay is the Asia/Tbilisi date of data_freshness, or '' when unknown.
 * An unknown day does not mark the row lost (same as coalesce(freshness, request_date)).
 */
export function lossOpenWithoutPaymentMatch(row: ActiveSource, freshnessDay: string): boolean {
  if (row.source !== 'app') return false;
  if (row.payment_confirmed_at || fileWon(row) || row.loss_approved_at) return false;
  if (row.rate_written_at) {
    if (row.marked_lost_at) return true;
    return (row.loss_reason ?? '').trim() !== '';
  }
  if (row.marked_lost_at) return true;
  if ((row.loss_reason ?? '').trim() !== '') return true;
  const betterWaiting = row.client_reply === 'better' && !row.better_decision;
  if (betterWaiting) return false;
  if (row.client_reply === 'declined' || row.quote_status === 'declined') return true;
  if (freshnessDay && row.request_date < freshnessDay) return true;
  return false;
}

/**
 * Desk success is a payment confirmation, or an agreement-file win.
 * Writing the rate notifies the KAM and leaves the request in progress.
 * Display class still counts a written rate as won. This flag does not.
 */
export function decorateActiveRow(row: ActiveSource, freshnessDay: string): RequestRow {
  const went = !!(row.payment_confirmed_at || fileWon(row));
  return {
    ...(row as RequestRow),
    kam_id: row.kam_id ?? '',
    kam_name: row.kam_name ?? null,
    client_name: row.client_name ?? null,
    client_kind: row.client_kind ?? '',
    sells_currency: row.sells_currency ?? null,
    gets_currency: row.gets_currency ?? null,
    amount: row.amount ?? null,
    rate: row.rate ?? null,
    note: row.note ?? null,
    loss_reason: row.loss_reason ?? null,
    source: row.source === 'import' ? 'import' : 'app',
    asked_at: row.asked_at ?? row.requested_at,
    quote_status: row.quote_status ?? 'asking',
    quote_state: (row.quote_state ?? row.quote_status ?? 'asking') as RequestRow['quote_state'],
    went_through: went,
    outcome: went ? 'went_through' : 'waiting',
    loss_open: lossOpenWithoutPaymentMatch(row, freshnessDay),
  };
}

/**
 * Apply ids that request_outcomes already marked went_through.
 * The database decided the match. This only clears the open-card loss
 * state so a payment-matched row is not shown as lost.
 */
export function applyMatchedSuccess(row: RequestRow, matchedIds: ReadonlySet<number>): RequestRow {
  if (!matchedIds.has(row.id)) return row;
  if (row.rate_written_at && !row.payment_confirmed_at) return { ...row, loss_open: false };
  return { ...row, went_through: true, outcome: 'went_through', loss_open: false };
}

/**
 * Still on the KAM open list.
 * A written rate with no payment confirmation stays here.
 * Payment confirmation, or a match that is not only a written rate, leaves.
 */
export function isActiveOpen(row: {
  id: number;
  source?: string | null;
  went_through?: boolean | null;
  outcome?: string | null;
  rate_written_at?: string | null;
  payment_confirmed_at?: string | null;
}, doneIds: ReadonlySet<number>): boolean {
  if (row.source === 'import') return false;
  if (row.payment_confirmed_at) return false;
  if (row.rate_written_at) return true;
  if (doneIds.has(row.id)) return false;
  if (row.went_through || row.outcome === 'went_through') return false;
  return true;
}

/**
 * Open cards versus payment confirmation today.
 * A written rate stays open until payment_confirmed_at.
 * doneRows is only the fallback while request_active is not in the database.
 */
export function splitKamRequests(rows: RequestRow[], doneRows: RequestRow[], today: string): {
  open: RequestRow[];
  done: RequestRow[];
  todayCount: number;
} {
  const doneIds = new Set(doneRows.filter((row) => !row.rate_written_at || row.payment_confirmed_at).map((row) => row.id));
  const open = rows.filter((row) => isActiveOpen(row, doneIds));
  const done = new Map<number, RequestRow>();
  const confirmedToday = (row: RequestRow) => !!row.payment_confirmed_at && row.request_date === today;
  for (const row of doneRows) {
    if (confirmedToday(row) || (row.went_through && !row.rate_written_at && row.request_date === today)) done.set(row.id, row);
  }
  for (const row of rows) {
    if (done.has(row.id)) continue;
    if (confirmedToday(row) || (row.went_through && !row.rate_written_at && row.request_date === today)) {
      done.set(row.id, { ...row, went_through: true, outcome: 'went_through' });
    }
  }
  const todayCount = rows.filter((row) => row.request_date === today).length;
  return { open, done: [...done.values()], todayCount };
}

/**
 * requests_read, as a pure check of the policy the view relies on.
 * Not used to filter the screen. The database still enforces this.
 */
export function requestVisibleToRole(
  role: 'admin' | 'manager' | 'treasury' | 'kam' | 'analyst',
  viewerProfileId: string,
  rowKamId: string,
): boolean {
  if (role === 'admin' || role === 'manager' || role === 'treasury') return true;
  if (role === 'kam') return viewerProfileId === rowKamId;
  return false;
}
