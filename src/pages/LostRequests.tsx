import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { useLive } from '../lib/useLive';
import { fmtDay, sideAmount } from '../lib/format';
import { treasuryReason } from '../lib/requestStatus';
import type { LossReason, RequestRow } from '../lib/types';
import DeleteRequestButton from '../components/DeleteRequestButton';
import LossApproval from '../components/LossApproval';

const PAGE = 100;

const DECLINE_REASONS: { value: string; label: string }[] = [
  { value: 'Amount too large', label: 'თანხა ძალიან დიდია' },
  { value: 'Market moving too fast', label: 'ბაზარი ძალიან სწრაფად იცვლება' },
  { value: 'Need more details', label: 'მეტი დეტალია საჭირო' },
];

function declineLabel(reason: string, lang: 'ka' | 'en'): string {
  return treasuryReason(reason, lang) || DECLINE_REASONS.find((r) => r.value === reason)?.label || reason;
}

function reasonLabel(reasons: LossReason[], code: string, lang: 'ka' | 'en'): string {
  const reason = reasons.find((x) => x.code === code);
  if (!reason) return code;
  return (lang === 'en' ? reason.label_en : reason.label_ka).trim() || reason.label_en || reason.label_ka;
}

function stillOpenLoss(row: RequestRow): boolean {
  return row.loss_open === true
    && !row.went_through
    && !row.rate_written_at
    && !row.payment_confirmed_at;
}

/** Every app loss treasury or an admin still has to approve. */
export default function LostRequests() {
  const { t, lang } = useI18n();
  const { realRole } = useViewAs();
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [reasons, setReasons] = useState<LossReason[]>([]);
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
      const [{ data, error: err, count }, reasonRes] = await Promise.all([
        supabase
          .from('request_outcomes')
          .select('*', { count: 'exact' })
          .eq('loss_open', true)
          .order('request_date', { ascending: false })
          .order('id', { ascending: false })
          .range(0, shown - 1),
        supabase.from('loss_reasons').select('*').eq('active', true).order('sort_order'),
      ]);
      if (!gone) setReasons((reasonRes.data ?? []) as LossReason[]);
      if (gone) return;
      if (err) {
        setRows([]);
        setTotal(0);
        setHasMore(false);
        setError(t('სია ჯერ არ იტვირთება.', 'This list is not loading yet.'));
      } else {
        const page = ((data ?? []) as RequestRow[]).filter(stillOpenLoss);
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
          <h1>{t('დაკარგული მოთხოვნები', 'Lost requests')}</h1>
          <p>{t(
            'დაადასტურეთ თითო დანაკარგი. კომენტარი შეგიძლიათ ჩაწეროთ, ან დატოვოთ ცარიელი. გაწერილი კურსი და „ტრანზაქცია გავიდა“ აქ არ ჩანს.',
            'Approve each loss. You can write a comment, or leave it empty. A written rate and “The transaction went through” do not appear here.',
          )}</p>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="label">{t('დასადასტურებელი', 'To approve')}</div>
            <div className="value" style={{ color: 'var(--aubergine)' }}>{total}</div>
          </div>
        </div>
      </div>

      {error && <p className="alert-box" role="alert">{error}</p>}
      {loaded && !error && !rows.length && (
        <div className="card"><p className="empty">{t('დასადასტურებელი დანაკარგი არ არის.', 'No loss is waiting for approval.')}</p></div>
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
                {r.loss_reason && (
                  <p className="note-box">
                    {t('KAM-ის მიზეზი', 'KAM reason')}: {reasonLabel(reasons, r.loss_reason, lang)}
                    {r.loss_reason_note ? ` — ${r.loss_reason_note}` : ''}
                  </p>
                )}
                {r.client_reply === 'declined' && r.client_decline_reason && (
                  <p className="note-box">{t('კლიენტმა უარი თქვა', 'Client declined')}: {r.client_decline_reason}</p>
                )}
                {r.quote_status === 'declined' && r.decline_reason && (
                  <p className="note-box">{t('სახაზინომ უარი თქვა', 'Treasury declined')}: {declineLabel(r.decline_reason, lang)}</p>
                )}
              </div>
              {realRole === 'admin' && <DeleteRequestButton requestId={r.id} onDeleted={reload} />}
            </div>
            <LossApproval row={r} onDone={reload} />
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
