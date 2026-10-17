// Same current-rate board the Rates page shows.
// Reads market_rate_grid, then the latest market_rates rows (Crystal, Giro
// Credit, FX Hub, InexPay, and the other board sources). Ruble figures are already
// stored per 1 ruble.

import { supabase } from './supabase';
import { tbilisiDayStart } from './format';
import {
  assignRateSlots,
  bucketRateHours,
  buildCurrentBoard,
  buildRateGrid,
  orientSnapshot,
  pairAllowed,
  tbilisiHourOf,
  type CurrentBoard,
  type HourlySnap,
  type RateGrid,
  type RateSnapshot,
  type SlottedRate,
} from './rateGrid';

export interface MarketRateView {
  grid: RateGrid;
  board: CurrentBoard;
}

function num(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asList(data: unknown): unknown[] {
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(data) ? data : [];
}

function toSnapshot(row: Record<string, unknown>): RateSnapshot {
  return {
    source: String(row.source ?? ''),
    venue: String(row.venue ?? ''),
    venue_kind: String(row.venue_kind ?? ''),
    currency: String(row.currency ?? ''),
    quote_currency: String(row.quote_currency ?? ''),
    buy: num(row.buy as number | string | null),
    sell: num(row.sell as number | string | null),
    fetched_at: String(row.fetched_at ?? ''),
  };
}

function toSlotted(row: Record<string, unknown>): SlottedRate | null {
  const day = String(row.day ?? '');
  const slot = Number(row.slot);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(slot)) return null;
  return { ...toSnapshot(row), day, slot };
}

async function loadSnapshots(since: string): Promise<RateSnapshot[]> {
  const pageSize = 1000;
  const all: RateSnapshot[] = [];
  for (let from = 0; from < 20000; from += pageSize) {
    const { data, error } = await supabase
      .from('market_rates')
      .select('source, venue, venue_kind, currency, quote_currency, buy, sell, fetched_at')
      .in('currency', ['USD', 'EUR', 'RUB', 'CNY'])
      .in('quote_currency', ['GEL', 'USD', 'EUR', 'RUB', 'CNY'])
      .in('venue_kind', ['board', 'bank'])
      .gte('fetched_at', since)
      .order('fetched_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Record<string, unknown>[];
    for (const row of batch) {
      const snap = orientSnapshot(toSnapshot(row));
      if (pairAllowed(snap.currency, snap.quote_currency)) all.push(snap);
    }
    if (batch.length < pageSize) break;
  }
  return all;
}

function loadRecentSnapshots(): Promise<RateSnapshot[]> {
  return loadSnapshots(new Date(Date.now() - 2 * 86_400_000).toISOString());
}

function loadRawSnapshots(): Promise<RateSnapshot[]> {
  return loadSnapshots(new Date(Date.now() - 15 * 86_400_000).toISOString());
}

function nextCalendarDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  return next.toISOString().slice(0, 10);
}

function missingHourTable(error: { code?: string; message?: string }): boolean {
  const code = error.code ?? '';
  if (code === 'PGRST205' || code === '42P01' || code === '42703') return true;
  const message = (error.message ?? '').toLowerCase();
  const missing = message.includes('could not find') || message.includes('does not exist') || message.includes('schema cache');
  return missing && (message.includes('market_rate_hours') || message.includes('hour_start'));
}

function hourRow(row: Record<string, unknown>): HourlySnap | null {
  const snap = orientSnapshot(toSnapshot(row));
  if (!pairAllowed(snap.currency, snap.quote_currency)) return null;
  if (snap.venue_kind === 'kiosk' || snap.venue.endsWith(' app')) return null;
  const clock = tbilisiHourOf(String(row.hour_start ?? snap.fetched_at));
  if (!clock) return null;
  return { ...snap, day: clock.day, hour: clock.hour };
}

async function readHourTable(start: string, end: string): Promise<HourlySnap[] | null> {
  const pageSize = 1000;
  const all: HourlySnap[] = [];
  for (let from = 0; from < 20000; from += pageSize) {
    const { data, error } = await supabase
      .from('market_rate_hours')
      .select('source, venue, venue_kind, currency, quote_currency, buy, sell, fetched_at, hour_start')
      .in('venue_kind', ['board', 'bank'])
      .gte('hour_start', start)
      .lt('hour_start', end)
      .order('hour_start', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      if (missingHourTable(error)) return null;
      throw new Error(error.message);
    }
    const batch = (data ?? []) as Record<string, unknown>[];
    for (const row of batch) {
      const snap = hourRow(row);
      if (snap) all.push(snap);
    }
    if (batch.length < pageSize) break;
  }
  return all;
}

async function readMarketRatesBetween(start: string, end: string): Promise<RateSnapshot[]> {
  const pageSize = 1000;
  const all: RateSnapshot[] = [];
  for (let from = 0; from < 20000; from += pageSize) {
    const { data, error } = await supabase
      .from('market_rates')
      .select('source, venue, venue_kind, currency, quote_currency, buy, sell, fetched_at')
      .in('currency', ['USD', 'EUR', 'RUB', 'CNY'])
      .in('quote_currency', ['GEL', 'USD', 'EUR', 'RUB', 'CNY'])
      .in('venue_kind', ['board', 'bank'])
      .gte('fetched_at', start)
      .lt('fetched_at', end)
      .order('fetched_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Record<string, unknown>[];
    for (const row of batch) all.push(toSnapshot(row));
    if (batch.length < pageSize) break;
  }
  return all;
}

/**
 * Stored hourly snapshots from the start of fromDay through the end of toDay,
 * Asia/Tbilisi. Hours with no stored row are omitted. The hour table is used
 * when it exists; otherwise the fetches already in market_rates are bucketed.
 */
export async function loadRateHours(fromDay: string, toDay: string): Promise<HourlySnap[]> {
  const start = tbilisiDayStart(fromDay);
  const end = tbilisiDayStart(nextCalendarDay(toDay));
  const stored = await readHourTable(start, end);
  if (stored && stored.length) return stored;
  return bucketRateHours(await readMarketRatesBetween(start, end));
}

/** History grid plus the current buy/sell board, from the Rates page query. */
export async function loadMarketRateData(): Promise<MarketRateView> {
  const { data, error } = await supabase.rpc('market_rate_grid', { p_days: 14 });
  if (!error) {
    const slotted = asList(data).map((row) => toSlotted(row as Record<string, unknown>)).filter((row): row is SlottedRate => row != null);
    const latest = await loadRecentSnapshots();
    return {
      grid: buildRateGrid(slotted),
      board: buildCurrentBoard(latest.length ? latest : slotted),
    };
  }
  const missing = /market_rate_grid|schema cache|Could not find the function/i.test(error.message);
  if (!missing) throw new Error(error.message);
  const raw = await loadRawSnapshots();
  return {
    grid: buildRateGrid(assignRateSlots(raw)),
    board: buildCurrentBoard(raw),
  };
}
