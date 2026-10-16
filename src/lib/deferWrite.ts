// Held client approval. The row stays off the treasury write queue until the
// KAM releases it. Setup 43 must be pasted first. Until then this stays off
// and the single approve path is unchanged.

import { useEffect, useState } from 'react';
import { rpc, supabase } from './supabase';
import { BANKS, bankList, type RequestRow } from './types';

export type DeferGate = 'unknown' | 'on' | 'off';

let probe: Promise<boolean> | null = null;

export function isMissingDefer(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  if (code === '42703' || code === 'PGRST202' || code === 'PGRST204' || code === '42883') return true;
  const message = (error.message ?? '').toLowerCase();
  const missing = message.includes('could not find') || message.includes('does not exist') || message.includes('schema cache');
  const name = message.includes('rate_write_deferred') || message.includes('kam_defer_rate_write') || message.includes('kam_release_rate_write');
  return missing && name;
}

/** True only when requests.rate_write_deferred can be read. A missing column stays off. A transient error is not cached. */
export function deferWriteReady(): Promise<boolean> {
  if (probe) return probe;
  const pending = (async () => {
    const { error } = await supabase.from('requests').select('rate_write_deferred').limit(1);
    if (!error) return true;
    if (isMissingDefer(error)) return false;
    probe = null;
    return false;
  })();
  probe = pending;
  return pending;
}

export function useDeferWriteReady(): DeferGate {
  const [gate, setGate] = useState<DeferGate>('unknown');
  useEffect(() => {
    let live = true;
    deferWriteReady().then((on) => {
      if (live) setGate(on ? 'on' : 'off');
    });
    return () => {
      live = false;
    };
  }, []);
  return gate;
}

/** Approved, not written, and explicitly held. Not a successful payment. */
export function isRateWriteDeferred(row: {
  rate_write_deferred?: boolean | null;
  client_reply?: string | null;
  rate_written_at?: string | null;
  payment_confirmed_at?: string | null;
  went_through?: boolean | null;
  loss_reason?: string | null;
  marked_lost_at?: string | null;
  loss_approved_at?: string | null;
}): boolean {
  if (row.rate_write_deferred !== true) return false;
  if (row.client_reply !== 'approved') return false;
  if (row.rate_written_at || row.payment_confirmed_at || row.went_through) return false;
  if (row.loss_reason || row.marked_lost_at || row.loss_approved_at) return false;
  return true;
}

export async function deferredIds(ids: number[]): Promise<Set<number>> {
  const held = new Set<number>();
  if (!ids.length) return held;
  if (!(await deferWriteReady())) return held;
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { data, error } = await supabase.from('requests').select('id, rate_write_deferred').in('id', slice);
    if (error || !data) continue;
    for (const row of data as { id: number; rate_write_deferred?: boolean | null }[]) {
      if (row.rate_write_deferred) held.add(Number(row.id));
    }
  }
  return held;
}

/**
 * Held approvals that should stay on this KAM's open list.
 * A written rate, a payment mark, or an explicit loss is not held open.
 */
export async function deferredOpenIds(kamId: string): Promise<number[]> {
  if (!kamId || !(await deferWriteReady())) return [];
  const { data, error } = await supabase
    .from('requests')
    .select('id, rate_written_at, payment_confirmed_at, loss_reason, marked_lost_at, loss_approved_at')
    .eq('kam_id', kamId)
    .eq('rate_write_deferred', true)
    .limit(200);
  if (error || !data) return [];
  return (data as {
    id: number;
    rate_written_at?: string | null;
    payment_confirmed_at?: string | null;
    loss_reason?: string | null;
    marked_lost_at?: string | null;
    loss_approved_at?: string | null;
  }[])
    .filter((row) => isRateWriteDeferred({ ...row, client_reply: 'approved', rate_write_deferred: true }))
    .map((row) => Number(row.id));
}

export async function appendDeferredOpen(
  kamId: string,
  rows: RequestRow[],
  loadMissing: (ids: number[]) => Promise<RequestRow[]>,
): Promise<RequestRow[]> {
  const ids = await deferredOpenIds(kamId);
  const held = new Set(ids);
  const have = new Set(rows.map((row) => row.id));
  const missing = ids.filter((id) => !have.has(id));
  let extra: RequestRow[] = [];
  if (missing.length) {
    try {
      extra = await loadMissing(missing);
    } catch {
      extra = [];
    }
  }
  return [...rows, ...extra].map((row) => ({ ...row, rate_write_deferred: held.has(row.id) }));
}

export async function withoutDeferred<T extends { request_id: number }>(rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const held = await deferredIds(rows.map((row) => row.request_id));
  if (!held.size) return rows;
  return rows.filter((row) => !held.has(row.request_id));
}

/** The comment a KAM may change. Other fields stay as they are. Uses edit_request. */
export async function saveRequestNote(row: RequestRow, note: string): Promise<void> {
  const picked = bankList(row.bank);
  if (picked.length < 1) {
    throw new Error('აირჩიეთ ერთი ბანკი მაინც');
  }
  const sells = row.sells_currency && /^[A-Z]{3}$/.test(row.sells_currency) ? row.sells_currency : '';
  const gets = row.gets_currency && /^[A-Z]{3}$/.test(row.gets_currency) ? row.gets_currency : '';
  await rpc('edit_request', {
    p_request_id: row.id,
    p_client_id: row.client_id,
    p_client_name: (row.client_name ?? '').trim() || null,
    p_sells_currency: sells,
    p_gets_currency: gets,
    p_amount: row.amount,
    p_gets_amount: row.gets_amount ?? null,
    p_client_rate: row.client_rate ?? null,
    p_note: note.trim() || null,
    p_bank: BANKS.filter((code) => picked.includes(code)),
  });
}
