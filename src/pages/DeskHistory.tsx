import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { useLive } from '../lib/useLive';
import { fmtDateTime, fmtDay, fmtRate, sideAmount } from '../lib/format';
import { isWrittenHistory } from '../lib/requestStatus';
import type { RequestRow } from '../lib/types';
import DeleteRequestButton from '../components/DeleteRequestButton';

const PAGE = 100;

/** Deals whose quoted rate was written in the core. They leave the rate desk. */
export default function DeskHistory() {
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
        .not('rate_written_at', 'is', null)
        .order('rate_written_at', { ascending: false })
        .order('id', { ascending: false })
        .range(0, shown - 1);
      if (gone) return;
      if (err) {
        setRows([]);
        setTotal(0);
        setHasMore(false);
        setError(t('სია ჯერ არ იტვირთება.', 'This list is not loading yet.'));
      } else {
        const page = ((data ?? []) as RequestRow[]).filter(isWrittenHistory);
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
          <h1>{t('ისტორია', 'History')}</h1>
          <p>{t(
            'კურსი გაცემულია და ძირითად სისტემაში ჩაწერილია. ეს გარიგებები კურსის მაგიდიდან გადმოდის.',
            'The rate was quoted and written in the core system. These deals have left the rate desk.',
          )}</p>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="label">{t('გაწერილი', 'Written')}</div>
            <div className="value">{total}</div>
          </div>
        </div>
      </div>

      {error && <p className="alert-box" role="alert">{error}</p>}
      {loaded && !error && !rows.length && (
        <div className="card"><p className="empty">{t('გაწერილი კურსი ჯერ არ არის.', 'No written rate yet.')}</p></div>
      )}
      <div className="stack-sm">
        {rows.map((r) => (
          <article key={r.id} className="req-card">
            <div className="row-between" style={{ gap: 12 }}>
              <div>
                <div className="name">{r.client_name ?? r.client_id}</div>
                <div className="tiny muted">{fmtDay(r.request_date)} · ID {r.client_id}{r.kam_name ? ' · ' + r.kam_name : ''}</div>
                <div className="small" style={{ marginTop: 6 }}>{t('კლიენტი ყიდის', 'Client sells')} {sideAmount(r.sells_currency, r.amount)}</div>
                <div className="small">{t('კლიენტი იღებს', 'Client gets')} {sideAmount(r.gets_currency, r.gets_amount)}</div>
                {r.approved_rate != null && <div className="small" style={{ marginTop: 6 }}>{t('გაწერილი კურსი', 'Written rate')} {fmtRate(r.approved_rate)}</div>}
                {r.rate != null && r.approved_rate !== r.rate && (
                  <div className="tiny muted">{t('სახაზინოს კურსი', 'Treasury rate')}: {fmtRate(r.rate)}</div>
                )}
                {r.rate_written_at && <div className="tiny muted">{t('ჩაიწერა {when}', 'Written {when}', { when: fmtDateTime(r.rate_written_at) })}</div>}
              </div>
              <div className="actions">
                <span className="pill pill-ok">{t('კურსი გაწერილია', 'Rate is written')}</span>
                {realRole === 'admin' && <DeleteRequestButton requestId={r.id} onDeleted={reload} />}
              </div>
            </div>
          </article>
        ))}
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
