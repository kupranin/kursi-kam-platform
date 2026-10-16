import { tbilisiDayStart } from './format';
import { parseBoardReport, shiftDay, tbilisiMonday } from './boardReport';
import {
  BOARD_FRESHNESS_MS,
  coverSelection,
  coverageWindow,
  describeCoverage,
  round5,
  type BoardFetch,
  type BoardSide,
  type SideCoverage,
} from './boardCoverage';

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

const MIN = 60 * 1000;
const DAY = '2026-10-12';
const START = Date.parse(tbilisiDayStart(DAY));

function at(min: number): string {
  return new Date(START + min * MIN).toISOString();
}

function row(min: number, source: 'kursi' | 'valuto' | 'rico', buy: number | null, sell: number | null = null): BoardFetch {
  const venue = source === 'kursi' ? 'Kursi' : source === 'valuto' ? 'Valuto' : 'Rico';
  return {
    source,
    venue,
    venueKind: 'board',
    currency: 'USD',
    quote: 'GEL',
    buy,
    sell,
    fetchedAt: at(min),
  };
}

function cover(
  fetches: BoardFetch[],
  endMin: number,
  side: BoardSide = 'buy',
  competitor: string | null = null,
  pair: string | null = 'USD/GEL',
): SideCoverage {
  const found = coverSelection({
    fetches,
    pair,
    sides: [side],
    from: DAY,
    to: DAY,
    nowMs: START + endMin * MIN,
    competitor,
  });
  assert(found.length === 1, 'one pair and side');
  return found[0];
}

function assertPartition(cov: SideCoverage, label: string) {
  assert(
    cov.competitiveMs + cov.noncompetitiveMs + cov.unavailableMs === cov.elapsedMs,
    label + ' durations ' + [cov.competitiveMs, cov.noncompetitiveMs, cov.unavailableMs, cov.elapsedMs].join(','),
  );
  assert(cov.validMs === cov.competitiveMs + cov.noncompetitiveMs, label + ' valid');
  if (cov.validMs > 0) {
    const sum = (cov.competitivePct ?? 0) + (cov.noncompetitivePct ?? 0);
    assert(Math.abs(sum - 100) < 1e-6, label + ' percents ' + sum);
  } else {
    assert(cov.competitivePct == null && cov.noncompetitivePct == null, label + ' hides a percent');
  }
  if (cov.elapsedMs === 0) return;
  assert(cov.segments.length > 0, label + ' segments');
  let cursor = cov.segments[0].startMs;
  for (const seg of cov.segments) {
    assert(seg.startMs === cursor, label + ' hole');
    assert(seg.endMs > seg.startMs, label + ' empty segment');
    cursor = seg.endMs;
  }
  assert(cursor - cov.segments[0].startMs === cov.elapsedMs, label + ' span');
}

assert(round5(2.700004 - 2.700001) === 0, 'five-decimal tie is zero');
assert(round5(2.700006 - 2.700000) !== 0, 'a gap past five decimals stays');

const better = cover([row(0, 'kursi', 2.8), row(0, 'valuto', 2.7)], 45);
assertPartition(better, 'always better');
assert(better.competitiveMs === 45 * MIN && better.noncompetitiveMs === 0 && better.unavailableMs === 0, 'Kursi always better');
assert(better.noncompetitivePct === 0 && better.competitivePct === 100, 'better percents');

const worse = cover([row(0, 'kursi', 2.7), row(0, 'valuto', 2.8)], 45);
assertPartition(worse, 'always worse');
assert(worse.noncompetitiveMs === 45 * MIN && worse.competitiveMs === 0, 'Kursi always worse');
assert(worse.noncompetitivePct === 100, 'worse is all valid time');
assert(worse.competitors[0]?.key === 'valuto' && worse.competitors[0].betterPct === 100, 'Valuto beat Kursi');
const worseText = describeCoverage(worse, 'ამ კვირაში', 'This week', 'ყიდვაზე', 'on buy', null, false);
assert(worseText.firm, 'full coverage can state a result');
assert(worseText.ka.includes('100.0%'), 'summary uses the noncompetitive percent');
assert(worseText.ka.includes('Valuto-ს'), 'summary names who beat Kursi');
assert(worseText.ka.includes('თეთრი'), 'summary states tetri');

