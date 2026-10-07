// Turns stored market-rate snapshots into the rates sheet.
// On screen: the latest buy and sell for each source.
// Download: one block per pair, columns at 11:00, 13:00, 15:00, 17:00, 19:00,
// with Buy and Sell beside each other.
//
// A pair is BASE/QUOTE: how many quote units for 1 base.
// GEL pairs are foreign/GEL (lari per 1 USD, EUR, RUB or CNY).
// Crosses are only EUR/USD, EUR/RUB, USD/RUB, USD/CNY and EUR/CNY.
// If a source publishes the opposite pair, the rate is inverted (1/rate)
// and buy is swapped with sell. A label that is backwards but already
// carries the canonical number is only relabeled, so buy and sell are
// not crossed. Kursi used to save a cross on the GEL row (the dollar row
// became the yuan or ruble cross). Those stored rows are relabeled here.

import { getLang } from './lang';

const TZ = 'Asia/Tbilisi';

export const RATE_SLOTS = [11, 13, 15, 17, 19] as const;
export const RATE_DAY_LIMIT = 14;

/** A reading is used for an hour when that hour is its closest, within this many minutes. */
const WINDOW_MIN = 90;
/** Further away than that, up to this many minutes, only if the hour has nothing closer. */
const ORPHAN_MIN = 180;

const GEL_ORDER = ['USD', 'EUR', 'RUB', 'CNY'] as const;
const LEGS = new Set<string>(GEL_ORDER);

const CROSS_ORDER = ['EUR/USD', 'EUR/RUB', 'USD/RUB', 'USD/CNY', 'EUR/CNY'];

/** Plausible quote-per-1-base band for each pair we show. */
const SCALE: Record<string, [number, number]> = {
  'USD/GEL': [1.5, 4.2],
  'EUR/GEL': [1.6, 4.8],
  'RUB/GEL': [0.008, 0.15],
  'CNY/GEL': [0.15, 0.8],
  'EUR/USD': [0.95, 1.55],
  'EUR/RUB': [40, 200],
  'USD/RUB': [40, 200],
  'USD/CNY': [4.5, 12],
  'EUR/CNY': [5, 14],
};

const CANONICAL = new Set<string>([...GEL_ORDER.map((currency) => currency + '/GEL'), ...CROSS_ORDER]);

const SOURCE_RANK: Record<string, number> = {
  kursi: 0,
  rico: 1,
  valuto: 2,
  expresslombard: 3,
  myvaluta: 4,
  crystal: 5,
  girocredit: 6,
  fxhub: 7,
};

export interface RateSnapshot {
  source: string;
  venue: string;
  venue_kind: string;
  currency: string;
  quote_currency: string;
  buy: number | null;
  sell: number | null;
  fetched_at: string;
}

export interface SlottedRate extends RateSnapshot {
  day: string;
  slot: number;
}

export interface RateColumn {
  day: string;
  slot: number;
}

export interface RateQuote {
  buy: number | null;
  sell: number | null;
}

export interface RateGridRow {
  key: string;
  label: string;
  cells: RateQuote[];
}

export interface RateBlock {
  id: string;
  title: string;
  pair: string;
  rows: RateGridRow[];
}

export interface RateGrid {
  columns: RateColumn[];
  blocks: RateBlock[];
  updatedAt: string | null;
}

export interface CurrentBoard {
  pairs: string[];
  rows: { key: string; label: string; quotes: RateQuote[] }[];
  updatedAt: string | null;
}

export function pairAllowed(currency: string, quote: string): boolean {
  if (!LEGS.has(currency) || currency === quote) return false;
  return quote === 'GEL' || LEGS.has(quote);
}

function positiveSides(row: { buy: number | null; sell: number | null }): number[] {
  return [row.buy, row.sell].filter((value): value is number => value != null && value > 0);
}

function inScale(pair: string, value: number): boolean {
  const band = SCALE[pair];
  return !!band && value >= band[0] && value <= band[1];
}

