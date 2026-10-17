/**
 * Older request-lari figure. Same branches as private.request_gel.
 * Analytics ABS GEL does not use this. That figure is
 * private.request_abs_valuation: the received amount times lari per 1
 * unit of the received currency. A treasury quote is used only when it
 * is already that lari rate. Otherwise the Kursi board at request time
 * is used. A blank amount or a rate that is not lari stays empty.
 * RUB at 1 or above is not lari. RUB below 1 is lari per 1 ruble.
 * Nothing here is multiplied by a fixed dollar or ruble constant.
 * A cross with no GEL side stays empty.
 */
export function requestGel(
  sells: string | null | undefined,
  gets: string | null | undefined,
  sellAmt: number | null,
  getsAmt: number | null,
  rate: number | null,
): number | null {
  if (sells === 'GEL' && sellAmt != null) return round2(sellAmt);
  if (gets === 'GEL' && getsAmt != null) return round2(getsAmt);
  if (rate == null || !(rate > 0)) return null;
  if (sells === 'GEL' && gets === 'RUB' && getsAmt != null && rate < 1) return round2(getsAmt * rate);
  if (gets === 'GEL' && sells === 'RUB' && sellAmt != null && rate < 1) return round2(sellAmt * rate);
  if (sells === 'GEL' && (gets === 'USD' || gets === 'EUR') && getsAmt != null && rate >= 1 && rate <= 10) {
    return round2(getsAmt * rate);
  }
  if (gets === 'GEL' && (sells === 'USD' || sells === 'EUR') && sellAmt != null && rate >= 1 && rate <= 10) {
    return round2(sellAmt * rate);
  }
  if (sells === 'GEL' && getsAmt != null && gets !== 'RUB' && gets !== 'USD' && gets !== 'EUR') return round2(getsAmt * rate);
  if (gets === 'GEL' && sellAmt != null && sells !== 'RUB' && sells !== 'USD' && sells !== 'EUR') return round2(sellAmt * rate);
  return null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function asAmount(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
