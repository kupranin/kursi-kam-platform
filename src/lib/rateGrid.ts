// Turns stored market-rate snapshots into the rates sheet:
// one block per pair and side, columns at 11:00, 13:00, 15:00, 17:00, 19:00.

const TZ = 'Asia/Tbilisi';

export const RATE_SLOTS = [11, 13, 15, 17, 19] as const;
export const RATE_DAY_LIMIT = 14;

/** A reading is used for an hour when that hour is its closest, within this many minutes. */
const WINDOW_MIN = 90;
/** Further away than that, up to this many minutes, only if the hour has nothing closer. */
const ORPHAN_MIN = 180;

const GEL_ORDER = ['USD', 'EUR', 'RUB', 'CNY'] as const;
const LEGS = new Set<string>(GEL_ORDER);

const CROSS_ORDER = [
  'EUR/USD', 'USD/EUR',
  'USD/RUB', 'RUB/USD',
  'EUR/RUB', 'RUB/EUR',
  'USD/CNY', 'CNY/USD',
  'EUR/CNY', 'CNY/EUR',
  'RUB/CNY', 'CNY/RUB',
];

const SOURCE_RANK: Record<string, number> = {
  kursi: 0,
  rico: 1,
  valuto: 2,
  expresslombard: 3,
  myvaluta: 4,
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

export interface RateGridRow {
  key: string;
  label: string;
  cells: (number | null)[];
}

export interface RateBlock {
  id: string;
  title: string;
  pair: string;
  side: 'buy' | 'sell';
  rows: RateGridRow[];
}

export interface RateGrid {
  columns: RateColumn[];
  blocks: RateBlock[];
  updatedAt: string | null;
}

export function pairAllowed(currency: string, quote: string): boolean {
  if (!LEGS.has(currency) || currency === quote) return false;
  return quote === 'GEL' || LEGS.has(quote);
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
  for (const row of rows) {
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

  for (const rate of slotted) {
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
    for (const side of ['buy', 'sell'] as const) {
      const gridRows: RateGridRow[] = [];
      for (const row of ordered) {
        const cells = columns.map((col) => figureAt(pairRates, row.key, col.day, col.slot, side));
        if (cells.some((value) => value != null)) gridRows.push({ key: row.key, label: row.label, cells });
      }
      if (!gridRows.length) continue;
      const title = pair.currency + '/' + pair.quote + ' ' + side;
      blocks.push({
        id: pair.currency + '-' + pair.quote + '-' + side,
        title,
        pair: pair.currency + '/' + pair.quote,
        side,
        rows: gridRows,
      });
    }
  }

  return { columns, blocks, updatedAt };
}

function figureAt(rates: SlottedRate[], rowKey: string, day: string, slot: number, side: 'buy' | 'sell'): number | null {
  let best: { rank: number; fetched_at: string; value: number } | null = null;
  for (const rate of rates) {
    if (rate.day !== day || rate.slot !== slot) continue;
    const value = rate[side];
    if (value == null) continue;
    const identity = rowIdentity(rate);
    if (identity?.key !== rowKey) continue;
    const rank = sourceRank(rate.source);
    if (!best || rank < best.rank || (rank === best.rank && rate.fetched_at > best.fetched_at)) {
      best = { rank, fetched_at: rate.fetched_at, value };
    }
  }
  return best ? best.value : null;
}
