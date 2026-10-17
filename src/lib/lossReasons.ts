import type { LossReason } from './types';

/** Choices a KAM can mark. Order is the picker order. */
export const LOSS_PICKER: LossReason[] = [
  { code: 'better_rate', label_en: 'Better rate elsewhere', label_ka: 'სხვაგან უკეთესი კურსი', sort_order: 10, active: true },
  { code: 'postponed', label_en: 'Postponed', label_ka: 'გადადო', sort_order: 20, active: true },
  { code: 'did_not_specify', label_en: 'Did not specify reason', label_ka: 'მიზეზი არ დაუზუსტებია', sort_order: 30, active: true },
  { code: 'client_financial', label_en: 'Client financial issues', label_ka: 'კლიენტის ფინანსური პრობლემა', sort_order: 40, active: true },
  { code: 'bank_blocked', label_en: 'Bank blocked transfer', label_ka: 'ბანკმა გადარიცხვა დაბლოკა', sort_order: 50, active: true },
  { code: 'liquidity', label_en: 'Our liquidity issue', label_ka: 'ჩვენი ლიკვიდობის პრობლემა', sort_order: 60, active: true },
  { code: 'timing', label_en: 'Our timing issue', label_ka: 'ჩვენი დროის პრობლემა', sort_order: 70, active: true },
  { code: 'other', label_en: 'Other (specify)', label_ka: 'სხვა (მიუთითეთ)', sort_order: 80, active: true },
];

/** Older codes stay readable. The picker does not offer them. */
export const RETIRED_LOSS_LABELS: Record<string, [string, string]> = {
  funds_not_received: ['თანხა არ ჩაურიცხავს', 'Funds not received'],
};

export type BetterRatePlaceId = 'tbc' | 'bog' | 'liberty' | 'other_bank' | 'fx_hub' | 'cash_exchange' | 'other';

export interface BetterRatePlace {
  id: BetterRatePlaceId;
  /** Written into loss_reason_note. Empty when the KAM must type a comment instead. */
  note: string;
  ka: string;
  en: string;
}

export const BETTER_RATE_PLACES: BetterRatePlace[] = [
  { id: 'tbc', note: 'TBC', ka: 'TBC', en: 'TBC' },
  { id: 'bog', note: 'BOG', ka: 'BOG', en: 'BOG' },
  { id: 'liberty', note: 'Liberty', ka: 'Liberty', en: 'Liberty' },
  { id: 'other_bank', note: 'other bank', ka: 'სხვა ბანკი', en: 'other bank' },
  { id: 'fx_hub', note: 'FX Hub', ka: 'FX Hub', en: 'FX Hub' },
  { id: 'cash_exchange', note: 'Cash exchange', ka: 'ნაღდი გაცვლა', en: 'Cash exchange' },
  { id: 'other', note: '', ka: 'სხვა', en: 'other' },
];

export function reasonText(reason: LossReason, lang: 'ka' | 'en'): string {
  return (lang === 'en' ? reason.label_en : reason.label_ka).trim() || reason.label_en || reason.label_ka;
}

export function reasonNeedsComment(reason: LossReason | undefined): boolean {
  if (!reason) return false;
  if (reason.code === 'other') return true;
  const label = reason.label_en.trim().toLowerCase();
  return label === 'other' || label === 'other (specify)';
}

export function isBetterRate(reason: LossReason | undefined): boolean {
  return reason?.code === 'better_rate';
}

/** Known better-rate places stay readable in the current language. A typed comment is shown as stored. */
export function lossNoteLabel(note: string | null | undefined, lang: 'ka' | 'en'): string {
  const text = (note ?? '').trim();
  if (!text) return '';
  const place = BETTER_RATE_PLACES.find((item) => item.note === text);
  if (!place) return text;
  return lang === 'en' ? place.en : place.ka;
}

export function lossDetailMessage(error: 'reason' | 'place' | 'comment'): [string, string] {
  if (error === 'place') return ['მიუთითეთ, სად მიიღო უკეთესი კურსი.', 'Say where the better rate was.'];
  if (error === 'comment') return ['სხვა მიზეზს კომენტარი სჭირდება.', 'Other needs a comment.'];
  return ['აირჩიეთ მიზეზი.', 'Choose a reason.'];
}

/**
 * What mark_request_lost stores in loss_reason_note.
 * better_rate keeps the place (TBC, BOG, Liberty, other bank, FX Hub, Cash exchange, or the typed comment).
 * other keeps the typed comment. Every other reason stores no note.
 */
export function lossMarkDetail(
  reason: LossReason | undefined,
  placeId: BetterRatePlaceId | null,
  comment: string,
): { detail: string | null; error: 'reason' | 'place' | 'comment' | null } {
  if (!reason) return { detail: null, error: 'reason' };
  const text = comment.trim();
  if (isBetterRate(reason)) {
    const place = BETTER_RATE_PLACES.find((item) => item.id === placeId);
    if (!place) return { detail: null, error: 'place' };
    if (place.id === 'other') {
      if (!text || text.length > 500) return { detail: null, error: 'comment' };
      return { detail: text, error: null };
    }
    return { detail: place.note, error: null };
  }
  if (reasonNeedsComment(reason)) {
    if (!text || text.length > 500) return { detail: null, error: 'comment' };
    return { detail: text, error: null };
  }
  return { detail: null, error: null };
}
