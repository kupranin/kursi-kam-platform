// Time-weighted public-board coverage. Separate from the incident log.
// A rate is valid for BOARD_FRESHNESS_MS after the cluster that stored it.
// Buy: higher is better for the client. Sell: lower is better.
// Advantage matches the log: positive means the Kursi board is better.
// Zero at five decimals is a tie, and a tie is competitive.

import { orientSnapshot, pairAllowed, type RateSnapshot } from './rateGrid';
import {
  shiftDay,
  sortPairs,
  type BoardSide,
} from './boardReport';

export type { BoardSide };
import { tbilisiDay, tbilisiDayStart } from './format';

/** 30-minute job, plus the 10-minute cluster window, plus a few minutes of slack. */
export const BOARD_FRESHNESS_MS = 45 * 60 * 1000;
/** Stamps further apart than this are different runs, same rule as the log's SQL. */
export const BOARD_CLUSTER_MS = 10 * 60 * 1000;

export interface BoardFetch {
  source: string;
  venue: string;
  venueKind: string;
  currency: string;
  quote: string;
  buy: number | null;
  sell: number | null;
  fetchedAt: string;
}

export type CoverStatus = 'competitive' | 'noncompetitive' | 'unavailable';

export interface CoverSegment {
  startMs: number;
  endMs: number;
  status: CoverStatus;
  kursiRate: number | null;
  bestRate: number | null;
  bestNames: string;
  bestKeys: string[];
  aheadNames: string;
  aheadKeys: string[];
  advantage: number | null;
  disadvantage: number | null;
  tetri: number | null;
}

export interface CompetitorStat {
  key: string;
  label: string;
  betterMs: number;
  comparableMs: number;
  betterPct: number | null;
  avgDisadvantage: number | null;
  avgTetri: number | null;
  maxDisadvantage: number | null;
  maxTetri: number | null;
  coveragePct: number | null;
}

export interface SideCoverage {
  pair: string;
  side: BoardSide;
  quote: string;
  gel: boolean;
  elapsedMs: number;
  competitiveMs: number;
  noncompetitiveMs: number;
  unavailableMs: number;
  validMs: number;
  noncompetitivePct: number | null;
  competitivePct: number | null;
  coveragePct: number | null;
  avgDisadvantage: number | null;
  avgTetri: number | null;
  maxDisadvantage: number | null;
  maxTetri: number | null;
  segments: CoverSegment[];
  competitors: CompetitorStat[];
  singleBest: { key: string; label: string; ms: number }[];
  tiedBestMs: number;
  comparedWith: string | null;
}

export interface CoverageWindow {
  startMs: number;
  endMs: number;
}

export interface CoverageSummary {
  ka: string;
  en: string;
  firm: boolean;
}

/** Inclusive calendar days, ending at now when that is earlier than the next Tbilisi midnight. */
export function coverageWindow(from: string, to: string, nowMs: number): CoverageWindow {
  const startMs = Date.parse(tbilisiDayStart(from));
  const endMs = Date.parse(tbilisiDayStart(shiftDay(to, 1)));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { startMs: 0, endMs: 0 };
  const capped = Math.min(endMs, nowMs);
  return { startMs, endMs: capped < startMs ? startMs : capped };
}

export function round5(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const n = Number(value.toFixed(5));
  return n === 0 ? 0 : n;
}

export function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '';
  return (Math.round(value * 10) / 10).toFixed(1);
}

export function boardIdentity(row: { source: string; venue: string; venueKind: string }): { key: string; label: string } | null {
  if (row.venueKind === 'kiosk' || row.venue.endsWith(' app')) return null;
  const name = row.venue.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (row.source === 'kursi' && row.venueKind === 'board') return { key: 'kursi', label: 'Kursi' };
  if (row.source === 'rico' && row.venueKind === 'board') return { key: 'rico', label: 'Rico' };
  if (row.venueKind === 'bank' && (name === 'tbc' || name === 'tbcbank' || name === 'tbcge')) return { key: 'tbc', label: 'TBC' };
  if (row.venueKind === 'bank' && (name === 'bog' || name === 'bogge' || name === 'bankofgeorgia')) return { key: 'bog', label: 'BOG' };
  if (row.source === 'valuto' && row.venueKind === 'board') return { key: 'valuto', label: 'Valuto' };
  if (row.source === 'expresslombard' && row.venueKind === 'board') return { key: 'lombard', label: 'Express Lombard' };
  if (row.source === 'crystal' && row.venueKind === 'board') return { key: 'crystal', label: 'Crystal' };
  if (row.source === 'girocredit' && row.venueKind === 'board') return { key: 'giro', label: 'Giro Credit' };
  if (row.source === 'fxhub' && row.venueKind === 'board') return { key: 'fxhub', label: 'FX Hub' };
  if (row.venueKind === 'bank' && name) return { key: 'bank:' + name, label: row.venue };
  return null;
}