function sidesIn(pair: string, row: { buy: number | null; sell: number | null }): boolean {
  const values = positiveSides(row);
  return values.length > 0 && values.every((value) => inScale(pair, value));
}

function invert(value: number | null): number | null {
  if (value == null || value === 0) return null;
  return 1 / value;
}

/** Opposite quote: new buy is 1/old sell, new sell is 1/old buy. */
function invertSides<T extends RateSnapshot>(row: T): T {
  if (row.buy != null && row.sell != null) {
    return { ...row, buy: invert(row.sell), sell: invert(row.buy) };
  }
  return { ...row, buy: invert(row.buy), sell: invert(row.sell) };
}

function looksReciprocal(pair: string, row: RateSnapshot): boolean {
  const values = positiveSides(row);
  if (!values.length || values.some((value) => inScale(pair, value))) return false;
  return values.every((value) => inScale(pair, 1 / value));
}

/**
 * Older Kursi fetches ignored the quote currency and kept one GEL row per
 * foreign currency. The last cross won, so USD/GEL could hold USD/CNY (~6.6)
 * or USD/RUB (~80), and EUR/GEL could hold EUR/USD (~1.12) or EUR/RUB (~90).
 * The number is already the cross, so only the quote changes.
 */
function kursiGelMisfile(row: RateSnapshot): string | null {
  if (row.source !== 'kursi' || row.quote_currency !== 'GEL') return null;
  const gel = row.currency + '/GEL';
  if (sidesIn(gel, row)) return null;
  if (row.currency === 'USD' && sidesIn('USD/CNY', row)) return 'CNY';
  if (row.currency === 'USD' && sidesIn('USD/RUB', row)) return 'RUB';
  if (row.currency === 'EUR' && sidesIn('EUR/USD', row)) return 'USD';
  if (row.currency === 'EUR' && sidesIn('EUR/RUB', row)) return 'RUB';
  return null;
}

export function orientSnapshot<T extends RateSnapshot>(row: T): T {
  const misfile = kursiGelMisfile(row);
  if (misfile) return { ...row, quote_currency: misfile };

  const pair = row.currency + '/' + row.quote_currency;
  const flipped = row.quote_currency + '/' + row.currency;
  if (CANONICAL.has(pair)) return looksReciprocal(pair, row) ? invertSides(row) : row;
  if (!CANONICAL.has(flipped)) return row;

  if (sidesIn(flipped, row)) {
    return { ...row, currency: row.quote_currency, quote_currency: row.currency };
  }
  const relabeled = { ...row, currency: row.quote_currency, quote_currency: row.currency };
  if (looksReciprocal(flipped, relabeled)) return invertSides(relabeled);
  return row;
}

export function tbilisiClock(iso: string): { day: string; minutes: number } {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
  let hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3, 5));
  if (hour === 24) hour = 0;
  return { day, minutes: hour * 60 + minute };
}

interface Candidate {
  row: RateSnapshot;
  day: string;
  slot: number;
  dist: number;
  orphan: boolean;
}

function candidatesFor(row: RateSnapshot): Candidate[] {
  const { day, minutes } = tbilisiClock(row.fetched_at);
  const dists = RATE_SLOTS.map((slot) => ({ slot, dist: Math.abs(minutes - slot * 60) }));
  const min = Math.min(...dists.map((item) => item.dist));
  if (min > ORPHAN_MIN) return [];
  const orphan = min > WINDOW_MIN;
  return dists
    .filter((item) => item.dist === min)
    .map((item) => ({ row, day, slot: item.slot, dist: item.dist, orphan }));
}

