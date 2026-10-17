import { displayClass, isHistoricalRequest } from '../../lib/displayClass';
import { fmtRate } from '../../lib/format';
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
 * A stored rate_valid_until does not close acceptance, including when the
 * outcomes view still labels an old row expired.
 */
export function needsKamAction(row: RequestRow, now = Date.now()): boolean {
  if (isPendingLoss(row)) return false;
  if (row.client_reply) return false;
  if (row.quote_status === 'declined' || quoteLive(row, now) === 'declined') return false;
  return row.quote_status === 'quoted' || quoteLive(row, now) === 'quoted' || quoteLive(row, now) === 'expired';
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
  if (row.display_class && isHistoricalRequest(row)) {
    if (row.display_class === 'won') return { label: t('მოგებული', 'Won'), cls: 'pill-ok' };
    return { label: t('დაკარგული', 'Lost'), cls: 'pill-alert' };
  }
  if (!row.display_class && isHistoricalRequest(row) && row.legacy_status !== undefined) {
    if (displayClass(row) === 'won') return { label: t('მოგებული', 'Won'), cls: 'pill-ok' };
    return { label: t('დაკარგული', 'Lost'), cls: 'pill-alert' };
  }
  if (row.went_through || row.outcome === 'went_through' || row.rate_written_at || row.payment_confirmed_at) {
    return { label: t('დასრულებული', 'Finished'), cls: 'pill-ok' };
  }
  if (isPendingLoss(row)) return { label: t('დაიკარგა, ხაზინას ელოდება', 'Lost, waiting on treasury'), cls: 'pill-alert' };
  if (row.client_reply === 'approved' && row.rate_write_deferred && !row.rate_written_at && !row.payment_confirmed_at && !row.went_through && !row.loss_reason && !row.marked_lost_at && !row.loss_approved_at) {
    return { label: t('კლიენტმა დაადასტურა — გაწერას ელოდება', 'Client confirmed — waiting to write the rate'), cls: 'pill-warn' };
  }
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

/** Waiting time. A quote does not show an acceptance countdown. */
export function cardTime(row: RequestRow, t: T, ago: (iso: string) => string, now = Date.now()): string {
  if (waitingOnTreasury(row, now)) return ago(row.client_reply === 'better' ? (row.client_replied_at || row.asked_at) : row.asked_at);
  return ago(row.asked_at || row.requested_at);
}

export function treasuryRate(row: RequestRow): string {
  if (row.rate == null) return '';
  return fmtRate(row.rate);
}