interface RawPoint {
  fetchedMs: number;
  pair: string;
  key: string;
  label: string;
  buy: number | null;
  sell: number | null;
}

interface Stamp {
  at: number;
  rate: number;
  label: string;
}

interface SideSeries {
  kursi: Stamp[];
  comps: Map<string, Stamp[]>;
}

function prepare(fetches: readonly BoardFetch[]): RawPoint[] {
  const out: RawPoint[] = [];
  for (const raw of fetches) {
    const snap: RateSnapshot = {
      source: raw.source,
      venue: raw.venue,
      venue_kind: raw.venueKind,
      currency: raw.currency,
      quote_currency: raw.quote,
      buy: raw.buy,
      sell: raw.sell,
      fetched_at: raw.fetchedAt,
    };
    const oriented = orientSnapshot(snap);
    if (!pairAllowed(oriented.currency, oriented.quote_currency)) continue;
    const id = boardIdentity({ source: oriented.source, venue: oriented.venue, venueKind: oriented.venue_kind });
    if (!id) continue;
    const fetchedMs = Date.parse(oriented.fetched_at);
    if (!Number.isFinite(fetchedMs)) continue;
    const buy = oriented.buy != null && oriented.buy > 0 ? oriented.buy : null;
    const sell = oriented.sell != null && oriented.sell > 0 ? oriented.sell : null;
    if (buy == null && sell == null) continue;
    out.push({
      fetchedMs,
      pair: oriented.currency + '/' + oriented.quote_currency,
      key: id.key,
      label: id.label,
      buy,
      sell,
    });
  }
  return out;
}

function clusterIdOf(times: number[]): Map<number, number> {
  const ids = new Map<number, number>();
  let id = 0;
  let prev = Number.NEGATIVE_INFINITY;
  for (const time of times) {
    if (time - prev > BOARD_CLUSTER_MS) id += 1;
    ids.set(time, id);
    prev = time;
  }
  return ids;
}

function seriesFor(points: readonly RawPoint[], pair: string, side: BoardSide): SideSeries {
  const times = [...new Set(points.map((point) => point.fetchedMs))].sort((a, b) => a - b);
  const clusterOf = clusterIdOf(times);
  const groups = new Map<number, RawPoint[]>();
  for (const point of points) {
    const id = clusterOf.get(point.fetchedMs);
    if (id == null) continue;
    const list = groups.get(id);
    if (list) list.push(point);
    else groups.set(id, [point]);
  }

  const kursi: Stamp[] = [];
  const comps = new Map<string, Stamp[]>();
  const clusterIds = [...groups.keys()].sort((a, b) => a - b);
  for (const id of clusterIds) {
    const allRows = groups.get(id) ?? [];
    let maxAll = Number.NEGATIVE_INFINITY;
    let maxKursi = Number.NEGATIVE_INFINITY;
    let haveKursi = false;
    for (const row of allRows) {
      if (row.fetchedMs >= maxAll) maxAll = row.fetchedMs;
      if (row.key === 'kursi' && row.fetchedMs >= maxKursi) {
        maxKursi = row.fetchedMs;
        haveKursi = true;
      }
    }
    const anchor = haveKursi ? maxKursi : maxAll;
    const rows = allRows.filter((row) => row.pair === pair);
    const picked = new Map<string, RawPoint>();
    for (const row of rows) {
      const prev = picked.get(row.key);
      if (!prev) {
        picked.set(row.key, row);
        continue;
      }
      const da = Math.abs(row.fetchedMs - anchor);
      const db = Math.abs(prev.fetchedMs - anchor);
      if (da < db || (da === db && row.fetchedMs > prev.fetchedMs)) picked.set(row.key, row);
    }
    const rateOf = (row: RawPoint) => (side === 'buy' ? row.buy : row.sell);
    const kursiRow = picked.get('kursi');
    const kursiRate = kursiRow ? rateOf(kursiRow) : null;
    const at = kursiRate != null && kursiRow ? kursiRow.fetchedMs : anchor;
    if (kursiRate != null) kursi.push({ at, rate: kursiRate, label: 'Kursi' });
    for (const row of picked.values()) {
      if (row.key === 'kursi') continue;
      const rate = rateOf(row);
      if (rate == null) continue;
      const list = comps.get(row.key) ?? [];
      list.push({ at, rate, label: row.label });
      comps.set(row.key, list);
    }
  }
  kursi.sort((a, b) => a.at - b.at);
  for (const list of comps.values()) list.sort((a, b) => a.at - b.at);
  return { kursi, comps };
}

