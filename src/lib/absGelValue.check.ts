/**
 * Same branches as private.value_abs_gel in setup 47.
 * A missing figure stays null. It is never stored or summed as zero.
 */

export const CROSS_PAIRS = ['EUR/USD', 'EUR/RUB', 'USD/RUB', 'USD/CNY', 'EUR/CNY'] as const;

export interface BoardLeg {
  sell: number;
  at: string;
}

export interface AbsResult {
  absGel: number | null;
  source: 'received_gel' | 'provisional_board' | 'treasury_quote' | 'manual_admin' | null;
  status: 'calculated' | 'pending_admin' | null;
  rate: number | null;
  rateAt: string | null;
  path: string | null;
  reason: string | null;
  boardRate: number | null;
  boardAt: string | null;
  boardPath: string | null;
}

export function gelScaleOk(currency: string, value: number | null): boolean {
  if (value == null || !(value > 0)) return false;
  if (currency === 'USD') return value >= 1.5 && value <= 4.2;
  if (currency === 'EUR') return value >= 1.6 && value <= 4.8;
  if (currency === 'RUB') return value >= 0.008 && value < 1 && value <= 0.15;
  if (currency === 'CNY') return value >= 0.15 && value <= 0.8;
  return false;
}

export function rateInScale(pair: string, value: number | null): boolean {
  if (value == null || !(value > 0)) return false;
  if (pair === 'USD/GEL') return value >= 1.5 && value <= 4.2;
  if (pair === 'EUR/GEL') return value >= 1.6 && value <= 4.8;
  if (pair === 'RUB/GEL') return value >= 0.008 && value <= 0.15;
  if (pair === 'CNY/GEL') return value >= 0.15 && value <= 0.8;
  if (pair === 'EUR/USD') return value >= 0.95 && value <= 1.55;
  if (pair === 'EUR/RUB') return value >= 40 && value <= 200;
  if (pair === 'USD/RUB') return value >= 40 && value <= 200;
  if (pair === 'USD/CNY') return value >= 4.5 && value <= 12;
  if (pair === 'EUR/CNY') return value >= 5 && value <= 14;
  return false;
}

function round2(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 100)) / 100;
}

function round8(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 1e8)) / 1e8;
}

/** Latest stored-direction sell only. A reciprocal row is not in this map. */
export function snapshotReceivedGel(
  gets: string,
  board: Record<string, BoardLeg | undefined>,
): { rate: number; at: string; path: string } | null {
  if (!gets || gets === 'GEL') return null;
  const direct = board[`${gets}/GEL`];
  if (direct && gelScaleOk(gets, direct.sell)) {
    return { rate: round8(direct.sell), at: direct.at, path: 'direct' };
  }
  for (const pair of CROSS_PAIRS) {
    const [base, quote] = pair.split('/');
    if (base === gets) {
      const cross = board[pair];
      const gel = board[`${quote}/GEL`];
      if (cross && gel && rateInScale(pair, cross.sell) && gelScaleOk(quote, gel.sell)) {
        const result = cross.sell * gel.sell;
        if (gelScaleOk(gets, result)) {
          return {
            rate: round8(result),
            at: cross.at < gel.at ? cross.at : gel.at,
            path: `cross:${pair}*${quote}/GEL`,
          };
        }
      }
    } else if (quote === gets) {
      const gel = board[`${base}/GEL`];
      const cross = board[pair];
      if (gel && cross && gelScaleOk(base, gel.sell) && rateInScale(pair, cross.sell) && cross.sell > 0) {
        const result = gel.sell / cross.sell;
        if (gelScaleOk(gets, result)) {
          return {
            rate: round8(result),
            at: cross.at < gel.at ? cross.at : gel.at,
            path: `cross:${base}/GEL/${pair}`,
          };
        }
      }
    }
  }
  return null;
}

