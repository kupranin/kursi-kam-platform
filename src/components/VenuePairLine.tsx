import { useEffect, useState } from 'react';
import { fmtDateTime, fmtRate } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { dealPair, orientSnapshot, type RateSnapshot } from '../lib/rateGrid';
import { supabase } from '../lib/supabase';

// Valuto is source "valuto", venue "Valuto", venue_kind "board"
// (fetch-market-rates valuto(), stored in market_rates).
// Online Express has no source in that function. A stored board or bank
// row is shown only when its venue or source compacts to "onlineexpress".
// Express Lombard (expresslombard / "Express Lombard") is a different provider
// and is not substituted. Kiosks stay off this line, same as the rate board.

type VenueKey = 'valuto' | 'onlineexpress';

interface QuoteLine {
  key: VenueKey;
  label: string;
  buy: number | null;
  sell: number | null;
  fetched_at: string;
}

function num(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function venueKey(row: RateSnapshot): VenueKey | null {
  if (row.venue_kind === 'kiosk' || row.venue.endsWith(' app')) return null;
  if (row.source === 'valuto' && row.venue_kind === 'board') return 'valuto';
  const name = compact(row.venue);
  const source = compact(row.source);
  if (name === 'onlineexpress' || source === 'onlineexpress') return 'onlineexpress';
  return null;
}

function invertPair(buy: number | null, sell: number | null): { buy: number | null; sell: number | null } {
  const inv = (value: number | null) => (value != null && value !== 0 ? 1 / value : null);
  if (buy != null && sell != null) return { buy: inv(sell), sell: inv(buy) };
  return { buy: inv(buy), sell: inv(sell) };
}

function inDirection(row: RateSnapshot, base: string, quote: string): { buy: number | null; sell: number | null } | null {
  const oriented = orientSnapshot(row);
  if (oriented.currency === base && oriented.quote_currency === quote) {
    return { buy: oriented.buy, sell: oriented.sell };
  }
  if (oriented.currency === quote && oriented.quote_currency === base) {
    return invertPair(oriented.buy, oriented.sell);
  }
  return null;
}

async function loadLines(base: string, quote: string, include: VenueKey[]): Promise<QuoteLine[]> {
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote) || !include.length) return [];
  const since = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('market_rates')
    .select('source, venue, venue_kind, currency, quote_currency, buy, sell, fetched_at')
    .in('venue_kind', ['board', 'bank'])
    .or(`and(currency.eq.${base},quote_currency.eq.${quote}),and(currency.eq.${quote},quote_currency.eq.${base})`)
    .gte('fetched_at', since)
    .order('fetched_at', { ascending: false })
    .limit(800);
  if (error || !data) return [];
  const wanted = new Set(include);
  const best = new Map<VenueKey, QuoteLine>();
  for (const raw of data as Record<string, unknown>[]) {
    const row: RateSnapshot = {
      source: String(raw.source ?? ''),
      venue: String(raw.venue ?? ''),
      venue_kind: String(raw.venue_kind ?? ''),
      currency: String(raw.currency ?? ''),
      quote_currency: String(raw.quote_currency ?? ''),
      buy: num(raw.buy as number | string | null),
      sell: num(raw.sell as number | string | null),
      fetched_at: String(raw.fetched_at ?? ''),
    };
    const key = venueKey(row);
    if (!key || !wanted.has(key)) continue;
    const sided = inDirection(row, base, quote);
    if (!sided || (sided.buy == null && sided.sell == null)) continue;
    const prev = best.get(key);
    if (prev && prev.fetched_at >= row.fetched_at) continue;
    best.set(key, {
      key,
      label: key === 'valuto' ? 'Valuto' : 'Online Express',
      buy: sided.buy,
      sell: sided.sell,
      fetched_at: row.fetched_at,
    });
  }
  return [...best.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Stored Valuto and Online Express quotes for this deal pair. Empty when none are saved. */
export default function VenuePairLine({
  sells,
  gets,
  include = ['valuto', 'onlineexpress'],
}: {
  sells: string;
  gets: string;
  include?: VenueKey[];
}) {
  const { t } = useI18n();
  const pair = dealPair(sells, gets);
  const includeKey = include.join(',');
  const [lines, setLines] = useState<QuoteLine[]>([]);

  useEffect(() => {
    let live = true;
    loadLines(pair.base, pair.quote, includeKey ? includeKey.split(',') as VenueKey[] : [])
      .then((next) => { if (live) setLines(next); })
      .catch(() => { if (live) setLines([]); });
    return () => { live = false; };
  }, [pair.base, pair.quote, includeKey]);

  if (!lines.length) return null;
  const updated = [...lines.map((line) => line.fetched_at)].sort().slice(-1)[0] ?? '';

  return (
    <div className="venue-pair">
      {lines.map((line) => (
        <p key={line.key} className="small" style={{ margin: '4px 0 0' }}>
          <span className="strong">{line.label}</span>
          {line.buy != null ? ` · ${t('ყიდვა', 'Buy')} ${fmtRate(line.buy)}` : ''}
          {line.sell != null ? ` · ${t('გაყიდვა', 'Sell')} ${fmtRate(line.sell)}` : ''}
        </p>
      ))}
      {updated && <p className="tiny muted" style={{ margin: '2px 0 0' }}>{fmtDateTime(updated)}</p>}
    </div>
  );
}
