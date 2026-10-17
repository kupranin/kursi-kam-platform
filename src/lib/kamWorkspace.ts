import { tbilisiDay } from './format';
import type { RequestRow } from './types';
import { needsKamAction, waitingOnTreasury } from '../components/mobile/kamBuckets';

/**
 * Same hold as isRateWriteDeferred: approved, not written, not paid, not lost.
 * Kept here so this file does not load the database client.
 */
function isHeld(row: RequestRow): boolean {
  if (row.rate_write_deferred !== true) return false;
  if (row.client_reply !== 'approved') return false;
  if (row.rate_written_at || row.payment_confirmed_at || row.went_through) return false;
  if (row.loss_reason || row.marked_lost_at || row.loss_approved_at) return false;
  return true;
}

/** Approved and still waiting for treasury to write. Not a held rate. */
function awaitingWrite(row: RequestRow): boolean {
  if (row.client_reply !== 'approved') return false;
  if (isHeld(row)) return false;
  if (row.rate_written_at || row.payment_confirmed_at || row.went_through) return false;
  if (row.loss_reason || row.marked_lost_at || row.loss_approved_at || row.loss_open) return false;
  return true;
}

function byExpiry(a: RequestRow, b: RequestRow): number {
  const ta = a.rate_valid_until ? new Date(a.rate_valid_until).getTime() : Number.POSITIVE_INFINITY;
  const tb = b.rate_valid_until ? new Date(b.rate_valid_until).getTime() : Number.POSITIVE_INFINITY;
  return ta - tb;
}

function byAsked(a: RequestRow, b: RequestRow): number {
  return new Date(a.asked_at || a.requested_at).getTime() - new Date(b.asked_at || b.requested_at).getTime();
}

export interface KamGroups {
  awaitingClient: RequestRow[];
  awaitingTreasury: RequestRow[];
  held: RequestRow[];
  followUp: RequestRow[];
  stillOpen: RequestRow[];
  writtenToday: RequestRow[];
  paidToday: RequestRow[];
  lostToday: RequestRow[];
}

/**
 * Open work, one row in one stage.
 * Follow-up is the 7-day list with no loss reason, minus rows already staged.
 */
export function openWorkspace(open: RequestRow[], followUp: RequestRow[], now = Date.now()): Pick<KamGroups, 'awaitingClient' | 'awaitingTreasury' | 'held' | 'followUp' | 'stillOpen'> {
  const held = open.filter((row) => isHeld(row));
  const heldIds = new Set(held.map((row) => row.id));
  const awaitingClient = open.filter((row) => !heldIds.has(row.id) && needsKamAction(row, now)).sort(byExpiry);
  const awaitingTreasury = open
    .filter((row) => !heldIds.has(row.id) && (waitingOnTreasury(row, now) || awaitingWrite(row)))
    .sort(byAsked);
  const placed = new Set<number>([
    ...heldIds,
    ...awaitingClient.map((row) => row.id),
    ...awaitingTreasury.map((row) => row.id),
  ]);
  const follow = followUp.filter((row) => !placed.has(row.id));
  const followIds = new Set(follow.map((row) => row.id));
  const stillOpen = open.filter((row) => !placed.has(row.id) && !followIds.has(row.id));
  return { awaitingClient, awaitingTreasury, held, followUp: follow, stillOpen };
}

function lossReasonAt(row: RequestRow): string | null {
  const stamped = row as RequestRow & { loss_reason_at?: string | null };
  return stamped.loss_reason_at ?? null;
}

/** Decline or loss whose own timestamp is today. A written rate is not this. */
function lostOn(row: RequestRow, today: string): boolean {
  if (tbilisiDay(row.marked_lost_at) === today) return true;
  if (tbilisiDay(lossReasonAt(row)) === today) return true;
  if (row.client_reply === 'declined' && tbilisiDay(row.client_replied_at) === today) return true;
  if ((row.quote_status === 'declined' || row.quote_state === 'declined') && tbilisiDay(row.quoted_at) === today) return true;
  if (tbilisiDay(row.loss_approved_at) === today && (row.loss_reason || row.marked_lost_at)) return true;
  return false;
}

function byStamp(pick: (row: RequestRow) => string | null | undefined) {
  return (a: RequestRow, b: RequestRow) => new Date(pick(b) || 0).getTime() - new Date(pick(a) || 0).getTime();
}

/**
 * Today's activity uses the event time in Asia/Tbilisi.
 * request_date and an import's arrival do not qualify.
 * A row can be both written and paid. Those are different events.
 */
export function todayActivity(rows: RequestRow[], today: string): Pick<KamGroups, 'writtenToday' | 'paidToday' | 'lostToday'> {
  const writtenToday: RequestRow[] = [];
  const paidToday: RequestRow[] = [];
  const lostToday: RequestRow[] = [];
  const seenW = new Set<number>();
  const seenP = new Set<number>();
  const seenL = new Set<number>();
  for (const row of rows) {
    if (tbilisiDay(row.rate_written_at) === today && !seenW.has(row.id)) {
      writtenToday.push(row);
      seenW.add(row.id);
    }
    if (tbilisiDay(row.payment_confirmed_at) === today && !seenP.has(row.id)) {
      paidToday.push(row);
      seenP.add(row.id);
    }
    if (lostOn(row, today) && !seenL.has(row.id)) {
      lostToday.push(row);
      seenL.add(row.id);
    }
  }
  writtenToday.sort(byStamp((row) => row.rate_written_at));
  paidToday.sort(byStamp((row) => row.payment_confirmed_at));
  lostToday.sort(byStamp((row) => row.marked_lost_at || lossReasonAt(row) || row.client_replied_at || row.quoted_at));
  return { writtenToday, paidToday, lostToday };
}

export function groupKamRows(open: RequestRow[], activity: RequestRow[], followUp: RequestRow[], today: string, now = Date.now()): KamGroups {
  return { ...openWorkspace(open, followUp, now), ...todayActivity(activity, today) };
}
