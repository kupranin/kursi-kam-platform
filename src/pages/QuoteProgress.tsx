import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { useLive } from '../lib/useLive';
import { fmtRate, fmtTime, sideAmount } from '../lib/format';
import { isQuotedProgress } from '../lib/requestStatus';
import type { RequestRow } from '../lib/types';
import DeleteRequestButton from '../components/DeleteRequestButton';

const PAGE = 100;

function progressPill(row: RequestRow, t: (ka: string, en: string) => string): { label: string; cls: string } {
  const expired = row.quote_state === 'expired'
    || (row.quote_status === 'quoted' && !!row.rate_valid_until && new Date(row.rate_valid_until).getTime() < Date.now());
  if (row.client_reply === 'better' && row.better_decision === 'corrected') {
    return { label: t('გასწორებული კურსი KAM-თანაა', 'Corrected rate is with the KAM'), cls: 'pill-ok' };
  }
  if (row.client_reply === 'better' && row.better_decision === 'accepted') {
    return { label: t('კურსი დაბრუნდა KAM-თან', 'Rate went back to the KAM'), cls: 'pill-ok' };
  }
  if (expired) return { label: t('ვადა გაუვიდა', 'Quote expired'), cls: 'pill-wait' };
  return { label: t('კლიენტის პასუხს ელოდება', 'Waiting on the client'), cls: 'pill-warn' };
}

/** Quoted deals that are still open. The rate-to-write list stays on the rate desk. */
export default function QuoteProgress() {
  const { t } = useI18n();
  const { realRole } = useViewAs();
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [shown, setShown] = useState(PAGE);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  useEffect(() => {
    let gone = false;
    (async () => {
      const { data, error: err, count } = await supabase
        .from('request_outcomes')
        .select('*', { count: 'exact' })
        .eq('source', 'app')
        .eq('quote_status', 'quoted')
        .is('rate_written_at', null)
        .is('payment_confirmed_at', null)
        .eq('went_through', false)
        .eq('outcome', 'waiting')
        .eq('loss_open', false)
        .or('client_reply.is.null,and(client_reply.eq.better,better_decision.not.is.null)')
        .order('quoted_at', { ascending: false })
        .order('id', { ascending: false })
        .range(0, shown - 1);
      if (gone) return;
      if (err) {
        setRows([]);
        setTotal(0);
        setHasMore(false);
        setError(t('სია ჯერ არ იტვირთება.', 'This list is not loading yet.'));
      } else {
        const page = ((data ?? []) as RequestRow[]).filter(isQuotedProgress);
        setRows(page);
        setTotal(count ?? page.length);
        setHasMore((count ?? 0) > shown);
        setError('');
      }
      setLoaded(true);
    })();
    return () => { gone = true; };
  }, [shown, reloadKey, t]);

  useLive(['requests'], reload, 15000);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('გაცემულის მიმდინარეობა', 'Quoted progress')}</h1>
          <p>{t(
            'კურსი უკვე გაცემულია და გარიგება ჯერ ღიაა. კურსი გასაწერი კურსის მაგიდაზე რჩება. გაწერილი და დახურული აქ არ ჩანს.',
            'A rate has been quoted and the deal is still open. A rate that still has to be written stays on the rate desk. Written and closed deals do not appear here.',
          )}</p>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="label">{t('ღია გაცემული', 'Open quotes')}</div>
            <div className="value" style={{ color: 'var(--aubergine)' }}>{total}</div>
          </div>
        </div>
      </div>

      {error && <p className="alert-box" role="alert">{error}</p>}
      {loaded && !error && !rows.length && (
        <div className="card"><p className="empty">{t('ღია გაცემული კურსი არ არის.', 'No quoted deal is still open.')}</p></div>
      )}
      <div className="stack-sm">
        {rows.map((r) => {
          const pill = progressPill(r, t);
          const rate = r.given_rate ?? r.rate;
          return (
            <article key={r.id} className="req-card">
              <div className="row-between" style={{ gap: 12 }}>
                <div>
                  <div className="name">{r.client_name ?? r.client_id}</div>
                  <div className="tiny muted">ID {r.client_id}{r.kam_name ? ' · ' + r.kam_name : ''}</div>
                  <div className="small" style={{ marginTop: 6 }}>{t('კლიენტი ყიდის', 'Client sells')} {sideAmount(r.sells_currency, r.amount)}</div>
                  <div className="small">{t('კლიენტი იღებს', 'Client gets')} {sideAmount(r.gets_currency, r.gets_amount)}</div>
                  {rate != null && <div className="small" style={{ marginTop: 6 }}>{t('სახაზინოს კურსი', 'Treasury rate')}: {fmtRate(rate)}</div>}
                  {r.client_rate != null && <div className="tiny muted">{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')}: {fmtRate(r.client_rate)}</div>}
                  {r.rate_valid_until && <div className="tiny muted">{t('მოქმედებს {time}-მდე', 'Valid until {time}', { time: fmtTime(r.rate_valid_until) })}</div>}
                  {r.note && <p className="note-box">{t('კომენტარი', 'Comment')}: {r.note}</p>}
                </div>
                <div className="actions">
                  <span className={'pill ' + pill.cls}>{pill.label}</span>
                  {realRole === 'admin' && <DeleteRequestButton requestId={r.id} onDeleted={reload} />}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {loaded && !error && hasMore && (
        <p className="empty">
          <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE)}>{t('მეტის ჩვენება', 'Show more')}</button>
          <span className="small muted" style={{ marginLeft: 12 }}>
            {t('ნაჩვენებია {shown} {total}-დან.', 'Showing {shown} of {total}.', { shown: rows.length, total })}
          </span>
        </p>
      )}
    </>
  );
}
