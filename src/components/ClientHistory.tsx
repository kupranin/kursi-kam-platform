import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useI18n } from '../lib/i18n';
import { fmtDay, fmtRate, fmtTime, sideAmount } from '../lib/format';
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
  approved_rate: number | null;
  client_reply: string | null;
  outcome: string | null;
  went_through: boolean | null;
  kam_name: string | null;
}

interface Props {
  clientId: string;
  /** Leave this request out and show the five before it. */
  excludeId?: number;
  /** Set on the KAM form so an admin preview still shows only that KAM. */
  kamId?: string;
  /** Treasury sees deals from every KAM, so the name is on the row. */
  showKam?: boolean;
}

const COLS = 'id, request_date, requested_at, sells_currency, gets_currency, amount, gets_amount, rate, approved_rate, client_reply, outcome, went_through, kam_name';

function num(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function givenRate(row: HistRow): number | null {
  if (row.client_reply === 'approved') {
    const approved = num(row.approved_rate);
    if (approved != null && approved > 0) return approved;
  }
  const quoted = num(row.rate);
  return quoted != null && quoted > 0 ? quoted : null;
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

export default function ClientHistory({ clientId, excludeId, kamId, showKam }: Props) {
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
        let before: string | null = null;
        if (excludeId != null) {
          const { data } = await supabase.from('request_outcomes').select('requested_at').eq('id', excludeId).maybeSingle();
          before = (data as { requested_at?: string } | null)?.requested_at ?? null;
        }
        if (my !== seq.current) return;
        let q = supabase.from('request_outcomes').select(COLS).eq('client_id', clientId);
        if (kamId) q = q.eq('kam_id', kamId);
        if (before) q = q.lte('requested_at', before).neq('id', excludeId!);
        else if (excludeId != null) q = q.neq('id', excludeId);
        const { data, error } = await q
          .order('requested_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(5);
        if (my !== seq.current) return;
        if (error) {
          setRows([]);
          setSnaps([]);
          setFailed(true);
          setLoaded(true);
          return;
        }
        const list = (data ?? []) as HistRow[];
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
  }, [clientId, excludeId, kamId]);

  const title = showKam
    ? t('ბოლო მოთხოვნები ამ კლიენტთან', 'Recent requests for this client')
    : t('თქვენი ბოლო მოთხოვნები ამ კლიენტთან', 'Your recent requests with this client');

  return (
    <section className="client-history" aria-labelledby={titleId}>
      <div className="small strong" id={titleId}>{title}</div>
      {!loaded && <p className="tiny muted" style={{ margin: '6px 0 0' }}>{t('იტვირთება…', 'Loading…')}</p>}
      {loaded && failed && <p className="tiny muted" style={{ margin: '6px 0 0' }}>{t('ისტორია ჯერ არ იტვირთება.', 'History is not loading yet.')}</p>}
      {loaded && !failed && !rows.length && (
        <p className="tiny muted" style={{ margin: '6px 0 0' }}>{t('ამ კლიენტთან წინა მოთხოვნა არ არის.', 'No earlier request for this client.')}</p>
      )}
      {loaded && !failed && rows.length > 0 && (
        <>
          <p className="tiny muted" style={{ margin: '2px 0 6px' }}>
            {t('სტანდარტი Kursi-ის ბოლო შენახული ყიდვა ან გაყიდვაა. შენახული კურსის გარეშე შედარება ცარიელია.', 'Standard is the latest saved Kursi buy or sell. With no saved rate, the comparison stays blank.')}
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('თარიღი', 'Date')}</th>
                  <th>{t('ყიდის', 'Sells')}</th>
                  <th>{t('იღებს', 'Gets')}</th>
                  <th className="num">{t('კურსი', 'Rate')}</th>
                  <th className="num">{t('სტანდარტი', 'Standard')}</th>
                  <th>{t('შედეგი', 'Outcome')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const rate = givenRate(row);
                  const sells = row.sells_currency ?? '';
                  const gets = row.gets_currency ?? '';
                  const standard = rate != null && sells && gets ? standardSide(sells, gets, snaps) : null;
                  const went = row.went_through || row.outcome === 'went_through';
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
                        {showKam && row.kam_name && <div className="tiny muted">{row.kam_name}</div>}
                      </td>
                      <td>{sideAmount(row.sells_currency, num(row.amount))}</td>
                      <td>{sideAmount(row.gets_currency, num(row.gets_amount))}</td>
                      <td className="num">
                        {rate != null && (
                          <>
                            <div className="strong">{fmtRate(rate)}</div>
                            {row.client_reply === 'approved' && <div className="tiny muted">{t('დამტკიცებული', 'Approved')}</div>}
                          </>
                        )}
                      </td>
                      <td className="num">
                        {standard && rate != null && (
                          <>
                            <div>{sideLabel} {fmtRate(standard.rate)}</div>
                            <div className="tiny muted" title={t('გაცემული მინუს სტანდარტი', 'Given rate minus standard')}>{fmtDelta(rate, standard.rate)}</div>
                          </>
                        )}
                      </td>
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