const tied = cover([row(0, 'kursi', 2.700004), row(0, 'valuto', 2.700001)], 45);
assertPartition(tied, 'tie');
assert(tied.competitiveMs === 45 * MIN && tied.noncompetitiveMs === 0, 'tie at five decimals is competitive');
assert(tied.segments[0].advantage === 0, 'printed gap is zero');

const overlap = cover([
  row(0, 'kursi', 2.7), row(0, 'valuto', 2.72), row(0, 'rico', 2.71),
  row(30, 'kursi', 2.7), row(30, 'valuto', 2.72), row(30, 'rico', 2.71),
], 60);
assertPartition(overlap, 'overlap');
assert(overlap.noncompetitiveMs === 60 * MIN, 'overall worse time is not doubled');
assert(overlap.competitors.every((item) => item.betterMs === 60 * MIN && item.betterPct === 100), 'each competitor is independent');
assert(overlap.competitors.reduce((sum, item) => sum + item.betterMs, 0) > overlap.noncompetitiveMs, 'competitor minutes may overlap');
assert(overlap.singleBest.length === 1 && overlap.singleBest[0].key === 'valuto', 'higher buy is the single best');

const noComp = cover([row(0, 'kursi', 2.7)], 45);
assertPartition(noComp, 'missing competitor');
assert(noComp.unavailableMs === noComp.elapsedMs && noComp.competitiveMs === 0 && noComp.noncompetitiveMs === 0, 'missing competitor is unavailable');

const noKursi = cover([row(0, 'valuto', 2.8)], 45);
assertPartition(noKursi, 'missing kursi');
assert(noKursi.unavailableMs === noKursi.elapsedMs && noKursi.noncompetitivePct == null, 'missing Kursi is unavailable');

const stale = cover([row(0, 'kursi', 2.7), row(0, 'valuto', 2.8)], 90);
assertPartition(stale, 'stale');
assert(stale.noncompetitiveMs === BOARD_FRESHNESS_MS, 'fresh window stays noncompetitive');
assert(stale.unavailableMs === 45 * MIN, 'after 45 minutes the rate is unavailable');
assert(stale.segments.some((seg) => seg.status === 'unavailable' && seg.startMs === START + BOARD_FRESHNESS_MS), 'stale starts at the threshold');

const irregular = cover([
  row(0, 'kursi', 2.8), row(0, 'valuto', 2.7),
  row(20, 'kursi', 2.7), row(20, 'valuto', 2.8),
  row(70, 'kursi', 2.75), row(70, 'valuto', 2.75),
], 130);
assertPartition(irregular, 'irregular');
assert(irregular.competitiveMs === 65 * MIN, 'irregular competitive minutes');
assert(irregular.noncompetitiveMs === 45 * MIN, 'irregular noncompetitive minutes');
assert(irregular.unavailableMs === 20 * MIN, 'irregular gaps stay empty');

const changed = cover([
  row(0, 'kursi', 2.7), row(0, 'valuto', 2.8), row(0, 'rico', 2.71),
  row(30, 'kursi', 2.7), row(30, 'valuto', 2.71), row(30, 'rico', 2.8),
], 60);
assertPartition(changed, 'best changes');
assert(changed.noncompetitiveMs === 60 * MIN, 'a changing best is still one worse stretch');
assert(changed.segments.filter((seg) => seg.status === 'noncompetitive').length === 2, 'the timeline keeps both best names');
assert(changed.segments[0].bestKeys.join() === 'valuto' && changed.segments[1].bestKeys.join() === 'rico', 'best competitor changes');
assert(changed.singleBest.length === 2 && changed.singleBest.every((item) => item.ms === 30 * MIN), 'tied time for single best');

