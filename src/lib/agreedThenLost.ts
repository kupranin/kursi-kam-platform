/**
 * Display mark only. Won/lost analytics stay on request_display_class.
 * Agreed is client_reply = approved, including a held approval.
 * Then lost is marked_lost_at, an explicit loss reason, or loss_approved_at
 * at or after client_replied_at. rate_written_at may be null or set.
 * A decline and a better-rate ask are not this mark.
 * A loss timestamp before the approval is not this mark.
 * The same rule is public.client_agreed_then_lost in setup 56.
 */
export interface AgreedLostInput {
  client_reply?: string | null;
  client_replied_at?: string | null;
  marked_lost_at?: string | null;
  loss_reason_at?: string | null;
  loss_approved_at?: string | null;
  loss_code?: string | null;
  loss_reason?: string | null;
  rate_written_at?: string | null;
  quote_status?: string | null;
  better_decision?: string | null;
  rate_write_deferred?: boolean | null;
}

function filled(value: string | null | undefined): boolean {
  return value != null && String(value).trim() !== '';
}

function atOrAfter(lossAt: string | null | undefined, agreedAt: string | null | undefined): boolean {
  if (!filled(lossAt) || !filled(agreedAt)) return false;
  return new Date(String(lossAt)).getTime() >= new Date(String(agreedAt)).getTime();
}

export function agreedThenLost(row: AgreedLostInput): boolean {
  if (row.client_reply !== 'approved') return false;
  if (!filled(row.client_replied_at)) return false;
  if (atOrAfter(row.marked_lost_at, row.client_replied_at)) return true;
  const reason = (row.loss_code ?? row.loss_reason ?? '').trim();
  if (reason && atOrAfter(row.loss_reason_at, row.client_replied_at)) return true;
  if (atOrAfter(row.loss_approved_at, row.client_replied_at)) return true;
  return false;
}

export interface AgreedThenLostMark {
  count: number;
  latestAt: string | null;
  latestRequestId: number | null;
  requestIds: number[];
}

export const EMPTY_AGREED_LOST: AgreedThenLostMark = {
  count: 0,
  latestAt: null,
  latestRequestId: null,
  requestIds: [],
};

/** One note for a later request. Several losses show the count. One shows its time. */
export function agreedLostNote(
  mark: AgreedThenLostMark,
  excludeId?: number | null,
): { count: number; latestAt: string | null } | null {
  const ids = excludeId == null ? mark.requestIds : mark.requestIds.filter((id) => id !== excludeId);
  if (!ids.length) return null;
  const showDate = ids.length === 1 && mark.latestRequestId != null && ids[0] === mark.latestRequestId;
  return { count: ids.length, latestAt: showDate ? mark.latestAt : null };
}
