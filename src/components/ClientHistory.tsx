import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { loadRatePeople, type RatePeopleNames } from '../lib/ratePeople';
import { ownerDisplayText, ownerSourceCaption, type EffectiveOwner } from '../lib/clientOwnership';
import { loadEffectiveOwners, type OwnerLoad } from '../lib/clientOwners';
import { useI18n } from '../lib/i18n';
import { fmtDay, fmtRate, fmtTime, fmtWhole, sideAmount } from '../lib/format';
import { dealPair, latestQuotesForPair, type RateSnapshot } from '../lib/rateGrid';
import { AgreedThenLostLine, useAgreedThenLost } from './AgreedThenLostMark';
import { IconCheck } from './Icons';
import LoadingLine from './LoadingLine';
import RatePeople from './RatePeople';

interface HistRow {
  id: number;
  request_date: string;
  requested_at: string;
  sells_currency: string | null;
  gets_currency: string | null;
  amount: number | null;
  gets_amount: number | null;
  received_amount?: number | null;
  rate: number | null;
  outcome: string | null;
  kpi_class?: string | null;
  legacy_status?: string | null;
  kam_name: string | null;
  owner_name?: string | null;
  bank: string | null;
  total_count: number | null;
  client_reply?: string | null;
  marked_lost_at?: string | null;
  rate_written_at?: string | null;
  quote_status?: string | null;
  loss_code?: string | null;
  better_decision?: string | null;
  rate_write_deferred?: boolean | null;
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
  const text = (given - standard).toFixed(5);
  if (text === '0.00000' || text === '-0.00000') return '0.00000';
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
  const { t, lang } = useI18n();
  const agreedLost = useAgreedThenLost(clientId);
  const [rows, setRows] = useState<HistRow[]>([]);
  const [ownerLoad, setOwnerLoad] = useState<OwnerLoad | null>(null);
  const [snaps, setSnaps] = useState<RateSnapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [people, setPeople] = useState<Map<number, RatePeopleNames>>(new Map());
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const titleId = 'client-history-' + clientId + '-' + (excludeId ?? 'new');

  useEffect(() => {
    let live = true;
    setOwnerLoad(null);
    loadEffectiveOwners([clientId])
      .then((result) => { if (live) setOwnerLoad(result); })
      .catch(() => { if (live) setOwnerLoad({ status: 'failed' }); });
    return () => { live = false; };
  }, [clientId]);

  useEffect(() => {
    const my = ++seq.current;
    setLoaded(false);
    setFailed(false);
    (async () => {
      try {
        const fresh = await supabase.rpc('client_request_history', {
          p_client_id: clientId,
          p_offset: 0,
          p_limit: 21,
        });
        const freshMissing = !!fresh.error && (
          fresh.error.code === 'PGRST202'
          || (fresh.error.message ?? '').toLowerCase().includes('could not find')
          || (fresh.error.message ?? '').toLowerCase().includes('p_offset')
        );
        const loaded = freshMissing
          ? await supabase.rpc('client_request_history', {
            p_client_id: clientId,
            p_exclude_id: excludeId ?? null,
          })
          : fresh;
        const data = freshMissing
          ? loaded.data
          : ((loaded.data ?? []) as HistRow[]).filter((row) => excludeId == null || Number(row.id) !== excludeId);
        const error = loaded.error;
        if (my !== seq.current) return;
        if (error) {
          setRows([]);
          setSnaps([]);
          setPeople(new Map());
          setFailed(true);
          setLoaded(true);
          return;
        }
        const list = ((data ?? []) as HistRow[]).map((row) => ({
          ...row,
          id: Number(row.id),
          amount: num(row.amount),
          gets_amount: num(row.gets_amount ?? row.received_amount),
          rate: num(row.rate),
          total_count: num(row.total_count),
        }));
        const [shots, names] = await Promise.all([
          loadKursi(list),
          loadRatePeople(list.map((row) => row.id)),
        ]);
        if (my !== seq.current) return;
        setRows(list);
        setSnaps(shots);
        setPeople(names);
        setFailed(false);
        setLoaded(true);
      } catch {
        if (my !== seq.current) return;
        setRows([]);
        setSnaps([]);
        setPeople(new Map());
        setFailed(true);
        setLoaded(true);
      }
    })();
  }, [clientId, excludeId]);

  const readyOwner: EffectiveOwner | null = ownerLoad?.status === 'ok'
    ? (ownerLoad.owners.get(clientId) ?? [...ownerLoad.owners.values()][0] ?? null)
    : null;

