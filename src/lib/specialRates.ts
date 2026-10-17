// Client-reported special bank terms. One row per client and bank.
// Missing SQL (setup 42) must not block a request: the form hides, and a save no-ops.

import { useEffect, useState } from 'react';
import { cappedClientIds } from './clientOwnership';
import { parseRate } from './format';
import { specialBanksToWrite, type OpenSpecialBank } from './specialRateStatus';
import { supabase } from './supabase';

export const SPECIAL_BANKS = ['TBC', 'BOG', 'Liberty', 'Other'] as const;

export type SpecialBank = (typeof SPECIAL_BANKS)[number];

export interface SpecialRateRow {
  client_id: string;
  bank: SpecialBank;
  provider_label: string | null;
  comment: string | null;
  sells_currency: string | null;
  gets_currency: string | null;
  rate: number | null;
  updated_at: string;
  updated_by_name: string | null;
}

/** One bank the form is holding. A submit can hold several, each with its own fields. */
export interface SpecialBankDraft {
  bank: SpecialBank;
  providerLabel: string;
  comment: string;
  sells: string;
  gets: string;
  rate: string;
  /** True when this submit should write this bank. An unchanged loaded bank stays as it is. */
  dirty: boolean;
}

export interface SpecialTermsDraft {
  on: boolean;
  /** Every bank open on the form, not only the chip the KAM touched last. */
  banks: SpecialBankDraft[];
  /** True when active terms were loaded and the box is now off. Saving marks those rows inactive. */
  clear: boolean;
}

export const EMPTY_SPECIAL_DRAFT: SpecialTermsDraft = {
  on: false,
  banks: [],
  clear: false,
};

export type SpecialSaveResult = 'saved' | 'skipped' | 'missing' | 'invalid' | 'failed';

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asBank(value: unknown): SpecialBank | null {
  return value === 'TBC' || value === 'BOG' || value === 'Liberty' || value === 'Other' ? value : null;
}

/** True when setup 42 has not been pasted, or the table the function reads is absent. */
export function isMissingSpecial(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42703' || code === '42883') return true;
  const message = (error.message ?? '').toLowerCase();
  const missing = message.includes('could not find') || message.includes('does not exist') || message.includes('schema cache');
  const name = message.includes('special_rate') || message.includes('client_special');
  return missing && name;
}

function asRow(raw: Record<string, unknown>): SpecialRateRow | null {
  const bank = asBank(raw.bank);
  const clientId = String(raw.client_id ?? '');
  if (!bank || !clientId) return null;
  return {
    client_id: clientId,
    bank,
    provider_label: raw.provider_label ? String(raw.provider_label) : null,
    comment: raw.comment ? String(raw.comment) : null,
    sells_currency: raw.sells_currency ? String(raw.sells_currency) : null,
    gets_currency: raw.gets_currency ? String(raw.gets_currency) : null,
    rate: asNumber(raw.rate),
    updated_at: String(raw.updated_at ?? ''),
    updated_by_name: raw.updated_by_name ? String(raw.updated_by_name) : null,
  };
}

/** Active rows only. The database omits a bank after the special-rate box is cleared. */
export async function loadSpecialRates(clientIds: string[]): Promise<{ missing: boolean; rows: SpecialRateRow[] }> {
  const ids = cappedClientIds(clientIds);
  const { data, error } = await supabase.rpc('client_special_rates', { p_client_ids: ids });
  if (error) {
    if (isMissingSpecial(error)) return { missing: true, rows: [] };
    return { missing: false, rows: [] };
  }
  const rows = (Array.isArray(data) ? data : [])
    .map((row) => asRow(row as Record<string, unknown>))
    .filter((row): row is SpecialRateRow => row != null);
  return { missing: false, rows };
}

/**
 * Writes every dirty bank, or clears the special-rate status, after log_request has created the client.
 * Does not throw, so a failed save cannot turn a sent request into an error.
 * Each bank is its own call. Saving BOG does not clear TBC.
 * Blank fields are not sent, and the database keeps the stored value.
 * Unchecking is the explicit clear: rows stay, and active becomes false on every bank.
 * This does not write a request rate or a negotiated adjustment.
 */
export async function saveClientSpecialRate(clientId: string, draft: SpecialTermsDraft): Promise<SpecialSaveResult> {
  if (!draft.on) {
    if (!draft.clear) return 'skipped';
    const { error } = await supabase.rpc('clear_client_special_rates', { p_client_id: clientId });
    if (!error) return 'saved';
    if (isMissingSpecial(error)) return 'missing';
    return 'failed';
  }
  const pending: OpenSpecialBank[] = [];
  let invalid = false;
  for (const bank of draft.banks) {
    if (!bank.dirty) continue;
    const parsed = parseRate(bank.rate);
    if (!parsed.ok) {
      invalid = true;
      continue;
    }
    const pairOk = Boolean(bank.sells && bank.gets && bank.sells !== bank.gets);
    pending.push({
      bank: bank.bank,
      providerLabel: bank.bank === 'Other' ? bank.providerLabel : '',
      comment: bank.comment,
      sells: pairOk ? bank.sells : '',
      gets: pairOk ? bank.gets : '',
      rate: parsed.value,
      dirty: true,
    });
  }
  const writes = specialBanksToWrite(clientId, pending);
  if (!writes.length && !invalid) return 'skipped';
  let saved = false;
  let failed = false;
  for (const write of writes) {
    const { error } = await supabase.rpc('save_client_special_rate', {
      p_client_id: write.clientId,
      p_bank: write.bank,
      p_provider_label: write.bank === 'Other' ? (write.providerLabel?.trim() || null) : null,
      p_comment: write.comment?.trim() || null,
      p_sells_currency: write.sells || null,
      p_gets_currency: write.gets || null,
      p_rate: write.rate,
    });
    if (!error) {
      saved = true;
      continue;
    }
    if (isMissingSpecial(error)) return saved ? 'failed' : 'missing';
    failed = true;
  }
  if (failed) return 'failed';
  if (invalid) return 'invalid';
  return saved ? 'saved' : 'skipped';
}

export function specialRatesByClient(rows: SpecialRateRow[]): Map<string, SpecialRateRow[]> {
  const map = new Map<string, SpecialRateRow[]>();
  for (const row of rows) {
    const list = map.get(row.client_id);
    if (list) list.push(row);
    else map.set(row.client_id, [row]);
  }
  return map;
}

/** Loads terms for these clients. An empty map when setup 42 is absent. refreshKey reloads when the desk queue changes. */
export function useSpecialRates(clientIds: string[], refreshKey = ''): Map<string, SpecialRateRow[]> {
  const idsKey = [...new Set(clientIds.map((id) => id.trim()).filter(Boolean))].sort().join(',');
  const key = refreshKey + '\n' + idsKey;
  const [map, setMap] = useState<Map<string, SpecialRateRow[]>>(new Map());

  useEffect(() => {
    if (!idsKey) {
      setMap(new Map());
      return;
    }
    let live = true;
    loadSpecialRates(idsKey.split(','))
      .then((result) => {
        if (!live) return;
        setMap(result.missing ? new Map() : specialRatesByClient(result.rows));
      })
      .catch(() => {
        if (live) setMap(new Map());
      });
    return () => {
      live = false;
    };
  }, [key]);

  return map;
}