const nowWeek = Date.parse(tbilisiDayStart('2026-10-16')) + 15 * 60 * MIN;
const thisWeek = coverageWindow('2026-10-12', '2026-10-16', nowWeek);
assert(thisWeek.startMs === Date.parse(tbilisiDayStart('2026-10-12')), 'this week starts Monday');
assert(thisWeek.endMs === nowWeek, 'this week ends now');
assert(thisWeek.endMs < Date.parse(tbilisiDayStart('2026-10-17')), 'this week excludes future hours');
const futureOnly = coverSelection({
  fetches: [{
    source: 'kursi', venue: 'Kursi', venueKind: 'board', currency: 'USD', quote: 'GEL',
    buy: 2.7, sell: null, fetchedAt: new Date(Date.parse(tbilisiDayStart('2026-10-16')) + 18 * 60 * MIN).toISOString(),
  }, {
    source: 'valuto', venue: 'Valuto', venueKind: 'board', currency: 'USD', quote: 'GEL',
    buy: 2.9, sell: null, fetchedAt: new Date(Date.parse(tbilisiDayStart('2026-10-16')) + 18 * 60 * MIN).toISOString(),
  }],
  pair: 'USD/GEL',
  sides: ['buy'],
  from: '2026-10-12',
  to: '2026-10-16',
  nowMs: nowWeek,
  competitor: null,
})[0];
assertPartition(futureOnly, 'future');
assert(futureOnly.elapsedMs === nowWeek - thisWeek.startMs && futureOnly.noncompetitiveMs === 0, 'a later snapshot is outside this week');

assert(tbilisiMonday('2026-10-16') === '2026-10-12', 'Friday belongs to this Monday');
assert(tbilisiMonday('2026-10-11') === '2026-10-05', 'Sunday belongs to the previous Monday');
assert(shiftDay('2026-10-12', -7) === '2026-10-05' && shiftDay('2026-10-12', -1) === '2026-10-11', 'previous week is Monday through Sunday');
const prev = coverageWindow('2026-10-05', '2026-10-11', Date.parse(tbilisiDayStart('2026-10-16')));
assert(prev.startMs === Date.parse(tbilisiDayStart('2026-10-05')), 'previous week starts Monday 00:00');
assert(prev.endMs === Date.parse(tbilisiDayStart('2026-10-12')), 'previous week ends at the next Monday');
assert(prev.endMs - prev.startMs === 7 * 24 * 60 * MIN, 'previous week is seven full days');

const custom = coverageWindow('2026-10-13', '2026-10-14', Date.parse(tbilisiDayStart('2026-10-16')));
assert(custom.startMs === Date.parse(tbilisiDayStart('2026-10-13')), 'custom starts on the selected day');
assert(custom.endMs - custom.startMs === 2 * 24 * 60 * MIN, 'custom keeps the selected days');

const buyGap = cover([row(0, 'kursi', 2.7), row(0, 'valuto', 2.73)], 45);
assertPartition(buyGap, 'usd gel buy');
assert(buyGap.gel && buyGap.noncompetitiveMs === 45 * MIN, 'higher competitor buy is worse for the client');
assert(buyGap.avgTetri != null && Math.abs(buyGap.avgTetri - 3) < 1e-6, 'buy gap is 3 tetri');
assert(buyGap.maxTetri != null && Math.abs(buyGap.maxTetri - 3) < 1e-6, 'max buy gap is 3 tetri');

const sellWorse = cover([row(0, 'kursi', null, 2.8), row(0, 'valuto', null, 2.74)], 45, 'sell');
assertPartition(sellWorse, 'usd gel sell worse');
assert(sellWorse.noncompetitiveMs === 45 * MIN, 'a higher Kursi sell is worse for the client');
assert(sellWorse.avgTetri != null && Math.abs(sellWorse.avgTetri - 6) < 1e-6, 'sell gap is 6 tetri');
const sellBetter = cover([row(0, 'kursi', null, 2.7), row(0, 'valuto', null, 2.8)], 45, 'sell');
assertPartition(sellBetter, 'usd gel sell better');
assert(sellBetter.competitiveMs === 45 * MIN && sellBetter.noncompetitiveMs === 0, 'a lower Kursi sell is better for the client');

const cross = coverSelection({
  fetches: [{
    source: 'kursi', venue: 'Kursi', venueKind: 'board', currency: 'EUR', quote: 'USD',
    buy: 1.1, sell: null, fetchedAt: at(0),
  }, {
    source: 'valuto', venue: 'Valuto', venueKind: 'board', currency: 'EUR', quote: 'USD',
    buy: 1.12, sell: null, fetchedAt: at(0),
  }],
  pair: 'EUR/USD',
  sides: ['buy'],
  from: DAY,
  to: DAY,
  nowMs: START + 45 * MIN,
  competitor: null,
})[0];
assert(!cross.gel && cross.avgTetri == null && cross.avgDisadvantage != null, 'a non-GEL pair is not converted to tetri');