  function historyOwner(row: HistRow): { text: string; caption: string } {
    if (!ownerLoad) return { text: '', caption: '' };
    if (ownerLoad.status === 'failed') return { text: ownerDisplayText('missing', null, lang), caption: '' };
    if (ownerLoad.status === 'missing') {
      if (row.owner_name === undefined) return { text: '', caption: '' };
      return { text: row.owner_name ?? ownerDisplayText('none', null, lang), caption: '' };
    }
    if (!readyOwner) return { text: ownerDisplayText('unresolved', null, lang), caption: ownerSourceCaption('unresolved', lang) };
    return {
      text: ownerDisplayText(readyOwner.state, readyOwner.ownerName, lang),
      caption: ownerSourceCaption(readyOwner.source, lang),
    };
  }

  const total = rows.length ? (rows[0].total_count ?? rows.length) : 0;
  const countLine = rows.length < total
    ? t('ბოლო 6 თვე · ყველა KAM · ნაჩვენებია {shown} {total}-დან', 'Last 6 months · every KAM · showing {shown} of {total}', { shown: fmtWhole(rows.length), total: fmtWhole(total) })
    : t('ბოლო 6 თვე · ყველა KAM · {count} მოთხოვნა', 'Last 6 months · every KAM · {count} requests', { count: fmtWhole(total) });

  return (
    <section className="client-history" aria-labelledby={titleId}>
      <div className="small strong" id={titleId}>{t('ამ კლიენტის მოთხოვნები ბოლო 6 თვეში', 'This client\'s requests in the last 6 months')}</div>
      {!loaded && <LoadingLine compact />}
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
                  <th>{t('კლიენტის მფლობელი', 'Client owner')}</th>
                  <th>{t('მოთხოვნის KAM', 'Request KAM')}</th>
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
                  const klass = row.kpi_class === 'won' || row.kpi_class === 'lost' || row.kpi_class === 'open'
                    ? row.kpi_class
                    : row.outcome === 'went_through'
                      ? 'won'
                      : row.outcome === 'did_not_go_through'
                        ? 'lost'
                        : 'open';
                  const pill = klass === 'won'
                    ? { label: t('მოგებული', 'Won'), cls: 'pill-ok' }
                    : klass === 'lost'
                      ? { label: t('დაკარგული', 'Lost'), cls: 'pill-alert' }
                      : { label: t('ღია', 'Open'), cls: 'pill-wait' };
                  const sideLabel = standard?.side === 'sell' ? t('გაყიდვა', 'Sell') : t('ყიდვა', 'Buy');
                  const owner = historyOwner(row);
                  const agreedMark = agreedLost.requestIds.includes(row.id);
                  return (
                    <tr key={row.id} className={agreedMark ? 'is-agreed-then-lost' : undefined}>
                      <td>
                        <div className="strong">{fmtDay(row.request_date)}</div>
                        <div className="tiny muted">{fmtTime(row.requested_at)}</div>
                      </td>
                      <td>
                        {owner.text}
                        {owner.caption ? <div className="tiny muted">{owner.caption}</div> : null}
                      </td>
                      <td>{row.kam_name ?? t('KAM არ არის', 'No KAM')}</td>
                      <td>{sideAmount(row.sells_currency, num(row.amount))}</td>
                      <td>{sideAmount(row.gets_currency, num(row.gets_amount))}</td>
                      <td className="num">
                        {rate != null && <div className="strong">{fmtRate(rate)}</div>}
                        <RatePeople quoted={people.get(row.id)?.quoted_by_name} written={people.get(row.id)?.written_by_name} />
                      </td>
                      <td className="num">
                        {standard && rate != null && (
                          <>
                            <div>{sideLabel} {fmtRate(standard.rate)}</div>
                            <div className="tiny muted" title={t('გაცემული მინუს სტანდარტი', 'Given rate minus standard')}>{fmtDelta(rate, standard.rate)}</div>
                          </>
                        )}
                      </td>
                      <td>{row.bank ?? ''}</td>
                      <td>
                        <span className={'pill ' + pill.cls}>{pill.cls === 'pill-ok' && <IconCheck />}{pill.label}</span>
                        {agreedMark && <AgreedThenLostLine />}
                        {row.legacy_status?.trim() && <div className="tiny muted">{row.legacy_status}</div>}
                      </td>
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