/** One snapshot per source, venue, pair and hour. The closest reading wins. */
export function assignRateSlots(rows: RateSnapshot[]): SlottedRate[] {
  const grouped = new Map<string, Candidate[]>();
  for (const raw of rows) {
    const row = orientSnapshot(raw);
    if (!pairAllowed(row.currency, row.quote_currency)) continue;
    if (row.venue_kind === 'kiosk' || row.venue.endsWith(' app')) continue;
    for (const cand of candidatesFor(row)) {
      const key = [row.source, row.venue, row.currency, row.quote_currency, cand.day, cand.slot].join('|');
      const list = grouped.get(key);
      if (list) list.push(cand);
      else grouped.set(key, [cand]);
    }
  }

  const out: SlottedRate[] = [];
  for (const list of grouped.values()) {
    const windows = list.filter((cand) => !cand.orphan);
    const pool = windows.length ? windows : list;
    pool.sort((a, b) => a.dist - b.dist || (a.row.fetched_at < b.row.fetched_at ? 1 : a.row.fetched_at > b.row.fetched_at ? -1 : 0));
    const best = pool[0];
    out.push({ ...best.row, day: best.day, slot: best.slot });
  }
  return out;
}

function compactName(venue: string): string {
  return venue.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isTbc(venue: string): boolean {
  const name = compactName(venue);
  return name === 'tbc' || name === 'tbcbank' || name === 'tbcge';
}

function isBog(venue: string): boolean {
  const name = compactName(venue);
  return name === 'bog' || name === 'bogge' || name === 'bankofgeorgia';
}

function sourceRank(source: string): number {
  return SOURCE_RANK[source] ?? 9;
}

interface RowId {
  key: string;
  label: string;
  order: number;
}

function rowIdentity(row: { source: string; venue: string; venue_kind: string }): RowId | null {
  if (row.venue_kind === 'kiosk' || row.venue.endsWith(' app')) return null;
  if (row.source === 'kursi' && row.venue_kind === 'board') return { key: 'kursi', label: 'Kursi', order: 0 };
  if (row.source === 'rico' && row.venue_kind === 'board') return { key: 'rico', label: 'Rico', order: 1 };
  if (row.venue_kind === 'bank' && isTbc(row.venue)) return { key: 'tbc', label: 'TBC', order: 2 };
  if (row.venue_kind === 'bank' && isBog(row.venue)) return { key: 'bog', label: 'BOG', order: 3 };
  if (row.source === 'valuto' && row.venue_kind === 'board') return { key: 'valuto', label: 'Valuto', order: 4 };
  if (row.source === 'expresslombard' && row.venue_kind === 'board') return { key: 'lombard', label: 'Express Lombard', order: 5 };
  if (row.source === 'crystal' && row.venue_kind === 'board') return { key: 'crystal', label: 'Crystal', order: 6 };
  if (row.source === 'girocredit' && row.venue_kind === 'board') return { key: 'giro', label: 'Giro Credit', order: 7 };
  if (row.source === 'fxhub' && row.venue_kind === 'board') return { key: 'fxhub', label: 'FX Hub', order: 8 };
  if (row.venue_kind === 'bank') {
    const name = compactName(row.venue);
    if (!name) return null;
    return { key: 'bank:' + name, label: row.venue, order: 10 };
  }
  return null;
}

interface ShownRow {
  key: string;
  label: string;
  order: number;
  labelRank: number;
}

function pairList(have: Set<string>): { currency: string; quote: string }[] {
  const gel = GEL_ORDER
    .filter((currency) => have.has(currency + '/GEL'))
    .map((currency) => ({ currency, quote: 'GEL' }));
  const crosses = CROSS_ORDER.filter((pair) => have.has(pair)).map((pair) => {
    const [currency, quote] = pair.split('/');
    return { currency, quote };
  });
  const listed = new Set<string>([...gel.map((pair) => pair.currency + '/' + pair.quote), ...CROSS_ORDER]);
  const extra = [...have].filter((pair) => !listed.has(pair)).sort().map((pair) => {
    const [currency, quote] = pair.split('/');
    return { currency, quote };
  });
  return [...gel, ...crosses, ...extra];
}

export function buildRateGrid(slotted: SlottedRate[]): RateGrid {
  const shown = new Map<string, ShownRow>();
  let updatedAt: string | null = null;
  const visible: SlottedRate[] = [];

  for (const raw of slotted) {
    const rate = orientSnapshot(raw);
    if (!pairAllowed(rate.currency, rate.quote_currency)) continue;
    const identity = rowIdentity(rate);
    if (!identity) continue;
    visible.push(rate);
    if (!updatedAt || rate.fetched_at > updatedAt) updatedAt = rate.fetched_at;
    const rank = sourceRank(rate.source);
    const prev = shown.get(identity.key);
    if (!prev) shown.set(identity.key, { ...identity, labelRank: rank });
    else if (rank < prev.labelRank) shown.set(identity.key, { ...prev, label: identity.label, labelRank: rank });
  }

  const days = [...new Set(visible.map((rate) => rate.day))].sort().slice(-RATE_DAY_LIMIT);
  const daySet = new Set(days);
  const columns: RateColumn[] = days.flatMap((day) => RATE_SLOTS.map((slot) => ({ day, slot })));
  const inWindow = visible.filter((rate) => daySet.has(rate.day));
  const ordered = [...shown.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));

  const have = new Set(inWindow.filter((rate) => rate.buy != null || rate.sell != null).map((rate) => rate.currency + '/' + rate.quote_currency));
  const blocks: RateBlock[] = [];

  for (const pair of pairList(have)) {
    const pairRates = inWindow.filter((rate) => rate.currency === pair.currency && rate.quote_currency === pair.quote);
    const gridRows: RateGridRow[] = [];
    for (const row of ordered) {
      const cells = columns.map((col) => quoteAt(pairRates, row.key, col.day, col.slot));
      if (cells.some((cell) => cell.buy != null || cell.sell != null)) gridRows.push({ key: row.key, label: row.label, cells });
    }
    if (!gridRows.length) continue;
    const title = pair.currency + '/' + pair.quote;
    blocks.push({
      id: pair.currency + '-' + pair.quote,
      title,
      pair: title,
      rows: gridRows,
    });
  }

  return { columns, blocks, updatedAt };
}

