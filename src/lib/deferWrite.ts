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
  const name = message.includes('rate_write_deferred')
    || message.includes('kam_defer_rate_write')
    || message.includes('kam_release_rate_write')
    || message.includes('closing_approved_at')
    || message.includes('treasury_closing_queue')
    || message.includes('treasury_approve_closing')
    || message.includes('treasury_record_closing_exception');
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

let closingProbe: Promise<boolean> | null = null;

/** True when the closing-approval columns from setup 43 can be read. */
export function closingReady(): Promise<boolean> {
  if (closingProbe) return closingProbe;
  const pending = (async () => {
    const { error } = await supabase.from('requests').select('closing_approved_at').limit(1);
    if (!error) return true;
    if (isMissingDefer(error)) return false;
    closingProbe = null;
    return false;
  })();
  closingProbe = pending;
  return pending;
}

export function useClosingReady(): DeferGate {
  const [gate, setGate] = useState<DeferGate>('unknown');
  useEffect(() => {
    let live = true;
    closingReady().then((on) => {
      if (live) setGate(on ? 'on' : 'off');
    });
    return () => {
      live = false;
    };
  }, []);
  return gate;
}

export interface ClosingDeal {
  request_id: number;
  kam_name: string;
  client_id: string;
  client_name: string | null;
  sells_currency: string;
  gets_currency: string;
  amount: number | null;
  gets_amount: number | null;
  rate: number | null;
  approved_rate: number | null;
  client_replied_at: string | null;
  note: string | null;
  closing_exception_at: string | null;
  closing_exception_reason: string | null;
}

/** Null when setup 43 has not added the closing columns. An empty list is a real empty queue. */
export async function loadClosingQueue(): Promise<ClosingDeal[] | null> {
  if (!(await closingReady())) return null;
  try {
    return (await rpc<ClosingDeal[]>('treasury_closing_queue')) ?? [];
  } catch (err) {
    const error = err as { code?: string; message?: string };
    if (isMissingDefer(error)) return null;
    throw err;
  }
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

const PAGE = 1000;
const IN_BATCH = 200;

/**
 * 24 hours from client_replied_at. That column is set once when the client
 * accepts and is not moved by a later comment or edit. There is no separate
 * acceptance column. Passing the mark does not cancel the deal.
 */
export const HOLD_WINDOW_MS = 24 * 60 * 60 * 1000;

export function holdWindow(acceptedAt: string | null | undefined, now = Date.now()): {
  elapsedMinutes: number;
  deadlineIso: string;
  overdue: boolean;
} | null {
  if (!acceptedAt) return null;
  const start = new Date(acceptedAt).getTime();
  if (!Number.isFinite(start)) return null;
  return {
    elapsedMinutes: Math.max(0, Math.floor((now - start) / 60000)),
    deadlineIso: new Date(start + HOLD_WINDOW_MS).toISOString(),
    overdue: now >= start + HOLD_WINDOW_MS,
  };
}

interface FlagRow {
  id: number;
  rate_write_deferred?: boolean | null;
}

/** True when that id is still held off the write queue. */
export async function deferFlags(ids: number[]): Promise<Map<number, boolean>> {
  const flags = new Map<number, boolean>();
  if (!ids.length) return flags;
  if (!(await deferWriteReady())) return flags;
  for (let i = 0; i < ids.length; i += IN_BATCH) {
    const slice = ids.slice(i, i + IN_BATCH);
    const full = await supabase.from('requests').select('id, rate_write_deferred').in('id', slice);
    if (full.error || !full.data) continue;
    for (const row of full.data as FlagRow[]) {
      flags.set(Number(row.id), row.rate_write_deferred === true);
    }
  }
  return flags;
}

export async function deferredIds(ids: number[]): Promise<Set<number>> {
  const held = new Set<number>();
  const flags = await deferFlags(ids);
  for (const [id, deferred] of flags) {
    if (deferred) held.add(id);
  }
  return held;
}

/**
 * Older approved rows shown beside treasury_client_replies.
 * That RPC already omits a hold. If this read cannot prove an extra is free,
 * none of the extras are shown, so a held row cannot land on the write list.
 */
export async function extrasOffWriteQueue<T extends { request_id: number }>(rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  if (!(await deferWriteReady())) return rows;
  const flags = await deferFlags(rows.map((row) => row.request_id));
  for (const row of rows) {
    if (!flags.has(row.request_id)) return [];
  }
  return rows.filter((row) => flags.get(row.request_id) === false);
}

interface OpenHeldRow {
  id: number;
  rate_written_at?: string | null;
  payment_confirmed_at?: string | null;
  loss_reason?: string | null;
  marked_lost_at?: string | null;
  loss_approved_at?: string | null;
}

/**
 * Every held approval this KAM owns. Pages until the list ends.
 * RLS still applies: another KAM's rows are not returned.
 * A written rate, a payment mark, or an explicit loss is not held open.
 */
export async function deferredOpenMarks(kamId: string): Promise<Set<number>> {
  const marks = new Set<number>();
  if (!kamId || !(await deferWriteReady())) return marks;
  for (let start = 0; ; start += PAGE) {
    const full = await supabase
      .from('requests')
      .select('id, rate_written_at, payment_confirmed_at, loss_reason, marked_lost_at, loss_approved_at')
      .eq('kam_id', kamId)
      .eq('client_reply', 'approved')
      .eq('rate_write_deferred', true)
      .order('id', { ascending: true })
      .range(start, start + PAGE - 1);
    if (full.error || !full.data) break;
    const data = full.data as OpenHeldRow[];
    for (const row of data) {
      if (!isRateWriteDeferred({ ...row, client_reply: 'approved', rate_write_deferred: true })) continue;
      marks.add(Number(row.id));
    }
    if (data.length < PAGE) break;
  }
  return marks;
}

export async function deferredOpenIds(kamId: string): Promise<number[]> {
  return [...await deferredOpenMarks(kamId)];
}

export async function appendDeferredOpen(
  kamId: string,
  rows: RequestRow[],
  loadMissing: (ids: number[]) => Promise<RequestRow[]>,
): Promise<RequestRow[]> {
  const marks = await deferredOpenMarks(kamId);
  const have = new Set(rows.map((row) => row.id));
  const missing = [...marks].filter((id) => !have.has(id));
  const extra: RequestRow[] = [];
  for (let i = 0; i < missing.length; i += IN_BATCH) {
    try {
      extra.push(...await loadMissing(missing.slice(i, i + IN_BATCH)));
    } catch {
      /* a failed page stays out of this refresh; the next load tries again */
    }
  }
  return [...rows, ...extra].map((row) => ({
    ...row,
    rate_write_deferred: marks.has(row.id),
  }));
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