function rateAt(stamps: readonly Stamp[], t: number): Stamp | null {
  let found: Stamp | null = null;
  for (const stamp of stamps) {
    if (stamp.at > t) break;
    if (t < stamp.at + BOARD_FRESHNESS_MS) found = stamp;
  }
  return found;
}

function advantageOf(side: BoardSide, kursi: number, other: number): number {
  return side === 'buy' ? round5(kursi - other) : round5(other - kursi);
}

function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return (part / whole) * 100;
}

interface LiveComp {
  key: string;
  label: string;
  rate: number;
}

function quoteOf(pair: string): string {
  const slash = pair.indexOf('/');
  return slash < 0 ? '' : pair.slice(slash + 1);
}

function emptySegment(startMs: number, endMs: number): CoverSegment {
  return {
    startMs,
    endMs,
    status: 'unavailable',
    kursiRate: null,
    bestRate: null,
    bestNames: '',
    bestKeys: [],
    aheadNames: '',
    aheadKeys: [],
    advantage: null,
    disadvantage: null,
    tetri: null,
  };
}

function pushSegment(list: CoverSegment[], seg: CoverSegment) {
  if (seg.endMs <= seg.startMs) return;
  const prev = list[list.length - 1];
  if (
    prev
    && prev.endMs === seg.startMs
    && prev.status === seg.status
    && prev.kursiRate === seg.kursiRate
    && prev.bestRate === seg.bestRate
    && prev.advantage === seg.advantage
    && prev.bestNames === seg.bestNames
    && prev.aheadNames === seg.aheadNames
  ) {
    prev.endMs = seg.endMs;
    return;
  }
  list.push(seg);
}

function eventsFor(series: SideSeries, keys: readonly string[], startMs: number, endMs: number): number[] {
  const marks = new Set<number>([startMs, endMs]);
  const lists = [series.kursi, ...keys.map((key) => series.comps.get(key) ?? [])];
  for (const stamps of lists) {
    for (const stamp of stamps) {
      const validTo = stamp.at + BOARD_FRESHNESS_MS;
      if (validTo <= startMs || stamp.at >= endMs) continue;
      if (stamp.at > startMs && stamp.at < endMs) marks.add(stamp.at);
      if (validTo > startMs && validTo < endMs) marks.add(validTo);
    }
  }
  return [...marks].sort((a, b) => a - b);
}

function liveAt(series: SideSeries, keys: readonly string[], t: number): { kursi: number | null; comps: LiveComp[] } {
  const kursi = rateAt(series.kursi, t);
  const comps: LiveComp[] = [];
  for (const key of keys) {
    const stamp = rateAt(series.comps.get(key) ?? [], t);
    if (stamp) comps.push({ key, label: stamp.label, rate: stamp.rate });
  }
  comps.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return { kursi: kursi ? kursi.rate : null, comps };
}

function segmentAt(
  side: BoardSide,
  gel: boolean,
  startMs: number,
  endMs: number,
  kursi: number | null,
  comps: readonly LiveComp[],
): CoverSegment {
  if (kursi == null || comps.length === 0) return emptySegment(startMs, endMs);
  let best = comps[0].rate;
  for (const comp of comps) {
    if (side === 'buy' ? comp.rate > best : comp.rate < best) best = comp.rate;
  }
  const bestRounded = round5(best);
  const bestComps = comps.filter((comp) => round5(comp.rate) === bestRounded);
  const ahead = comps.filter((comp) => advantageOf(side, kursi, comp.rate) < 0);
  const advantage = advantageOf(side, kursi, best);
  const disadvantage = advantage < 0 ? round5(-advantage) : 0;
  const tetri = gel ? advantage * 100 : null;
  return {
    startMs,
    endMs,
    status: advantage < 0 ? 'noncompetitive' : 'competitive',
    kursiRate: kursi,
    bestRate: best,
    bestNames: bestComps.map((comp) => comp.label).join(', '),
    bestKeys: bestComps.map((comp) => comp.key),
    aheadNames: ahead.map((comp) => comp.label).join(', '),
    aheadKeys: ahead.map((comp) => comp.key),
    advantage,
    disadvantage: advantage < 0 ? disadvantage : null,
    tetri,
  };
}

