// Same current-rate board the Rates page shows.
// Reads market_rate_grid, then the latest market_rates rows (Crystal, Giro
// Credit, FX Hub, and the other board sources). Ruble figures are already
// stored per 1 ruble.

import { supabase } from './supabase';
import {
  assignRateSlots,
  buildCurrentBoard,
  buildRateGrid,
  orientSnapshot,
  pairAllowed,
  type CurrentBoard,
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
