import { fmtRate, fmtTime } from '../../lib/format';
import { isPendingLoss } from '../../lib/requestStatus';
import type { RequestRow } from '../../lib/types';

export type QuoteLive = 'asking' | 'quoted' | 'expired' | 'declined';

/** A quoted rate whose clock has passed is expired, even before the next reload. */
export function quoteLive(row: RequestRow, now = Date.now()): QuoteLive {
  if (row.quote_state === 'quoted' && row.rate_valid_until && new Date(row.rate_valid_until).getTime() < now) {
    return 'expired';
  }
  if (row.quote_state === 'asking' || row.quote_state === 'quoted' || row.quote_state === 'expired' || row.quote_state === 'declined') {
    return row.quote_state;
  }
  return 'asking';
}

/**
 * Treasury sent a rate, or answered a better-rate request with a new rate.
 * That answer clears the previous reply, so the KAM has to act again.
 * The reply call itself rejects an expired rate, so those stay out of this list.
 */
export function needsKamAction(row: RequestRow, now = Date.now()): boolean {
  if (isPendingLoss(row)) return false;
  if (row.client_reply) return false;
  return quoteLive(row, now) === 'quoted';
}

/** Waiting on treasury: a new ask, or a better rate they have not answered. */
export function waitingOnTreasury(row: RequestRow, now = Date.now()): boolean {
  if (needsKamAction(row, now) || isPendingLoss(row)) return false;
  if (quoteLive(row, now) === 'asking') return true;
  return row.client_reply === 'better' && !row.better_decision;
}

export function canAskAgain(row: RequestRow, now = Date.now()): boolean {
  if (isPendingLoss(row)) return false;
  const state = quoteLive(row, now);
  if (state !== 'expired' && state !== 'declined') return false;
  if (row.client_reply === 'approved') return false;
  if (row.client_reply === 'better' && !row.better_decision) return false;
  return true;
}

export interface MobileStatus {
  label: string;
  cls: string;
}

type T = (ka: string, en: string, vars?: Record<string, string | number>) => string;

export function mobileStatus(row: RequestRow, t: T, now = Date.now()): MobileStatus {
  if (row.went_through || row.outcome === 'went_through' || row.rate_written_at || row.payment_confirmed_at) {
    return { label: t('დასრულებული', 'Finished'), cls: 'pill-ok' };
  }
  if (isPendingLoss(row)) return { label: t('დაიკარგა, ხაზინას ელოდება', 'Lost, waiting on treasury'), cls: 'pill-alert' };
  if (row.client_reply === 'approved') return { label: t('დასაწერია', 'To write'), cls: 'pill-warn' };
  if (row.client_reply === 'better' && !row.better_decision) {
    return { label: t('უკეთეს კურსს ელოდება', 'Waiting on a better rate'), cls: 'pill-wait' };
  }
  if (row.client_reply === 'declined') return { label: t('უარი', 'Declined'), cls: 'pill-alert' };
  const state = quoteLive(row, now);
  if (state === 'asking') return { label: t('ხაზინას ელოდება', 'Waiting on treasury'), cls: 'pill-wait' };
  if (needsKamAction(row, now)) return { label: t('კურსი მოვიდა', 'Rate received'), cls: 'pill-gold' };
  if (state === 'expired') return { label: t('ვადა გაუვიდა', 'Expired'), cls: 'pill-wait' };
  if (state === 'declined') return { label: t('ხაზინამ უარი თქვა', 'Treasury declined'), cls: 'pill-alert' };
  return { label: t('მიმდინარე', 'In progress'), cls: 'pill-wait' };
}

export function pairLabel(row: RequestRow): string {
  if (!row.sells_currency || !row.gets_currency) return '';
  return row.sells_currency + ' / ' + row.gets_currency;
}

/** Waiting time, or how long the quoted rate still stands. */
export function cardTime(row: RequestRow, t: T, ago: (iso: string) => string, now = Date.now()): string {
  if (needsKamAction(row, now) && row.rate_valid_until) {
    return t('მოქმედებს {time}-მდე', 'Valid until {time}', { time: fmtTime(row.rate_valid_until) });
  }
  if (waitingOnTreasury(row, now)) return ago(row.client_reply === 'better' ? (row.client_replied_at || row.asked_at) : row.asked_at);
  if (row.rate_valid_until && quoteLive(row, now) === 'quoted') {
    return t('მოქმედებს {time}-მდე', 'Valid until {time}', { time: fmtTime(row.rate_valid_until) });
  }
  if (quoteLive(row, now) === 'expired' && row.rate_valid_until) {
    return t('ვადა გაუვიდა {time}-ზე', 'Expired at {time}', { time: fmtTime(row.rate_valid_until) });
  }
  return ago(row.asked_at || row.requested_at);
}

export function treasuryRate(row: RequestRow): string {
  if (row.rate == null) return '';
  return fmtRate(row.rate);
}

function byExpiry(a: RequestRow, b: RequestRow): number {
  const ta = a.rate_valid_until ? new Date(a.rate_valid_until).getTime() : Number.POSITIVE_INFINITY;
  const tb = b.rate_valid_until ? new Date(b.rate_valid_until).getTime() : Number.POSITIVE_INFINITY;
  return ta - tb;
}

function byAsked(a: RequestRow, b: RequestRow): number {
  return new Date(a.asked_at || a.requested_at).getTime() - new Date(b.asked_at || b.requested_at).getTime();
}

function isClosedActivity(row: RequestRow): boolean {
  if (row.went_through || row.outcome === 'went_through' || row.rate_written_at || row.payment_confirmed_at) return true;
  if (row.outcome === 'did_not_go_through' || row.loss_reason || row.loss_approved_at) return true;
  if (row.quote_status === 'declined' || row.quote_state === 'declined' || row.client_reply === 'declined') return true;
  return false;
}

export interface KamGroups {
  action: RequestRow[];
  waiting: RequestRow[];
  active: RequestRow[];
  recent: RequestRow[];
}

/** Home blocks. A row is in one block only. Recent stays short. */
export function groupKamRows(open: RequestRow[], done: RequestRow[], older: RequestRow[], now = Date.now()): KamGroups {
  const action = open.filter((row) => needsKamAction(row, now)).sort(byExpiry);
  const waiting = open.filter((row) => waitingOnTreasury(row, now)).sort(byAsked);
  const active = open.filter((row) => !needsKamAction(row, now) && !waitingOnTreasury(row, now));
  const seen = new Set<number>([...open, ...done].map((row) => row.id));
  const recent = [...done, ...older.filter((row) => !seen.has(row.id) && isClosedActivity(row))]
    .sort((a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime())
    .slice(0, 5);
  return { action, waiting, active, recent };
}