function coverOne(
  series: SideSeries,
  pair: string,
  side: BoardSide,
  window: CoverageWindow,
  competitor: string | null,
): SideCoverage {
  const quote = quoteOf(pair);
  const gel = quote === 'GEL';
  const elapsedMs = Math.max(0, window.endMs - window.startMs);
  const allKeys = [...series.comps.keys()].sort();
  const kpiKeys = competitor ? (series.comps.has(competitor) ? [competitor] : []) : allKeys;

  const tally = new Map<string, {
    key: string;
    label: string;
    betterMs: number;
    comparableMs: number;
    weighted: number;
    weightedTetri: number;
    maxDisadvantage: number | null;
    maxTetri: number | null;
  }>();
  for (const key of allKeys) {
    const stamps = series.comps.get(key) ?? [];
    const overlaps = stamps.some((stamp) => stamp.at < window.endMs && stamp.at + BOARD_FRESHNESS_MS > window.startMs);
    if (!overlaps) continue;
    tally.set(key, {
      key,
      label: stamps[0]?.label ?? key,
      betterMs: 0,
      comparableMs: 0,
      weighted: 0,
      weightedTetri: 0,
      maxDisadvantage: null,
      maxTetri: null,
    });
  }
  const singleMs = new Map<string, { label: string; ms: number }>();
  let tiedBestMs = 0;

  const unfilteredTimes = eventsFor(series, allKeys, window.startMs, window.endMs);
  for (let i = 0; i + 1 < unfilteredTimes.length; i += 1) {
    const startMs = unfilteredTimes[i];
    const endMs = unfilteredTimes[i + 1];
    const ms = endMs - startMs;
    if (ms <= 0) continue;
    const live = liveAt(series, allKeys, startMs);
    if (live.kursi == null) continue;
    if (live.comps.length) {
      let best = live.comps[0].rate;
      for (const comp of live.comps) {
        if (side === 'buy' ? comp.rate > best : comp.rate < best) best = comp.rate;
      }
      const bestRounded = round5(best);
      const winners = live.comps.filter((comp) => round5(comp.rate) === bestRounded);
      if (winners.length === 1) {
        const have = singleMs.get(winners[0].key) ?? { label: winners[0].label, ms: 0 };
        have.ms += ms;
        singleMs.set(winners[0].key, have);
      } else {
        tiedBestMs += ms;
      }
    }
    for (const comp of live.comps) {
      const row = tally.get(comp.key);
      if (!row) continue;
      row.comparableMs += ms;
      row.label = comp.label;
      const gap = advantageOf(side, live.kursi, comp.rate);
      if (gap < 0) {
        const disadvantage = round5(-gap);
        row.betterMs += ms;
        row.weighted += disadvantage * ms;
        if (row.maxDisadvantage == null || disadvantage > row.maxDisadvantage) row.maxDisadvantage = disadvantage;
        if (gel) {
          const tetri = disadvantage * 100;
          row.weightedTetri += tetri * ms;
          if (row.maxTetri == null || tetri > row.maxTetri) row.maxTetri = tetri;
        }
      }
    }
  }

  const segments: CoverSegment[] = [];
  let competitiveMs = 0;
  let noncompetitiveMs = 0;
  let unavailableMs = 0;
  let weighted = 0;
  let weightedTetri = 0;
  let maxDisadvantage: number | null = null;
  let maxTetri: number | null = null;
  const kpiTimes = eventsFor(series, kpiKeys, window.startMs, window.endMs);
  for (let i = 0; i + 1 < kpiTimes.length; i += 1) {
    const startMs = kpiTimes[i];
    const endMs = kpiTimes[i + 1];
    const ms = endMs - startMs;
    if (ms <= 0) continue;
    const live = liveAt(series, kpiKeys, startMs);
    const seg = segmentAt(side, gel, startMs, endMs, live.kursi, live.comps);
    pushSegment(segments, seg);
    if (seg.status === 'competitive') competitiveMs += ms;
    else if (seg.status === 'noncompetitive') {
      noncompetitiveMs += ms;
      const disadvantage = seg.disadvantage ?? 0;
      weighted += disadvantage * ms;
      if (maxDisadvantage == null || disadvantage > maxDisadvantage) maxDisadvantage = disadvantage;
      if (gel) {
        const tetri = disadvantage * 100;
        weightedTetri += tetri * ms;
        if (maxTetri == null || tetri > maxTetri) maxTetri = tetri;
      }
    } else unavailableMs += ms;
  }
  if (!segments.length && elapsedMs > 0) {
    segments.push(emptySegment(window.startMs, window.endMs));
    unavailableMs = elapsedMs;
  }

  const validMs = competitiveMs + noncompetitiveMs;
  const competitors: CompetitorStat[] = [...tally.values()]
    .map((row) => ({
      key: row.key,
      label: row.label,
      betterMs: row.betterMs,
      comparableMs: row.comparableMs,
      betterPct: pct(row.betterMs, row.comparableMs),
      avgDisadvantage: row.betterMs > 0 ? row.weighted / row.betterMs : null,
      avgTetri: gel && row.betterMs > 0 ? row.weightedTetri / row.betterMs : null,
      maxDisadvantage: row.maxDisadvantage,
      maxTetri: gel ? row.maxTetri : null,
      coveragePct: pct(row.comparableMs, elapsedMs),
    }))
    .sort((a, b) => (b.betterPct ?? -1) - (a.betterPct ?? -1) || b.betterMs - a.betterMs || a.label.localeCompare(b.label));

  const bestMs = Math.max(0, ...[...singleMs.values()].map((row) => row.ms));
  const singleBest = [...singleMs.entries()]
    .filter(([, row]) => row.ms > 0 && row.ms === bestMs)
    .map(([key, row]) => ({ key, label: row.label, ms: row.ms }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));

  return {
    pair,
    side,
    quote,
    gel,
    elapsedMs,
    competitiveMs,
    noncompetitiveMs,
    unavailableMs,
    validMs,
    noncompetitivePct: pct(noncompetitiveMs, validMs),
    competitivePct: pct(competitiveMs, validMs),
    coveragePct: pct(validMs, elapsedMs),
    avgDisadvantage: noncompetitiveMs > 0 ? weighted / noncompetitiveMs : null,
    avgTetri: gel && noncompetitiveMs > 0 ? weightedTetri / noncompetitiveMs : null,
    maxDisadvantage: noncompetitiveMs > 0 ? maxDisadvantage : null,
    maxTetri: gel && noncompetitiveMs > 0 ? maxTetri : null,
    segments,
    competitors,
    singleBest,
    tiedBestMs,
    comparedWith: competitor,
  };
}

