// Mirrors setup 51. One row per client and bank. A blank field keeps the
// stored value. Saving one bank does not change the others. Unchecking
// sets active false and keeps the row. The next load shows only active rows.

export const SPECIAL_RATE_BANKS = ['TBC', 'BOG', 'Liberty', 'Other'] as const;

export type SpecialRateBank = (typeof SPECIAL_RATE_BANKS)[number];

export interface StoredSpecialBank {
  clientId: string;
  bank: SpecialRateBank;
  providerLabel: string | null;
  comment: string | null;
  sells: string | null;
  gets: string | null;
  rate: number | null;
  active: boolean;
}

export interface SpecialBankWrite {
  clientId: string;
  bank: SpecialRateBank;
  providerLabel: string | null;
  comment: string | null;
  sells: string | null;
  gets: string | null;
  rate: number | null;
}

const CURRENCY = /^[A-Z]{3}$/;

function cleanText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return text || null;
}

function cleanPair(
  sells: string | null | undefined,
  gets: string | null | undefined,
): { sells: string | null; gets: string | null } {
  const left = cleanText(sells)?.toUpperCase() ?? null;
  const right = cleanText(gets)?.toUpperCase() ?? null;
  if (!left || !right || left === right || !CURRENCY.test(left) || !CURRENCY.test(right)) {
    return { sells: null, gets: null };
  }
  return { sells: left, gets: right };
}

function cleanRate(rate: number | null | undefined): number | null {
  if (rate == null || !(rate > 0)) return null;
  return rate;
}

/** Insert or update one bank. Other banks on that client stay, including their active flag. */
export function upsertSpecialBank(rows: readonly StoredSpecialBank[], write: SpecialBankWrite): StoredSpecialBank[] {
  const pair = cleanPair(write.sells, write.gets);
  const comment = cleanText(write.comment);
  const rate = cleanRate(write.rate);
  const label = write.bank === 'Other' ? cleanText(write.providerLabel) : null;
  const next = rows.map((row) => ({ ...row }));
  const index = next.findIndex((row) => row.clientId === write.clientId && row.bank === write.bank);
  if (index < 0) {
    next.push({
      clientId: write.clientId,
      bank: write.bank,
      providerLabel: label,
      comment,
      sells: pair.sells,
      gets: pair.gets,
      rate,
      active: true,
    });
    return next;
  }
  const stored = next[index];
  next[index] = {
    ...stored,
    providerLabel: write.bank === 'Other' ? (label ?? stored.providerLabel) : stored.providerLabel,
    comment: comment ?? stored.comment,
    sells: pair.sells ?? stored.sells,
    gets: pair.gets ?? stored.gets,
    rate: rate ?? stored.rate,
    active: true,
  };
  return next;
}

/** Explicit clear. Every bank for this client becomes inactive. Rows and their text stay. */
export function clearSpecialBanks(rows: readonly StoredSpecialBank[], clientId: string): StoredSpecialBank[] {
  return rows.map((row) => (row.clientId === clientId ? { ...row, active: false } : { ...row }));
}

/** What the next open shows. Inactive rows are not presented as active. */
export function visibleSpecialBanks(rows: readonly StoredSpecialBank[], clientId: string): StoredSpecialBank[] {
  return rows
    .filter((row) => row.clientId === clientId && row.active)
    .sort((a, b) => SPECIAL_RATE_BANKS.indexOf(a.bank) - SPECIAL_RATE_BANKS.indexOf(b.bank));
}

/** The checkbox is on only when at least one active bank came back. */
export function specialRateBoxChecked(activeRowCount: number): boolean {
  return activeRowCount > 0;
}

/** Unchecking a box that was loaded from active rows is the explicit clear. */
export function specialTermsNeedClear(loadedActive: boolean, checked: boolean): boolean {
  return loadedActive && !checked;
}
