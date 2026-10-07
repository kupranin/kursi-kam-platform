import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useI18n } from '../lib/i18n';
import { fmtDateTime, fmtRate } from '../lib/format';
import { dealPair, latestQuotesForPair, orientSnapshot, type PairSourceQuote, type RateSnapshot } from '../lib/rateGrid';

function num(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toSnapshot(row: Record<string, unknown>): RateSnapshot {
  return {
    source: String(row.source ?? ''),
    venue: String(row.venue ?? ''),
    venue_kind: String(row.venue_kind ?? ''),
    currency: String(row.currency ?? ''),
    quote_currency: String(row.quote_currency ?? ''),
    buy: num(row.buy as number | string | null),
    sell: num(row.sell as number | string | null),
    fetched_at: String(row.fetched_at ?? ''),
  };
}

async function loadPair(base: string, quote: string): Promise<RateSnapshot[]> {
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) return [];
  const since = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('market_rates')
    .select('source, venue, venue_kind, currency, quote_currency, buy, sell, fetched_at')
    .in('venue_kind', ['board', 'bank'])
    .or(`and(currency.eq.${base},quote_currency.eq.${quote}),and(currency.eq.${quote},quote_currency.eq.${base})`)
    .gte('fetched_at', since)
    .order('fetched_at', { ascending: false })
    .limit(800);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((row) => orientSnapshot(toSnapshot(row)));
}

export default function PairBoard({ sells, gets }: { sells: string; gets: string }) {
  const { t } = useI18n();
  const pair = dealPair(sells, gets);
  const [quotes, setQuotes] = useState<PairSourceQuote[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    let live = true;
    setEmpty(false);
    loadPair(pair.base, pair.quote)
      .then((rows) => {
        if (!live) return;
        const board = latestQuotesForPair(rows, pair.base, pair.quote);
        setQuotes(board.quotes);
        setUpdatedAt(board.updatedAt);
        setEmpty(board.quotes.length === 0);
      })
      .catch(() => { if (live) setEmpty(true); });
    return () => { live = false; };
  }, [pair.base, pair.quote]);

  const title = pair.base + '/' + pair.quote;
  return (
    <div className="pair-board">
      <div className="row-between">
        <span className="small strong">{t('ბაზრის კურსები', 'Market rates')} {title}</span>
        {updatedAt && <span className="tiny muted">{fmtDateTime(updatedAt)}</span>}
      </div>
      <p className="tiny muted" style={{ margin: '2px 0 8px' }}>
        {t('ყიდვა და გაყიდვა, Kursi და კონკურენტები. წყარო ამ წყვილზე კურსის გარეშე არ ჩანს.', 'Buy and sell, Kursi and competitors. A source with no rate for this pair is left out.')}
      </p>
      {empty && <p className="tiny muted" style={{ margin: 0 }}>{t('ამ წყვილზე შენახული კურსი ჯერ არ არის.', 'No saved rate for this pair yet.')}</p>}
      {quotes.length > 0 && (
        <div className="table-wrap">
          <table className="table pair-table">
            <thead>
              <tr>
                <th>{t('წყარო', 'Source')}</th>
                <th className="num">{t('ყიდვა', 'Buy')}</th>
                <th className="num">{t('გაყიდვა', 'Sell')}</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  <td className="num">{fmtRate(row.buy)}</td>
                  <td className="num">{fmtRate(row.sell)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