const EMPTY_QUOTE: RateQuote = { buy: null, sell: null };

/** Latest buy and sell for each source. One row per source, pairs across. */
export function buildCurrentBoard(rows: RateSnapshot[]): CurrentBoard {
  const best = new Map<string, { row: RateSnapshot; identity: RowId; rank: number }>();
  let updatedAt: string | null = null;

  for (const raw of rows) {
    const row = orientSnapshot(raw);
    if (!pairAllowed(row.currency, row.quote_currency)) continue;
    const identity = rowIdentity(row);
    if (!identity) continue;
    if (row.buy == null && row.sell == null) continue;
    if (!updatedAt || row.fetched_at > updatedAt) updatedAt = row.fetched_at;
    const key = identity.key + '|' + row.currency + '/' + row.quote_currency;
    const rank = sourceRank(row.source);
    const prev = best.get(key);
    if (!prev || row.fetched_at > prev.row.fetched_at || (row.fetched_at === prev.row.fetched_at && rank < prev.rank)) {
      best.set(key, { row, identity, rank });
    }
  }

  const shown = new Map<string, ShownRow>();
  const have = new Set<string>();
  for (const hit of best.values()) {
    have.add(hit.row.currency + '/' + hit.row.quote_currency);
    const prev = shown.get(hit.identity.key);
    if (!prev) shown.set(hit.identity.key, { ...hit.identity, labelRank: hit.rank });
    else if (hit.rank < prev.labelRank) shown.set(hit.identity.key, { ...prev, label: hit.identity.label, labelRank: hit.rank });
  }

  const pairs = pairList(have);
  const ordered = [...shown.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  const boardRows = ordered.map((identity) => ({
    key: identity.key,
    label: identity.label,
    quotes: pairs.map((pair) => {
      const hit = best.get(identity.key + '|' + pair.currency + '/' + pair.quote);
      return hit ? { buy: hit.row.buy, sell: hit.row.sell } : EMPTY_QUOTE;
    }),
  })).filter((row) => row.quotes.some((quote) => quote.buy != null || quote.sell != null));

  return {
    pairs: pairs.map((pair) => pair.currency + '/' + pair.quote),
    rows: boardRows,
    updatedAt,
  };
}

function rateText(value: number | null): string {
  return value == null ? '' : value.toFixed(4);
}

/** History spreadsheet: one block per pair, Buy and Sell under each hour. */
export function historySheet(grid: RateGrid): (string | number | null)[][] {
  const lines: (string | number | null)[][] = [];
  grid.blocks.forEach((block, index) => {
    if (index) lines.push([]);
    const hours = grid.columns.flatMap((col) => {
      const stamp = col.day + ' ' + String(col.slot).padStart(2, '0') + ':00';
      return [stamp + (getLang() === 'en' ? ' Buy' : ' ყიდვა'), stamp + (getLang() === 'en' ? ' Sell' : ' გაყიდვა')];
    });
    lines.push([block.pair]);
    lines.push([getLang() === 'en' ? 'Source' : 'წყარო', ...hours]);
    for (const row of block.rows) {
      lines.push([
        row.label,
        ...row.cells.flatMap((cell) => [rateText(cell.buy), rateText(cell.sell)]),
      ]);
    }
  });
  return lines;
}

/** Direction of the rate treasury is typing: foreign/GEL, or sells/gets for a cross. */
export function dealPair(sells: string, gets: string): { base: string; quote: string } {
  if (sells && gets && sells !== 'GEL' && gets !== 'GEL') return { base: sells, quote: gets };
  if (sells === 'GEL') return { base: gets, quote: 'GEL' };
  return { base: sells, quote: 'GEL' };
}

export interface PairSourceQuote {
  key: string;
  label: string;
  order: number;
  buy: number | null;
  sell: number | null;
}

function asRequestDirection(row: RateSnapshot, base: string, quote: string): RateSnapshot | null {
  if (row.currency === base && row.quote_currency === quote) return row;
  if (row.currency === quote && row.quote_currency === base) {
    const flipped = invertSides(row);
    return { ...flipped, currency: base, quote_currency: quote };
  }
  return null;
}

/** Latest buy and sell for one pair, in the request's direction. Sources with no rate are left out. */
export function latestQuotesForPair(rows: RateSnapshot[], base: string, quote: string): { quotes: PairSourceQuote[]; updatedAt: string | null } {
  const best = new Map<string, { quote: PairSourceQuote; at: string; rank: number }>();
  let updatedAt: string | null = null;
  for (const raw of rows) {
    const oriented = orientSnapshot(raw);
    const row = asRequestDirection(oriented, base, quote) ?? asRequestDirection(raw, base, quote);
    if (!row || (row.buy == null && row.sell == null)) continue;
    const identity = rowIdentity(raw);
    if (!identity) continue;
    if (!updatedAt || raw.fetched_at > updatedAt) updatedAt = raw.fetched_at;
    const rank = sourceRank(raw.source);
    const prev = best.get(identity.key);
    if (!prev || raw.fetched_at > prev.at || (raw.fetched_at === prev.at && rank < prev.rank)) {
      best.set(identity.key, {
        at: raw.fetched_at,
        rank,
        quote: { key: identity.key, label: identity.label, order: identity.order, buy: row.buy, sell: row.sell },
      });
    }
  }
  const quotes = [...best.values()]
    .map((hit) => hit.quote)
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return { quotes, updatedAt };
}

function quoteAt(rates: SlottedRate[], rowKey: string, day: string, slot: number): RateQuote {
  let best: SlottedRate | null = null;
  let bestRank = Infinity;
  for (const rate of rates) {
    if (rate.day !== day || rate.slot !== slot) continue;
    if (rate.buy == null && rate.sell == null) continue;
    const identity = rowIdentity(rate);
    if (identity?.key !== rowKey) continue;
    const rank = sourceRank(rate.source);
    if (!best || rank < bestRank || (rank === bestRank && rate.fetched_at > best.fetched_at)) {
      best = rate;
      bestRank = rank;
    }
  }
  return best ? { buy: best.buy, sell: best.sell } : EMPTY_QUOTE;
}
