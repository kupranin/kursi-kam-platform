// Active negotiated adjustments from public.dynamic_active_negotiated_rates.
// buy_rate and sell_rate are adjustments, not full FX rates.
// Client buy = current standard midpoint + buy_rate.
// Client sell = current standard midpoint − sell_rate.
// Neither result is a side of the request. The file's base is GEL, and the
// platform's "buy" means the client sells the foreign currency. That direction
// stays unresolved here.

export const NEGOTIATED_PAIRS = ['GEL/USD', 'GEL/EUR'] as const;

export type NegotiatedPair = (typeof NEGOTIATED_PAIRS)[number];

export interface NegotiatedSourceRow {
  id: string;
  createdAt: string;
  expiresAt: string | null;
  baseCurrency: string;
  secondaryCurrency: string;
  buyRate: number | null;
  sellRate: number | null;
  standardBuy: number | null;
  standardSell: number | null;
}

export interface NegotiatedView {
  id: string;
  pair: NegotiatedPair;
  createdAt: string;
  expiresAt: string | null;
  buyRate: number | null;
  sellRate: number | null;
  standardBuy: number | null;
  standardSell: number | null;
  midpoint: number | null;
  clientBuy: number | null;
  clientSell: number | null;
  /** True when more than one unexpired row shares the latest created_at. None is chosen. */
  tied: boolean;
}

export function negotiatedPair(base: string, secondary: string): NegotiatedPair | null {
  const a = base.trim().toUpperCase();
  const b = secondary.trim().toUpperCase();
  const foreign = a === 'GEL' && (b === 'USD' || b === 'EUR')
    ? b
    : b === 'GEL' && (a === 'USD' || a === 'EUR')
      ? a
      : null;
  if (foreign === 'USD') return 'GEL/USD';
  if (foreign === 'EUR') return 'GEL/EUR';
  return null;
}

/** Current standard midpoint. There is no mid column on reference_rates. */
export function standardMidpoint(buy: number, sell: number): number {
  return (buy + sell) / 2;
}

export function clientBuyFromAdjustment(midpoint: number, buyAdjustment: number): number {
  return midpoint + buyAdjustment;
}

export function clientSellFromAdjustment(midpoint: number, sellAdjustment: number): number {
  return midpoint - sellAdjustment;
}

/** A positive adjustment shows its sign, so it is not read as a full rate. */
export function formatAdjustment(value: number): string {
  const text = value.toFixed(5);
  return value > 0 ? '+' + text : text;
}

function instant(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** One RPC row. Numeric columns may arrive as strings. A row without an id is dropped. */
export function negotiatedSourceFromRpc(raw: Record<string, unknown>): NegotiatedSourceRow | null {
  const id = String(raw.row_id ?? '').trim();
  if (!id) return null;
  return {
    id,
    createdAt: raw.created_at == null ? '' : String(raw.created_at),
    expiresAt: raw.expires_at == null || raw.expires_at === '' ? null : String(raw.expires_at),
    baseCurrency: String(raw.base_currency ?? ''),
    secondaryCurrency: String(raw.secondary_currency ?? ''),
    buyRate: asNumber(raw.buy_rate),
    sellRate: asNumber(raw.sell_rate),
    standardBuy: asNumber(raw.standard_buy),
    standardSell: asNumber(raw.standard_sell),
  };
}

/**
 * Keeps GEL/USD and GEL/EUR only. An expires_at in the past, or exactly now, is hidden.
 * A missing expiry stays. For one pair, only the latest created_at remains.
 * Rows that share that timestamp all stay, and none is chosen.
 */
export function selectActiveNegotiated(rows: NegotiatedSourceRow[], now = Date.now()): NegotiatedView[] {
  const grouped = new Map<NegotiatedPair, NegotiatedSourceRow[]>();
  for (const row of rows) {
    const pair = negotiatedPair(row.baseCurrency, row.secondaryCurrency);
    if (!pair) continue;
    if (row.expiresAt != null) {
      const expiry = instant(row.expiresAt);
      if (expiry == null || expiry <= now) continue;
    }
    const list = grouped.get(pair) ?? [];
    list.push(row);
    grouped.set(pair, list);
  }

  const out: NegotiatedView[] = [];
  for (const pair of NEGOTIATED_PAIRS) {
    const list = grouped.get(pair);
    if (!list?.length) continue;
    let latest = -Infinity;
    let anyTime = false;
    for (const row of list) {
      const at = instant(row.createdAt);
      if (at == null) continue;
      anyTime = true;
      if (at > latest) latest = at;
    }
    const chosen = list.filter((row) => {
      const at = instant(row.createdAt);
      if (!anyTime) return at == null;
      return at === latest;
    });
    chosen.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const tied = chosen.length > 1;
    for (const row of chosen) {
      const midpoint = finite(row.standardBuy) && finite(row.standardSell)
        ? standardMidpoint(row.standardBuy, row.standardSell)
        : null;
      const buyRate = finite(row.buyRate) ? row.buyRate : null;
      const sellRate = finite(row.sellRate) ? row.sellRate : null;
      out.push({
        id: row.id,
        pair,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        buyRate,
        sellRate,
        standardBuy: finite(row.standardBuy) ? row.standardBuy : null,
        standardSell: finite(row.standardSell) ? row.standardSell : null,
        midpoint,
        clientBuy: midpoint != null && buyRate != null ? clientBuyFromAdjustment(midpoint, buyRate) : null,
        clientSell: midpoint != null && sellRate != null ? clientSellFromAdjustment(midpoint, sellRate) : null,
        tied,
      });
    }
  }
  return out;
}
