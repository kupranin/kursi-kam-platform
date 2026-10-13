import { tbilisiDay } from './format';

/**
 * Today's rate-desk list. The boundary is midnight in Asia/Tbilisi.
 * A deal stays on this list until that midnight, then it leaves the list.
 * Nothing is deleted: older deals stay in History.
 *
 * The deal was on the desk today when any of these Tbilisi days is today:
 * request_date / requested_at (the KAM logged it and it arrived),
 * asked_at (it was put in front of treasury, including ask-again),
 * quoted_at (treasury gave a rate or sent it back — a decline sets quoted_at),
 * rate_valid_until (that rate was still live today, including on the KAM open list),
 * client_replied_at (the client approved, asked for a better rate, or rejected),
 * rate_written_at (treasury wrote the rate),
 * or loss_reason_at (a KAM marked it lost — დაიკარგა — and sent the reason).
 * Leaving the waiting queue does not remove it. A quoted deal the KAM still
 * has open, a rate already written, and a loss from today all stay until midnight.
 *
 * The fetch itself is the OR in desk_day_rows (setup 33): source = app and
 * request_date = today, or one of DESK_DAY_SINCE_FIELDS >= tbilisiDayStart(today),
 * or an explicit id. requested_at is not its own fetch. There is no upper bound
 * on those timestamps and no combined row cap. onDeskToday runs after the fetch
 * and is unchanged.
 */
export const DESK_DAY_SINCE_FIELDS = [
  'quoted_at',
  'asked_at',
  'client_replied_at',
  'rate_written_at',
  'rate_valid_until',
  'loss_reason_at',
] as const;

export type DeskDaySinceField = (typeof DESK_DAY_SINCE_FIELDS)[number];

/** Columns desk_day_rows returns. The today table reads these. */
export const DAY_COLUMNS = 'id, kam_name, client_id, client_name, sells_currency, gets_currency, amount, gets_amount, client_rate, rate, approved_rate, given_rate, quote_status, quote_state, decline_reason, client_reply, client_decline_reason, better_decision, requested_at, request_date, asked_at, quoted_at, client_replied_at, rate_valid_until, rate_written_at, outcome, went_through, loss_open, loss_reason, loss_reason_at, loss_reason_note, loss_approved_at, loss_approval_comment, loss_approver_name, payment_confirmed_at, bank, note';

export interface DeskDayStamp {
  id: number;
  source?: string | null;
  request_date: string;
  requested_at?: string | null;
  asked_at?: string | null;
  quoted_at?: string | null;
  client_replied_at?: string | null;
  rate_written_at?: string | null;
  rate_valid_until?: string | null;
  loss_reason_at?: string | null;
}

/**
 * Same OR as the old seven slices plus the id slice.
 * A row that matches more than one arm is still just included.
 */
export function inDeskDayQuery(row: DeskDayStamp, today: string, startIso: string, alsoIds: readonly number[]): boolean {
  if (alsoIds.includes(row.id)) return true;
  if (row.source !== 'app') return false;
  if (row.request_date === today) return true;
  const start = new Date(startIso).getTime();
  if (!Number.isFinite(start)) return false;
  return DESK_DAY_SINCE_FIELDS.some((field) => {
    const iso = row[field];
    if (!iso) return false;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) && ms >= start;
  });
}

/** Client filter after the query. Unchanged from the rate desk. */
export function onDeskToday(row: DeskDayStamp, today: string): boolean {
  if (row.request_date === today) return true;
  return [row.requested_at, row.asked_at, row.quoted_at, row.rate_valid_until, row.client_replied_at, row.rate_written_at, row.loss_reason_at]
    .some((iso) => tbilisiDay(iso) === today);
}
