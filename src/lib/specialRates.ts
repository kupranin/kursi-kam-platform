// Client-reported special bank terms. One row per client and bank.
// Missing SQL (setup 42) must not block a request: the form hides, and a save no-ops.

import { useEffect, useState } from 'react';
import { parseRate } from './format';
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

export interface SpecialTermsDraft {
  on: boolean;
  bank: SpecialBank | '';
  providerLabel: string;
  comment: string;
  sells: string;
  gets: string;
  rate: string;
  /** True when this submit should write the selected bank. Unchanged loaded terms stay as they are. */
  dirty: boolean;
}

export const EMPTY_SPECIAL_DRAFT: SpecialTermsDraft = {
  on: false,
  bank: '',
  providerLabel: '',
  comment: '',
  sells: '',
  gets: '',
  rate: '',
  dirty: false,
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

export async function loadSpecialRates(clientIds: string[]): Promise<{ missing: boolean; rows: SpecialRateRow[] }> {
  const ids = [...new Set(clientIds.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
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
 * Writes one bank after log_request has created the client.
 * Does not throw, so a failed save cannot turn a sent request into an error.
 * Blank fields are not sent, and the database keeps the stored value.
 */
export async function saveClientSpecialRate(clientId: string, draft: SpecialTermsDraft): Promise<SpecialSaveResult> {
  if (!draft.on || !draft.bank || !draft.dirty) return 'skipped';
  const parsed = parseRate(draft.rate);
  if (!parsed.ok) return 'invalid';
  const pairOk = Boolean(draft.sells && draft.gets && draft.sells !== draft.gets);
  const { error } = await supabase.rpc('save_client_special_rate', {
    p_client_id: clientId,
    p_bank: draft.bank,
    p_provider_label: draft.bank === 'Other' ? draft.providerLabel.trim() || null : null,
    p_comment: draft.comment.trim() || null,
    p_sells_currency: pairOk ? draft.sells : null,
    p_gets_currency: pairOk ? draft.gets : null,
    p_rate: parsed.value,
  });
  if (!error) return 'saved';
  if (isMissingSpecial(error)) return 'missing';
  return 'failed';
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