function pairsOf(points: readonly RawPoint[], pair: string | null): string[] {
  if (pair) return [pair];
  return sortPairs([...new Set(points.map((point) => point.pair))]);
}

export function coverSelection(input: {
  fetches: readonly BoardFetch[];
  pair: string | null;
  sides: readonly BoardSide[];
  from: string;
  to: string;
  nowMs: number;
  competitor: string | null;
}): SideCoverage[] {
  const window = coverageWindow(input.from, input.to, input.nowMs);
  const points = prepare(input.fetches);
  const pairs = pairsOf(points, input.pair);
  const out: SideCoverage[] = [];
  for (const pair of pairs) {
    for (const side of input.sides) {
      out.push(coverOne(seriesFor(points, pair, side), pair, side, window, input.competitor));
    }
  }
  if (!out.length && input.pair) {
    for (const side of input.sides) out.push(coverOne(seriesFor([], input.pair, side), input.pair, side, window, input.competitor));
  }
  return out;
}

export function daySlices(startMs: number, endMs: number): { day: string; startMs: number; endMs: number }[] {
  if (endMs <= startMs) return [];
  const first = tbilisiDay(new Date(startMs).toISOString());
  const last = tbilisiDay(new Date(endMs - 1).toISOString());
  if (!first || !last) return [{ day: '', startMs, endMs }];
  const out: { day: string; startMs: number; endMs: number }[] = [];
  for (let day = first; day <= last; day = shiftDay(day, 1)) {
    const dayStart = Date.parse(tbilisiDayStart(day));
    const dayEnd = Date.parse(tbilisiDayStart(shiftDay(day, 1)));
    const a = Math.max(startMs, dayStart);
    const b = Math.min(endMs, dayEnd);
    if (b > a) out.push({ day, startMs: a, endMs: b });
    if (day === last) break;
  }
  return out;
}

