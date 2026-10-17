import { useCallback, useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { useLive } from '../lib/useLive';
import { fmtDateTime, fmtRate, sideAmount } from '../lib/format';
import { applyRatePeople, loadRatePeople } from '../lib/ratePeople';
import { classifyRequest, isWrittenHistory, lossReasonLabel, treasuryReason, type LogCode } from '../lib/requestStatus';
import type { RequestRow } from '../lib/types';
import DeleteRequestButton, { canDeleteRequest } from '../components/DeleteRequestButton';
import LoadingLine from '../components/LoadingLine';
import RatePeople from '../components/RatePeople';

export default function RequestLog() {
  const location = useLocation();
  const { profile } = useAuth();
  const { role, realRole } = useViewAs();
  const { t, lang } = useI18n();
  const mine = role === 'kam';
  const showDelete = realRole === 'admin' || realRole === 'kam';
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | LogCode>('all');

  const load = useCallback(async () => {
    let q = supabase
      .from('request_outcomes')
      .select('id, kam_id, kam_name, client_id, client_name, sells_currency, gets_currency, amount, gets_amount, rate, approved_rate, quote_status, quote_state, decline_reason, client_reply, client_decline_reason, better_decision, requested_at, rate_valid_until, rate_written_at, outcome, went_through, source, loss_open, loss_reason, loss_approved_at')
      .eq('source', 'app')
      .order('requested_at', { ascending: false })
      .limit(300);
    if (mine) q = q.eq('kam_id', profile!.id);
    const { data, error: err } = await q;
    if (err) setError(err.message);
    else {
      const list = (data ?? []) as RequestRow[];
      setRows(applyRatePeople(list, await loadRatePeople(list.map((row) => row.id))));
      setError('');
    }
    setLoaded(true);
  }, [mine, profile]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!loaded || !location.hash.startsWith('#request-')) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
  }, [loaded, location.hash, rows.length]);
  useLive(['requests'], load, 30000);

  function label(code: LogCode): string {
    if (code === 'agreed') return t('შეთანხმებულია', 'Agreed');
    if (code === 'client_declined') return t('კლიენტმა უარი თქვა', 'Declined by client');
    if (code === 'treasury_declined') return t('ხაზინამ უარი თქვა', 'Declined by treasury');
    if (code === 'waiting_treasury') return t('ხაზინას ელოდება', 'Waiting on treasury');
    if (code === 'waiting_kam') return t('KAM-ს ელოდება', 'Waiting on KAM');
    if (code === 'expired') return t('კურსს ვადა გაუვიდა', 'Rate expired');
    if (code === 'went_through') return t('გავიდა', 'Went through');
    if (code === 'did_not') return t('არ გავიდა', 'Did not go through');
    return t('ღიაა', 'Open');
  }

  const prepared = rows.map((row) => ({ row, status: classifyRequest(row) }));
  const shown = prepared.filter((item) => filter === 'all' || item.status.code === filter);
  const choices: { id: 'all' | LogCode; label: string }[] = [
    { id: 'all', label: t('ყველა', 'All') },
    { id: 'agreed', label: t('შეთანხმებულია', 'Agreed') },
    { id: 'client_declined', label: t('კლიენტმა უარი თქვა', 'Declined by client') },
    { id: 'treasury_declined', label: t('ხაზინამ უარი თქვა', 'Declined by treasury') },
    { id: 'waiting_treasury', label: t('ხაზინას ელოდება', 'Waiting on treasury') },
    { id: 'waiting_kam', label: t('KAM-ს ელოდება', 'Waiting on KAM') },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('მოთხოვნების ჟურნალი', 'Request log')}</h1>
          <p>{mine
            ? t('თქვენი მოთხოვნები და მათი სტატუსი.', 'Your requests and their status.')
            : t('ყველა მოთხოვნა და მიმდინარე სტატუსი.', 'Every request and its current status.')}</p>
        </div>
      </div>
      <div className="chips">
        {choices.map((c) => (
          <button key={c.id} type="button" className="chip" aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}>{c.label}</button>
        ))}
      </div>
      {error && <p className="alert-box" role="alert">{error}</p>}
      <section className="card flush" aria-label={t('მოთხოვნების ჟურნალი', 'Request log')}>
        {!loaded && <LoadingLine />}
        {loaded && !error && !shown.length && <p className="empty">{t('ამ ხედში მოთხოვნა არ არის.', 'No requests in this view.')}</p>}
        {shown.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 880 }}>
              <thead>
                <tr>
                  <th>{t('დრო', 'Time')}</th>
                  <th>{t('კლიენტი', 'Client')}</th>
                  {!mine && <th>KAM</th>}
                  <th>{t('წყვილი', 'Pair')}</th>
                  <th>{t('თანხები', 'Amounts')}</th>
                  <th className="num">{t('კურსი', 'Rate')}</th>
                  <th>{t('სტატუსი', 'Status')}</th>
                  {showDelete && <th>{t('წაშლა', 'Delete')}</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map(({ row, status }) => {
                  const rate = row.client_reply === 'approved' && row.approved_rate != null ? row.approved_rate : row.rate;
                  const reason = status.code === 'treasury_declined'
                    ? treasuryReason(status.reason, lang)
                    : status.code === 'did_not'
                      ? lossReasonLabel(status.reason, lang)
                      : (status.reason ?? '');
                  return (
                    <tr key={row.id} id={'request-' + row.id}>
                      <td className="nowrap">{fmtDateTime(row.requested_at)}</td>
                      <td>
                        <div className="strong">{row.client_name ?? row.client_id}</div>
                        <div className="tiny muted">ID {row.client_id}</div>
                      </td>
                      {!mine && <td>{row.kam_name}</td>}
                      <td className="nowrap">{row.sells_currency} → {row.gets_currency}</td>
                      <td>
                        <div>{t('ყიდის', 'Sells')} {sideAmount(row.sells_currency, row.amount)}</div>
                        <div>{t('იღებს', 'Gets')} {sideAmount(row.gets_currency, row.gets_amount)}</div>
                      </td>
                      <td className="num strong">
                        {rate != null ? fmtRate(rate) : ''}
                        <RatePeople quoted={row.quoted_by_name} written={row.written_by_name} />
                      </td>
                      <td>
                        <div>{label(status.code)}</div>
                        {reason && <div className="tiny muted">{reason}</div>}
                      </td>
                      {showDelete && (
                        <td>
                          {canDeleteRequest(realRole, profile?.id, row.kam_id) && !isWrittenHistory(row) && (
                            <DeleteRequestButton requestId={row.id} onDeleted={load} />
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
