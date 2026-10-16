// Public-board competitiveness. The log numbers come from board_competitiveness.
// This file does not read requests. A positive gap means the Kursi board
// was better for the client. Zero is a five-decimal tie.
// Time-weighted percentages live in boardCoverage.ts and do not change this log.

import { supabase } from './supabase';
import { tbilisiDayStart } from './format';
import {
  BOARD_CLUSTER_MS,
  BOARD_FRESHNESS_MS,
  type BoardFetch,
} from './boardCoverage';
import {
  parseBoardReport,
  shiftDay,
} from './boardReport';

export type {
  BoardGrain,
  BoardIncident,
  BoardPoint,
  BoardReport,
  BoardSide,
  RangePreset,
} from './boardReport';
export {
  inclusiveDays,
  parseBoardReport,
  presetRange,
  shiftDay,
  sortPairs,
  tbilisiMonday,
} from './boardReport';

export const MAX_COMP_DAYS = 92;

const cache = new Map<string, import('./boardReport').BoardReport>();

export function fmtAdvantage(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const text = Number(value).toFixed(5);
  if (text === '0.00000' || text === '-0.00000') return '0.00000';
  return text.startsWith('-') ? '−' + text.slice(1) : '+' + text;
}

export function fmtTetri(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const text = Number(value).toFixed(2);
  if (text === '0.00' || text === '-0.00') return '0.00';
  return text.startsWith('-') ? '−' + text.slice(1) : '+' + text;
}

export function fmtBps(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const text = Number(value).toFixed(1);
  if (text === '0.0' || text === '-0.0') return '0.0';
  return text.startsWith('-') ? '−' + text.slice(1) : '+' + text;
}

export function missingCompetitiveness(message: string): boolean {
  return /board_competitiveness|schema cache|could not find the function|PGRST202/i.test(message);
}

export async function loadBoardReport(from: string, to: string, pair: string | null): Promise<import('./boardReport').BoardReport> {
  const key = from + '|' + to + '|' + (pair ?? '');
  const hit = cache.get(key);
  if (hit) return hit;
  const { data, error } = await supabase.rpc('board_competitiveness', {
    p_from: from,
    p_to: to,
    p_pair: pair,
  });
  if (error) throw new Error(error.message);
  const report = parseBoardReport(data, pair);
  cache.set(key, report);
  return report;
}

function num(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface BoardSeries {
  fetches: BoardFetch[];
  truncated: boolean;
}

async function readRatePages(
  table: 'market_rates' | 'market_rate_hours',
  startIso: string,
  endIso: string,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const pageSize = 1000;
  const cap = 80000;
  const timeCol = table === 'market_rates' ? 'fetched_at' : 'hour_start';
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < cap; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select('source, venue, venue_kind, currency, quote_currency, buy, sell, fetched_at')
      .in('currency', ['USD', 'EUR', 'RUB', 'CNY'])
      .in('quote_currency', ['GEL', 'USD', 'EUR', 'RUB', 'CNY'])
      .in('venue_kind', ['board', 'bank'])
      .gte(timeCol, startIso)
      .lt(timeCol, endIso)
      .order(timeCol, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < pageSize) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

function toFetch(row: Record<string, unknown>): BoardFetch | null {
  const fetchedAt = String(row.fetched_at ?? '');
  if (!fetchedAt) return null;
  return {
    source: String(row.source ?? ''),
    venue: String(row.venue ?? ''),
    venueKind: String(row.venue_kind ?? ''),
    currency: String(row.currency ?? ''),
    quote: String(row.quote_currency ?? ''),
    buy: num(row.buy),
    sell: num(row.sell),
    fetchedAt,
  };
}

/** Public board rows for the time-weighted view. The incident log does not use this. */
export async function loadBoardSeries(
  from: string,
  to: string,
  grain: 'fetches' | 'hours',
): Promise<BoardSeries> {
  const lookback = grain === 'hours' ? BOARD_FRESHNESS_MS + 60 * 60 * 1000 : BOARD_FRESHNESS_MS + BOARD_CLUSTER_MS;
  const startMs = Date.parse(tbilisiDayStart(from)) - lookback;
  const endIso = tbilisiDayStart(shiftDay(to, 1));
  const startIso = new Date(startMs).toISOString();
  const table = grain === 'hours' ? 'market_rate_hours' : 'market_rates';
  const { rows, truncated } = await readRatePages(table, startIso, endIso);
  const fetches: BoardFetch[] = [];
  for (const row of rows) {
    const fetch = toFetch(row);
    if (fetch) fetches.push(fetch);
  }
  return { fetches, truncated };
}
