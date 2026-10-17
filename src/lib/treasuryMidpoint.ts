// Confirmation against the published Kursi board already on the rate desk.
// The quote and that board row are both GEL for 1 unit of the foreign currency.
// Midpoint is (buy + sell) / 2. Buying GEL warns when the quote is above it.
// Selling GEL warns when the quote is below it. A cross with no GEL side,
// or a missing Kursi buy or sell, does not warn.

import type { CurrentBoard } from './rateGrid';

export interface MidpointWarning {
  direction: 'above' | 'below';
  midpoint: number;
}

export const MIDPOINT_ABOVE = {
  ka: 'შეამოწმეთ კურსი: {rate} გამოქვეყნებულ შუა წერტილზე {mid} მაღლაა. თუ სწორია, დააჭირეთ „მაინც გაგზავნა“.',
  en: 'Check the rate: {rate} is above the published midpoint {mid}. If it is right, press Send anyway.',
};

export const MIDPOINT_BELOW = {
  ka: 'შეამოწმეთ კურსი: {rate} გამოქვეყნებულ შუა წერტილზე {mid} დაბლაა. თუ სწორია, დააჭირეთ „მაინც გაგზავნა“.',
  en: 'Check the rate: {rate} is below the published midpoint {mid}. If it is right, press Send anyway.',
};

export function midpointWarningText(direction: 'above' | 'below'): { ka: string; en: string } {
  return direction === 'above' ? MIDPOINT_ABOVE : MIDPOINT_BELOW;
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

/** Kursi buy and sell for this quote, from the desk board. Missing means no warning. */
export function treasuryMidpointWarning(
  board: CurrentBoard | null | undefined,
  sells: string | null | undefined,
  gets: string | null | undefined,
  rate: number,
): MidpointWarning | null {
  if (!board || !sells || !gets || !Number.isFinite(rate)) return null;
  const buyingGel = gets === 'GEL' && sells !== 'GEL';
  const sellingGel = sells === 'GEL' && gets !== 'GEL';
  if (!buyingGel && !sellingGel) return null;

  const pair = (buyingGel ? sells : gets) + '/GEL';
  const index = board.pairs.indexOf(pair);
  if (index < 0) return null;
  const quote = board.rows.find((row) => row.key === 'kursi')?.quotes[index];
  if (!quote || !finite(quote.buy) || !finite(quote.sell)) return null;

  const midpoint = (quote.buy + quote.sell) / 2;
  if (buyingGel && rate > midpoint) return { direction: 'above', midpoint };
  if (sellingGel && rate < midpoint) return { direction: 'below', midpoint };
  return null;
}