const mixed = [
  row(0, 'kursi', 2.7), row(0, 'valuto', 2.75), row(0, 'rico', 2.65),
];
const allComps = cover(mixed, 45, 'buy', null);
const onlyRico = cover(mixed, 45, 'buy', 'rico');
const onlyValuto = cover(mixed, 45, 'buy', 'valuto');
assertPartition(allComps, 'all competitors');
assertPartition(onlyRico, 'rico filter');
assertPartition(onlyValuto, 'valuto filter');
assert(allComps.noncompetitivePct === 100, 'all competitors uses the best buy');
assert(onlyRico.competitivePct === 100 && onlyRico.noncompetitiveMs === 0, 'one competitor does not keep the best of all');
assert(onlyValuto.noncompetitivePct === 100, 'the selected competitor is the comparison');
assert(onlyRico.competitors.some((item) => item.key === 'valuto' && item.betterPct === 100), 'breakdown still lists the other competitor');

assert(shiftDay('2026-10-16', -6) === '2026-10-10', 'last 7 days is today and the six days before it');
const seven = coverageWindow('2026-10-10', '2026-10-16', Date.parse(tbilisiDayStart('2026-10-16')) + 12 * 60 * MIN);
assert(seven.startMs === Date.parse(tbilisiDayStart('2026-10-10')), 'seven days start six days back');
assert(seven.endMs === Date.parse(tbilisiDayStart('2026-10-16')) + 12 * 60 * MIN, 'seven days end at now');

const none = cover([], 45);
assertPartition(none, 'no observations');
assert(none.unavailableMs === none.elapsedMs && none.noncompetitivePct == null, 'no observations are unavailable');
const noneText = describeCoverage(none, 'ამ კვირაში', 'This week', 'ყიდვაზე', 'on buy', null, false);
assert(!noneText.firm && noneText.ka.includes('ვარგისი შედარება არ არის'), 'no comparison does not invent a percent');
assert(!noneText.ka.includes('%'), 'the empty summary has no percent');

const gap = cover([
  row(0, 'kursi', 2.7), row(0, 'valuto', 2.8),
  row(180, 'kursi', 2.7), row(180, 'valuto', 2.8),
], 240);
assertPartition(gap, 'long gap');
assert(gap.noncompetitiveMs === 90 * MIN, 'each side of a long gap is only fresh for 45 minutes');
assert(gap.segments.some((seg) => seg.status === 'unavailable' && seg.endMs - seg.startMs === 135 * MIN), 'the hole is not drawn as noncompetitive');

const onStart = cover([row(0, 'kursi', 2.8), row(0, 'valuto', 2.7)], 45);
assert(onStart.segments[0].startMs === START && onStart.competitiveMs === 45 * MIN, 'a snapshot on the start is included');
const onEnd = cover([{
  source: 'kursi', venue: 'Kursi', venueKind: 'board', currency: 'USD', quote: 'GEL',
  buy: 2.7, sell: null, fetchedAt: new Date(START + 45 * MIN).toISOString(),
}, {
  source: 'valuto', venue: 'Valuto', venueKind: 'board', currency: 'USD', quote: 'GEL',
  buy: 2.9, sell: null, fetchedAt: new Date(START + 45 * MIN).toISOString(),
}], 45);
assertPartition(onEnd, 'snapshot on end');
assert(onEnd.noncompetitiveMs === 0 && onEnd.unavailableMs === onEnd.elapsedMs, 'a snapshot exactly on the end is excluded');
const handoff = cover([
  row(0, 'kursi', 2.8), row(0, 'valuto', 2.7),
  row(45, 'kursi', 2.7), row(45, 'valuto', 2.8),
], 90);
assertPartition(handoff, 'boundary handoff');
assert(handoff.competitiveMs === 45 * MIN && handoff.noncompetitiveMs === 45 * MIN && handoff.unavailableMs === 0, 'expiry and the next snapshot meet without a gap or an overlap');
const expired = cover([{
  source: 'kursi', venue: 'Kursi', venueKind: 'board', currency: 'USD', quote: 'GEL',
  buy: 2.8, sell: null, fetchedAt: new Date(START - BOARD_FRESHNESS_MS).toISOString(),
}, {
  source: 'valuto', venue: 'Valuto', venueKind: 'board', currency: 'USD', quote: 'GEL',
  buy: 2.7, sell: null, fetchedAt: new Date(START - BOARD_FRESHNESS_MS).toISOString(),
}], 30);
assert(expired.competitiveMs === 0 && expired.unavailableMs === expired.elapsedMs, 'a rate exactly 45 minutes old does not cover the start');

