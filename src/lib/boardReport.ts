// Maps the board_competitiveness payload into the log rows.
// Field values are copied through. Duration, gaps, and standings are not
// recalculated here.

import { tbilisiDayStart, todayTbilisi } from './format';

const PAIR_ORDER = ['USD/GEL', 'EUR/GEL', 'RUB/GEL', 'CNY/GEL', 'EUR/USD', 'EUR/RUB', 'USD/RUB', 'USD/CNY', 'EUR/CNY'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type BoardGrain = 'fetches' | 'hours' | 'none';
export type BoardSide = 'buy' | 'sell';
export type RangePreset = 'today' | '7d' | 'week' | 'prev' | 'custom';

export interface BoardPoint {
  at: string;
  pair: string;
  side: BoardSide;
  kursiRate: number | null;
  bestRate: number | null;
  bestNames: string;
  bestKeys: string[];
  advantage: number | null;
  standing: string;
  tetri: number | null;
  bps: number | null;
}

export interface BoardIncident {
  id: string;
  pair: string;
  side: BoardSide;
  startedAt: string;
  endedAt: string | null;
  endKind: 'flip' | 'break' | 'open';
  durationMinutes: number;
  kursiRate: number | null;
  bestRate: number | null;
  bestNames: string;
  bestKeys: string[];
  bestKeysAny: string[];
  maxGap: number | null;
  avgGap: number | null;
  avgWeight: 'time' | 'equal';
  startKursiRate: number | null;
  endKursiRate: number | null;
  startNames: string;
  endNames: string;
  tetri: number | null;
  bps: number | null;
  points: BoardPoint[];
}

export interface BoardReport {
  grain: BoardGrain;
  reason: string | null;
  pairs: string[];
  observations: BoardPoint[];
  incidents: BoardIncident[];
}

export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function inclusiveDays(from: string, to: string): number {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

function weekdayIndex(day: string): number {
  const mid = new Date(new Date(tbilisiDayStart(day)).getTime() + 12 * 3_600_000);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tbilisi', weekday: 'short' }).format(mid);
  const index = WEEKDAYS.indexOf(name);
  return index < 0 ? 1 : index;
}

export function tbilisiMonday(day: string): string {
  const wd = weekdayIndex(day);
  return shiftDay(day, wd === 0 ? -6 : 1 - wd);
}

export function presetRange(preset: Exclude<RangePreset, 'custom'>): { from: string; to: string } {
  const today = todayTbilisi();
  if (preset === 'today') return { from: today, to: today };
  if (preset === '7d') return { from: shiftDay(today, -6), to: today };
  if (preset === 'week') return { from: tbilisiMonday(today), to: today };
  const monday = tbilisiMonday(today);
  return { from: shiftDay(monday, -7), to: shiftDay(monday, -1) };
}

export function sortPairs(pairs: readonly string[]): string[] {
  return [...pairs].sort((a, b) => {
    const ia = PAIR_ORDER.indexOf(a);
    const ib = PAIR_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

function num(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter((item) => item.length > 0);
}

function sideOf(value: unknown): BoardSide {
  return value === 'sell' ? 'sell' : 'buy';
}

function pointOf(row: Record<string, unknown>, pair: string, side: BoardSide): BoardPoint {
  return {
    at: String(row.at ?? ''),
    pair: String(row.pair ?? pair),
    side: sideOf(row.side ?? side),
    kursiRate: num(row.kursi_rate),
    bestRate: num(row.best_rate),
    bestNames: String(row.best_names ?? ''),
    bestKeys: strings(row.best_keys),
    advantage: num(row.advantage),
    standing: String(row.standing ?? ''),
    tetri: num(row.tetri),
    bps: num(row.bps),
  };
}

function incidentOf(row: Record<string, unknown>): BoardIncident {
  const pair = String(row.pair ?? '');
  const side = sideOf(row.side);
  const points = Array.isArray(row.points)
    ? row.points.map((item) => pointOf(item as Record<string, unknown>, pair, side))
    : [];
  const endKind = row.end_kind === 'flip' || row.end_kind === 'break' || row.end_kind === 'open' ? row.end_kind : 'open';
  return {
    id: String(row.id ?? pair + '|' + side + '|' + String(row.started_at ?? '')),
    pair,
    side,
    startedAt: String(row.started_at ?? ''),
    endedAt: row.ended_at == null || row.ended_at === '' ? null : String(row.ended_at),
    endKind,
    durationMinutes: num(row.duration_minutes) ?? 0,
    kursiRate: num(row.kursi_rate),
    bestRate: num(row.best_rate),
    bestNames: String(row.best_names ?? ''),
    bestKeys: strings(row.best_keys),
    bestKeysAny: strings(row.best_keys_any),
    maxGap: num(row.max_gap),
    avgGap: num(row.avg_gap),
    avgWeight: row.avg_weight === 'equal' ? 'equal' : 'time',
    startKursiRate: num(row.start_kursi_rate),
    endKursiRate: num(row.end_kursi_rate),
    startNames: String(row.start_names ?? ''),
    endNames: String(row.end_names ?? ''),
    tetri: num(row.tetri),
    bps: num(row.bps),
    points,
  };
}

function asObject(data: unknown): Record<string, unknown> {
  if (typeof data === 'string') {
    try {
      return asObject(JSON.parse(data) as unknown);
    } catch {
      return {};
    }
  }
  return data && typeof data === 'object' ? data as Record<string, unknown> : {};
}

/** Same object the log renders. Does not recompute a gap or a duration. */
export function parseBoardReport(data: unknown, pairHint: string | null): BoardReport {
  const body = asObject(data);
  const grain = body.grain === 'fetches' || body.grain === 'hours' || body.grain === 'none' ? body.grain : 'none';
  return {
    grain,
    reason: body.reason == null ? null : String(body.reason),
    pairs: sortPairs(strings(body.pairs)),
    observations: Array.isArray(body.observations)
      ? body.observations.map((item) => pointOf(item as Record<string, unknown>, pairHint ?? '', 'buy'))
      : [],
    incidents: Array.isArray(body.incidents)
      ? body.incidents.map((item) => incidentOf(item as Record<string, unknown>))
      : [],
  };
}
