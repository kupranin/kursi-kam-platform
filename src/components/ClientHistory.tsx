import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useI18n } from '../lib/i18n';
import { fmtDay, fmtRate, fmtTime, fmtWhole, sideAmount } from '../lib/format';
import { dealPair, latestQuotesForPair, type RateSnapshot } from '../lib/rateGrid';
import { IconCheck } from './Icons';

interface HistRow {
  id: number;
  request_date: string;
  requested_at: string;
  sells_currency: string | null;
  gets_currency: string | null;
  amount: number | null;
  gets_amount: number | null;
  rate: number | null;
  outcome: string | null;
  kam_name: string | null;
  bank: string | null;
  total_count: number | null;
}

interface Props {
  clientId: string;
  /** Leave this open desk request out of the six-month list. */
  excludeId?: number;
}

function num(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtDelta(given: number, standard: number): string {
  const text = (given - standard).toFixed(4);
  if (text === '0.0000' || text === '-0.0000') return '0.0000';
  if (text.startsWith('-')) return '−' + text.slice(1);
  return '+' + text;
}

/** Latest stored Kursi board snapshots. No live scrape, and no made-up rate. */
async function loadKursi(rows: HistRow[]): Promise<RateSnapshot[]> {
  const codes = new Set<string>();
  for (const row of rows) {
    if (row.sells_currency && row.sells_currency !== 'GEL') codes.add(row.sells_currency);
    if (row.gets_currency && row.gets_currency !== 'GEL') codes.add(row.gets_currency);
  }
  if (!codes.size) return [];
  const { data, error } = await supabase
    .from('market_rates')
    .select('source, venue, venue_kind, currency, quote_currency, buy, sell, fetched_at')
    .eq('source', 'kursi')
    .eq('venue_kind', 'board')
    .in('currency', [...codes])
    .order('fetched_at', { ascending: false })
    .limit(200);
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map((row) => ({
    source: String(row.source ?? ''),
    venue: String(row.venue ?? ''),
    venue_kind: String(row.venue_kind ?? ''),
    currency: String(row.currency ?? ''),
    quote_currency: String(row.quote_currency ?? ''),
    buy: num(row.buy as number | string | null),
    sell: num(row.sell as number | string | null),
    fetched_at: String(row.fetched_at ?? ''),
  }));
}

/**
 * Client sells the base: Kursi buy.
 * Client sells GEL: Kursi sell of the currency they receive.
 * Blank when that side was not stored.
 */
function standardSide(sells: string, gets: string, snaps: RateSnapshot[]): { side: 'buy' | 'sell'; rate: number } | null {
  if (!sells || !gets || sells === gets) return null;
  const pair = dealPair(sells, gets);
  const kursi = latestQuotesForPair(snaps, pair.base, pair.quote).quotes.find((q) => q.key === 'kursi');
  if (!kursi) return null;
  const side = sells === 'GEL' ? 'sell' : 'buy';
  const rate = kursi[side];
  if (rate == null || !(rate > 0)) return null;
  return { side, rate };
}

export default function ClientHistory({ clientId, excludeId }: Props) {
  const { t } = useI18n();
  const [rows, setRows] = useState<HistRow[]>([]);
  const [snaps, setSnaps] = useState<RateSnapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const titleId = 'client-history-' + clientId + '-' + (excludeId ?? 'new');

  useEffect(() => {
    const my = ++seq.current;
    setLoaded(false);
    setFailed(false);
    (async () => {
      try {
        const { data, error } = await supabase.rpc('client_request_history', {
          p_client_id: clientId,
          p_exclude_id: excludeId ?? null,
        });
        if (my !== seq.current) return;
        if (error) {
          setRows([]);
          setSnaps([]);
          setFailed(true);
          setLoaded(true);
          return;
        }
        const list = ((data ?? []) as HistRow[]).map((row) => ({
          ...row,
          id: Number(row.id),
          amount: num(row.amount),
          gets_amount: num(row.gets_amount),
          rate: num(row.rate),
          total_count: num(row.total_count),
        }));
        const shots = await loadKursi(list);
        if (my !== seq.current) return;
        setRows(list);
        setSnaps(shots);
        setFailed(false);
        setLoaded(true);
      } catch {
        if (my !== seq.current) return;
        setRows([]);
        setSnaps([]);
        setFailed(true);
        setLoaded(true);
      }
    })();
  }, [clientId, excludeId]);

  const total = rows.length ? (rows[0].total_count ?? rows.length) : 0;
  const countLine = rows.length < total
    ? t('ბოლო 6 თვე · ყველა KAM · ნაჩვენებია {shown} {total}-დან', 'Last 6 months · every KAM · showing {shown} of {total}', { shown: fmtWhole(rows.length), total: fmtWhole(total) })
    : t('ბოლო 6 თვე · ყველა KAM · {count} მოთხოვნა', 'Last 6 months · every KAM · {count} requests', { count: fmtWhole(total) });

  return (
    <section className="client-history" aria-labelledby={titleId}>
      <div className="small strong" id={titleId}>{t('ამ კლიენტის მოთხოვნები ბოლო 6 თვეში', 'This client\'s requests in the last 6 months')}</div>
      {!loaded && <p className="tiny muted" style={{ margin: '6px 0 0' }}>{t('იტვირთება…', 'Loading…')}</p>}
      {loaded && failed && <p className="tiny muted" style={{ margin: '6px 0 0' }}>{t('ისტორია ჯერ არ იტვირთება.', 'History is not loading yet.')}</p>}
      {loaded && !failed && !rows.length && (
        <p className="tiny muted" style={{ margin: '6px 0 0' }}>{t('ბოლო 6 თვეში ამ კლიენტთან მოთხოვნა არ არის.', 'No request for this client in the last 6 months.')}</p>
      )}
      {loaded && !failed && rows.length > 0 && (
        <>
          <p className="tiny muted" style={{ margin: '2px 0 0' }}>{countLine}</p>
          <p className="tiny muted" style={{ margin: '2px 0 6px' }}>
            {t('სტანდარტი Kursi-ის ბოლო შენახული ყიდვა ან გაყიდვაა. შენახული კურსის გარეშე შედარება ცარიელია.', 'Standard is the latest saved Kursi buy or sell. With no saved rate, the comparison stays blank.')}
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('თარიღი', 'Date')}</th>
                  <th>KAM</th>
                  <th>{t('ყიდის', 'Sells')}</th>
                  <th>{t('იღებს', 'Gets')}</th>
                  <th className="num">{t('კურსი', 'Rate')}</th>
                  <th className="num">{t('სტანდარტი', 'Standard')}</th>
                  <th>{t('ბანკი', 'Bank')}</th>
                  <th>{t('შედეგი', 'Outcome')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const rate = num(row.rate);
                  const sells = row.sells_currency ?? '';
                  const gets = row.gets_currency ?? '';
                  const standard = rate != null && sells && gets ? standardSide(sells, gets, snaps) : null;
                  const went = row.outcome === 'went_through';
                  const missed = row.outcome === 'did_not_go_through';
                  const pill = went
                    ? { label: t('გავიდა', 'Went through'), cls: 'pill-ok' }
                    : missed
                      ? { label: t('არ გავიდა', 'Did not go through'), cls: 'pill-alert' }
                      : { label: t('ღია', 'Open'), cls: 'pill-wait' };
                  const sideLabel = standard?.side === 'sell' ? t('გაყიდვა', 'Sell') : t('ყიდვა', 'Buy');
                  return (
                    <tr key={row.id}>
                      <td>
                        <div className="strong">{fmtDay(row.request_date)}</div>
                        <div className="tiny muted">{fmtTime(row.requested_at)}</div>
                      </td>
                      <td>{row.kam_name ?? t('KAM არ არის', 'No KAM')}</td>
                      <td>{sideAmount(row.sells_currency, num(row.amount))}</td>
                      <td>{sideAmount(row.gets_currency, num(row.gets_amount))}</td>
                      <td className="num">{rate != null && <div className="strong">{fmtRate(rate)}</div>}</td>
                      <td className="num">
                        {standard && rate != null && (
                          <>
                            <div>{sideLabel} {fmtRate(standard.rate)}</div>
                            <div className="tiny muted" title={t('გაცემული მინუს სტანდარტი', 'Given rate minus standard')}>{fmtDelta(rate, standard.rate)}</div>
                          </>
                        )}
                      </td>
                      <td>{row.bank ?? ''}</td>
                      <td><span className={'pill ' + pill.cls}>{pill.cls === 'pill-ok' && <IconCheck />}{pill.label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