export interface ValueInput {
  sells: string;
  gets: string;
  sellAmt: number | null;
  getsAmt: number | null;
  quoteRate: number | null;
  quoteStatus: string | null;
  quotedAt: string | null;
  /** Clock time of the quote write. Used only when quotedAt is null. */
  quoteRecordedAt: string | null;
  at: string;
  board: Record<string, BoardLeg | undefined>;
  /** Sticky snapshot. Null on the first attempt, or after the received currency changes. */
  keptBoard: { rate: number; at: string; path: string } | null;
  lookupBoard: boolean;
}

export function valueAbsGel(input: ValueInput): AbsResult {
  const gets = input.gets.toUpperCase();
  const sells = input.sells.toUpperCase();
  const emptyBoard = { boardRate: null, boardAt: null, boardPath: null };

  if (gets === 'GEL') {
    if (input.getsAmt != null && input.getsAmt > 0 && round2(Math.abs(input.getsAmt)) > 0) {
      return {
        absGel: round2(Math.abs(input.getsAmt)),
        source: 'received_gel',
        status: 'calculated',
        rate: 1,
        rateAt: input.at,
        path: 'received_gel',
        reason: null,
        boardRate: input.keptBoard?.rate ?? null,
        boardAt: input.keptBoard?.at ?? null,
        boardPath: input.keptBoard?.path ?? null,
      };
    }
    return {
      absGel: null,
      source: null,
      status: 'pending_admin',
      rate: null,
      rateAt: null,
      path: null,
      reason: 'missing_gets_gel',
      ...emptyBoard,
      boardRate: input.keptBoard?.rate ?? null,
      boardAt: input.keptBoard?.at ?? null,
      boardPath: input.keptBoard?.path ?? null,
    };
  }

  const shot = input.lookupBoard ? snapshotReceivedGel(gets, input.board) : input.keptBoard;
  const boardRate = shot?.rate ?? null;
  const boardAt = shot?.at ?? null;
  const boardPath = shot?.path ?? null;
  const board = { boardRate, boardAt, boardPath };

  const quoteOk = sells === 'GEL'
    && input.quoteStatus !== 'declined'
    && input.quoteRate != null
    && input.quoteRate > 0
    && gelScaleOk(gets, input.quoteRate);

  if (quoteOk && input.quoteRate != null) {
    let abs: number | null = null;
    if (input.getsAmt != null && input.getsAmt > 0) abs = round2(Math.abs(input.getsAmt) * input.quoteRate);
    else if (input.sellAmt != null && input.sellAmt > 0) abs = round2(Math.abs(input.sellAmt));
    if (abs != null && abs > 0) {
      return {
        absGel: abs,
        source: 'treasury_quote',
        status: 'calculated',
        rate: round8(input.quoteRate),
        rateAt: input.quotedAt ?? input.quoteRecordedAt,
        path: 'treasury_quote',
        reason: null,
        ...board,
      };
    }
  }

  if (boardRate != null && boardRate > 0 && gelScaleOk(gets, boardRate)) {
    if (input.getsAmt != null && input.getsAmt > 0) {
      const abs = round2(Math.abs(input.getsAmt) * boardRate);
      if (abs > 0) {
        return {
          absGel: abs,
          source: 'provisional_board',
          status: 'calculated',
          rate: boardRate,
          rateAt: boardAt,
          path: boardPath,
          reason: null,
          ...board,
        };
      }
    } else if (sells === 'GEL' && input.sellAmt != null && input.sellAmt > 0 && boardPath === 'direct') {
      const abs = round2(Math.abs(input.sellAmt));
      if (abs > 0) {
        return {
          absGel: abs,
          source: 'provisional_board',
          status: 'calculated',
          rate: boardRate,
          rateAt: boardAt,
          path: 'direct',
          reason: null,
          ...board,
        };
      }
    }
  }

  let reason = 'no_board_rate';
  if (input.getsAmt == null && !(sells === 'GEL' && boardPath === 'direct' && boardRate != null)) {
    reason = boardRate == null ? 'no_board_rate' : 'cannot_derive';
  } else if (boardRate == null) reason = 'no_board_rate';
  else reason = 'rounds_to_zero';

  return {
    absGel: null,
    source: null,
    status: 'pending_admin',
    rate: null,
    rateAt: null,
    path: null,
    reason,
    ...board,
  };
}