assertPartition(better, 'reconcile better');
assertPartition(worse, 'reconcile worse');
assertPartition(overlap, 'reconcile overlap');
assertPartition(irregular, 'reconcile irregular');
assertPartition(gap, 'reconcile gap');
assertPartition(handoff, 'reconcile handoff');

const parsed = parseBoardReport({
  grain: 'fetches',
  reason: null,
  pairs: ['EUR/USD', 'USD/GEL'],
  observations: [{
    at: '2026-10-12T20:00:00.000Z',
    pair: 'USD/GEL',
    side: 'sell',
    kursi_rate: '2.80000',
    best_rate: '2.79000',
    best_names: 'Rico',
    best_keys: ['rico'],
    advantage: -0.01,
    standing: 'worse',
    tetri: -1,
    bps: null,
  }],
  incidents: [{
    id: 'USD/GEL|buy|2026-10-12T08:00:00.000Z',
    pair: 'USD/GEL',
    side: 'buy',
    started_at: '2026-10-12T08:00:00.000Z',
    ended_at: '2026-10-14T19:00:00.000Z',
    end_kind: 'flip',
    duration_minutes: 3540,
    kursi_rate: 2.7,
    best_rate: 2.73,
    best_names: 'Valuto',
    best_keys: ['valuto'],
    best_keys_any: ['valuto', 'rico'],
    max_gap: -0.03,
    avg_gap: -0.02,
    avg_weight: 'time',
    start_kursi_rate: 2.71,
    end_kursi_rate: 2.72,
    start_names: 'Valuto',
    end_names: 'Rico',
    tetri: -3,
    bps: -111.1,
    points: [{
      at: '2026-10-12T08:00:00.000Z',
      kursi_rate: '2.71000',
      best_rate: '2.73000',
      best_names: 'Valuto',
      best_keys: ['valuto'],
      advantage: '-0.02000',
      standing: 'worse',
      tetri: '-2',
      bps: '-73.8',
    }],
  }, {
    id: 'USD/GEL|sell|open',
    pair: 'USD/GEL',
    side: 'sell',
    started_at: '2026-10-14T19:00:00.000Z',
    ended_at: null,
    end_kind: 'open',
    duration_minutes: 0,
    kursi_rate: 2.8,
    best_rate: 2.79,
    best_names: 'Rico',
    best_keys: ['rico'],
    best_keys_any: ['rico'],
    max_gap: -0.01,
    avg_gap: -0.01,
    avg_weight: 'equal',
    start_kursi_rate: 2.8,
    end_kursi_rate: null,
    start_names: 'Rico',
    end_names: '',
    tetri: -1,
    bps: null,
    points: [],
  }],
}, 'USD/GEL');
assert(parsed.pairs[0] === 'USD/GEL' && parsed.pairs[1] === 'EUR/USD', 'pair order is unchanged');
assert(parsed.grain === 'fetches' && parsed.incidents.length === 2, 'incident count is unchanged');
assert(parsed.incidents[0].durationMinutes === 3540, 'a 59-hour duration is passed through');
assert(parsed.incidents[0].endKind === 'flip' && parsed.incidents[0].endedAt === '2026-10-14T19:00:00.000Z', 'end is passed through');
assert(parsed.incidents[0].maxGap === -0.03 && parsed.incidents[0].avgGap === -0.02, 'gaps are passed through');
assert(parsed.incidents[0].avgWeight === 'time', 'weight kind is passed through');
assert(parsed.incidents[0].bestKeysAny.join() === 'valuto,rico', 'competitor keys are passed through');
assert(parsed.incidents[0].points[0].advantage === -0.02 && parsed.incidents[0].points[0].kursiRate === 2.71, 'point gaps are passed through');
assert(parsed.incidents[1].endedAt == null && parsed.incidents[1].endKind === 'open' && parsed.incidents[1].durationMinutes === 0, 'an open row stays open');
assert(parsed.observations[0].side === 'sell' && parsed.observations[0].standing === 'worse' && parsed.observations[0].advantage === -0.01, 'observations are passed through');

console.log('board coverage ok');