function lagSentence(cov: SideCoverage): { ka: string; en: string } | null {
  if (cov.noncompetitiveMs <= 0 || cov.avgDisadvantage == null) return null;
  if (cov.gel && cov.avgTetri != null) {
    const n = cov.avgTetri.toFixed(2);
    return {
      ka: `საშუალო ჩამორჩენა იყო ${n} თეთრი.`,
      en: `The average disadvantage was ${n} tetri.`,
    };
  }
  const n = cov.avgDisadvantage.toFixed(5);
  return {
    ka: `საშუალო ჩამორჩენა იყო ${n} ${cov.quote}. ეს წყვილი ლარში არაა, ამიტომ თეთრი არ იწერება.`,
    en: `The average disadvantage was ${n} ${cov.quote}. This pair is not in lari, so it is not written in tetri.`,
  };
}

export function describeCoverage(
  cov: SideCoverage,
  periodKa: string,
  periodEn: string,
  sideKa: string,
  sideEn: string,
  competitorLabel: string | null,
  truncated: boolean,
): CoverageSummary {
  if (truncated) {
    return {
      firm: false,
      ka: 'შენახული დაფა ბოლომდე ვერ წაიკითხა. პროცენტს არ ვწერ.',
      en: 'The stored board was not fully read. No percentage is shown.',
    };
  }
  if (cov.elapsedMs <= 0 || cov.validMs <= 0 || cov.noncompetitivePct == null) {
    return {
      firm: false,
      ka: `${periodKa}, ${cov.pair} ${sideKa}, ვარგისი შედარება არ არის. კურსის დაფა ან კონკურენტი აკლია, ან კურსი 45 წუთზე ძველია.`,
      en: `${periodEn}, ${cov.pair} ${sideEn}, there is no valid comparison. The Kursi board or a competitor is missing, or the rate is older than 45 minutes.`,
    };
  }
  const coverage = cov.coveragePct ?? 0;
  const firm = coverage >= 50;
  const pct = formatPct(cov.noncompetitivePct);
  const againstKa = competitorLabel ? `, ${competitorLabel}-სთან შედარებით,` : '';
  const againstEn = competitorLabel ? `, compared with ${competitorLabel},` : '';
  const leader = !competitorLabel
    ? [...cov.competitors].sort((a, b) => b.betterMs - a.betterMs || a.label.localeCompare(b.label))[0]
    : undefined;
  const who = leader && leader.betterMs > 0 ? leader : null;
  const lag = lagSentence(cov);
  const partsKa: string[] = [];
  const partsEn: string[] = [];
  if (!firm) {
    partsKa.push(`${periodKa}, ${cov.pair} ${sideKa}, შედარებადი დრო პერიოდის ${formatPct(coverage)}%-ია. ამ ნაწილში არაკონკურენტული წილი ${pct}%-ია. ეს სრული დასკვნა არ არის.`);
    partsEn.push(`${periodEn}, ${cov.pair} ${sideEn}, comparable time is ${formatPct(coverage)}% of the period. On that slice the noncompetitive share is ${pct}%. This is not a full conclusion.`);
    if (lag) {
      partsKa.push(lag.ka);
      partsEn.push(lag.en);
    }
  } else {
    partsKa.push(`${periodKa}${againstKa} ${cov.pair} ${sideKa} Kursi.ge არაკონკურენტული იყო შედარებადი დროის ${pct}%-ში.`);
    partsEn.push(`${periodEn}${againstEn} on ${cov.pair} ${sideEn}, Kursi.ge was noncompetitive for ${pct}% of comparable time.`);
    if (who) {
      partsKa.push(`ყველაზე ხშირად უკეთესი კურსი ჰქონდა ${who.label}-ს.`);
      partsEn.push(`The better rate was most often at ${who.label}.`);
    }
    if (lag) {
      partsKa.push(lag.ka);
      partsEn.push(lag.en);
    } else {
      partsKa.push('ჩამორჩენა არ ყოფილა.');
      partsEn.push('There was no disadvantage.');
    }
    if (coverage < 99.95) {
      partsKa.push(`დაფარვა ${formatPct(coverage)}%-ია.`);
      partsEn.push(`Coverage is ${formatPct(coverage)}%.`);
    }
  }
  return { ka: partsKa.join(' '), en: partsEn.join(' '), firm };
}