/** Automatic writers leave a manual figure alone. */
export function applyAutomatic(previous: AbsResult | null, next: AbsResult): AbsResult {
  if (previous?.source === 'manual_admin' && previous.status === 'calculated') return previous;
  return next;
}

/** Sum calculated figures. Null and pending contribute nothing, including not a zero. */
export function sumAbs(rows: { absGel: number | null; status: string | null }[]): number | null {
  let total = 0;
  let any = false;
  for (const row of rows) {
    if (row.status === 'calculated' && row.absGel != null) {
      total = round2(total + row.absGel);
      any = true;
    }
  }
  return any ? total : null;
}

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

const at = '2026-10-17T06:00:00.000Z';
const later = '2026-10-17T08:00:00.000Z';

const received = valueAbsGel({
  sells: 'USD', gets: 'GEL', sellAmt: 1000, getsAmt: 2700,
  quoteRate: 2.8, quoteStatus: 'quoted', quotedAt: later, quoteRecordedAt: null, at,
  board: { 'USD/GEL': { sell: 2.7, at } },
  keptBoard: null, lookupBoard: true,
});
assert(received.absGel === 2700 && received.source === 'received_gel' && received.status === 'calculated', 'received GEL uses the amount');
assert(received.rate === 1, 'received GEL does not apply the quote');

const direct = valueAbsGel({
  sells: 'GEL', gets: 'USD', sellAmt: 2700, getsAmt: 1000,
  quoteRate: null, quoteStatus: 'asking', quotedAt: null, quoteRecordedAt: null, at,
  board: { 'USD/GEL': { sell: 2.7, at } },
  keptBoard: null, lookupBoard: true,
});
assert(direct.absGel === 2700 && direct.source === 'provisional_board' && direct.path === 'direct', 'direct board sell is snapshotted');
assert(direct.boardRate === 2.7 && direct.boardAt === at, 'snapshot keeps the rate and time');

const sticky = valueAbsGel({
  sells: 'GEL', gets: 'USD', sellAmt: 2700, getsAmt: 1000,
  quoteRate: null, quoteStatus: 'asking', quotedAt: null, quoteRecordedAt: null, at,
  board: { 'USD/GEL': { sell: 2.9, at: later } },
  keptBoard: { rate: 2.7, at, path: 'direct' },
  lookupBoard: false,
});
assert(sticky.absGel === 2700 && sticky.boardRate === 2.7, 'a later board change does not revalue the snapshot');

const quoted = valueAbsGel({
  sells: 'GEL', gets: 'USD', sellAmt: 2700, getsAmt: 1000,
  quoteRate: 2.65, quoteStatus: 'quoted', quotedAt: later, quoteRecordedAt: null, at,
  board: { 'USD/GEL': { sell: 2.9, at: later } },
  keptBoard: { rate: 2.7, at, path: 'direct' },
  lookupBoard: false,
});
assert(quoted.absGel === 2650 && quoted.source === 'treasury_quote' && quoted.boardRate === 2.7, 'a usable quote replaces the figure and keeps the snapshot');

const crossQuote = valueAbsGel({
  sells: 'USD', gets: 'EUR', sellAmt: 1000, getsAmt: 900,
  quoteRate: 1.08, quoteStatus: 'quoted', quotedAt: later, quoteRecordedAt: null, at,
  board: {},
  keptBoard: null, lookupBoard: true,
});
assert(crossQuote.absGel === null && crossQuote.status === 'pending_admin' && crossQuote.reason === 'no_board_rate', 'an unusable cross quote leaves pending');

const crossLeavesProvisional = valueAbsGel({
  sells: 'USD', gets: 'EUR', sellAmt: 1000, getsAmt: 100,
  quoteRate: 1.08, quoteStatus: 'quoted', quotedAt: later, quoteRecordedAt: null, at,
  board: { 'EUR/GEL': { sell: 9, at: later } },
  keptBoard: { rate: 3.2, at, path: 'direct' },
  lookupBoard: false,
});
assert(
  crossLeavesProvisional.absGel === 320
    && crossLeavesProvisional.source === 'provisional_board'
    && crossLeavesProvisional.boardRate === 3.2,
  'a cross quote does not replace a provisional number',
);

const rub = valueAbsGel({
  sells: 'GEL', gets: 'RUB', sellAmt: 100, getsAmt: 1000,
  quoteRate: null, quoteStatus: 'asking', quotedAt: null, quoteRecordedAt: null, at,
  board: { 'RUB/GEL': { sell: 84.7, at } },
  keptBoard: null, lookupBoard: true,
});
assert(rub.absGel === null && rub.status === 'pending_admin' && rub.boardRate === null, 'RUB at 1 or above is not lari and is not divided');

const rubOk = valueAbsGel({
  sells: 'GEL', gets: 'RUB', sellAmt: 30, getsAmt: 1000,
  quoteRate: null, quoteStatus: 'asking', quotedAt: null, quoteRecordedAt: null, at,
  board: { 'RUB/GEL': { sell: 0.03, at } },
  keptBoard: null, lookupBoard: true,
});
assert(rubOk.absGel === 30 && rubOk.path === 'direct', 'RUB below 1 inside the band is used as stored');

const eurCross = valueAbsGel({
  sells: 'USD', gets: 'EUR', sellAmt: 100, getsAmt: 100,
  quoteRate: null, quoteStatus: 'asking', quotedAt: null, quoteRecordedAt: null, at,
  board: {
    'EUR/USD': { sell: 1.1, at },
    'USD/GEL': { sell: 2.7, at: later },
  },
  keptBoard: null, lookupBoard: true,
});
assert(eurCross.absGel === 297 && eurCross.path === 'cross:EUR/USD*USD/GEL', 'EUR/GEL is EUR/USD times USD/GEL');

const usdCross = valueAbsGel({
  sells: 'EUR', gets: 'USD', sellAmt: 100, getsAmt: 100,
  quoteRate: null, quoteStatus: 'asking', quotedAt: null, quoteRecordedAt: null, at,
  board: {
    'EUR/GEL': { sell: 3, at },
    'EUR/USD': { sell: 1.1, at: later },
  },
  keptBoard: null, lookupBoard: true,
});
assert(usdCross.absGel === 272.73 && usdCross.path === 'cross:EUR/GEL/EUR/USD', 'USD/GEL is EUR/GEL divided by EUR/USD');

const noInvert = valueAbsGel({
  sells: 'GEL', gets: 'USD', sellAmt: 270, getsAmt: 100,
  quoteRate: null, quoteStatus: 'asking', quotedAt: null, quoteRecordedAt: null, at,
  board: { 'GEL/USD': { sell: 0.37, at } },
  keptBoard: null, lookupBoard: true,
});
assert(noInvert.status === 'pending_admin' && noInvert.absGel === null, 'a reciprocal row is not inverted');

const derived = valueAbsGel({
  sells: 'GEL', gets: 'USD', sellAmt: 2700, getsAmt: null,
  quoteRate: null, quoteStatus: 'asking', quotedAt: null, quoteRecordedAt: null, at,
  board: { 'USD/GEL': { sell: 2.7, at } },
  keptBoard: null, lookupBoard: true,
});
assert(derived.absGel === 2700 && derived.path === 'direct', 'selling GEL against a direct rate uses the sell amount');

const noDerive = valueAbsGel({
  sells: 'GEL', gets: 'EUR', sellAmt: 2700, getsAmt: null,
  quoteRate: null, quoteStatus: 'asking', quotedAt: null, quoteRecordedAt: null, at,
  board: {
    'EUR/USD': { sell: 1.1, at },
    'USD/GEL': { sell: 2.7, at },
  },
  keptBoard: null, lookupBoard: true,
});
assert(noDerive.status === 'pending_admin' && noDerive.reason === 'cannot_derive' && noDerive.absGel === null, 'a cross is not used to derive a missing amount');
assert(noDerive.boardPath === 'cross:EUR/USD*USD/GEL', 'the cross snapshot is kept while pending');

const manual: AbsResult = {
  absGel: 500, source: 'manual_admin', status: 'calculated',
  rate: null, rateAt: null, path: 'manual', reason: null,
  boardRate: null, boardAt: null, boardPath: null,
};
const overwritten = applyAutomatic(manual, quoted);
assert(overwritten.absGel === 500 && overwritten.source === 'manual_admin', 'a later quote does not replace a manual figure');

const summed = sumAbs([
  { absGel: 2700, status: 'calculated' },
  { absGel: null, status: 'pending_admin' },
  { absGel: null, status: null },
]);
assert(summed === 2700, 'null is not summed as zero');
assert(sumAbs([{ absGel: null, status: 'pending_admin' }]) === null, 'a pending-only total stays null');

const declined = valueAbsGel({
  sells: 'GEL', gets: 'USD', sellAmt: 2700, getsAmt: 1000,
  quoteRate: 2.65, quoteStatus: 'declined', quotedAt: later, quoteRecordedAt: null, at,
  board: {},
  keptBoard: { rate: 2.7, at, path: 'direct' },
  lookupBoard: false,
});
assert(declined.absGel === 2700 && declined.source === 'provisional_board', 'a decline does not replace the provisional number');

const noLaterBoard = valueAbsGel({
  sells: 'GEL', gets: 'USD', sellAmt: 2700, getsAmt: 1000,
  quoteRate: null, quoteStatus: 'asking', quotedAt: null, quoteRecordedAt: null, at,
  board: { 'USD/GEL': { sell: 2.7, at: later } },
  keptBoard: null,
  lookupBoard: false,
});
assert(
  noLaterBoard.absGel === null
    && noLaterBoard.status === 'pending_admin'
    && noLaterBoard.boardRate === null
    && noLaterBoard.source === null,
  'a later board rate does not fill a missing submission snapshot',
);

const quoteAfterMiss = valueAbsGel({
  sells: 'GEL', gets: 'USD', sellAmt: 2700, getsAmt: 1000,
  quoteRate: 2.65, quoteStatus: 'quoted', quotedAt: later, quoteRecordedAt: '2026-10-17T09:30:00.000Z', at,
  board: { 'USD/GEL': { sell: 2.7, at: later } },
  keptBoard: null,
  lookupBoard: false,
});
assert(
  quoteAfterMiss.absGel === 2650
    && quoteAfterMiss.source === 'treasury_quote'
    && quoteAfterMiss.rateAt === later
    && quoteAfterMiss.boardRate === null,
  'a usable quote values a pending request without storing the later board',
);

const recorded = '2026-10-17T09:30:00.000Z';
const nullQuotedAt = valueAbsGel({
  sells: 'GEL', gets: 'USD', sellAmt: 2700, getsAmt: 1000,
  quoteRate: 2.65, quoteStatus: 'quoted', quotedAt: null, quoteRecordedAt: recorded, at,
  board: { 'USD/GEL': { sell: 2.7, at } },
  keptBoard: { rate: 2.7, at, path: 'direct' },
  lookupBoard: false,
});
assert(
  nullQuotedAt.absGel === 2650
    && nullQuotedAt.source === 'treasury_quote'
    && nullQuotedAt.rateAt === recorded,
  'a usable quote with no quoted_at stores the quote-recording time',
);

console.log('abs gel branches ok');
