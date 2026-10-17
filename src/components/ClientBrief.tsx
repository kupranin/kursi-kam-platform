import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { fmtAmount, fmtDay } from '../lib/format';
import {
  maySetOwnerOverride,
  ownerDisplayText,
  ownerSourceCaption,
  type EffectiveOwner,
} from '../lib/clientOwnership';
import { loadEffectiveOwners, type OwnerLoad } from '../lib/clientOwners';
import {
  loadClientBrief,
  loadClientHistory,
  type ClientBriefData,
  type ClientHistoryRow,
} from '../lib/requestKpis';
import { supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { useViewAs } from '../lib/viewAs';
import LoadingLine from './LoadingLine';

const PAGE = 20;

interface KamOption {
  id: string;
  full_name: string;
}

function absText(
  amount: number | null,
  status: string | null,
  t: (ka: string, en: string) => string,
): string {
  if (status === 'calculated' && amount != null) return fmtAmount(amount);
  if (status === 'missing_amount') return t('თანხა არ არის', 'No amount');
  if (status === 'unsupported_currency') return t('ვალუტა არ არის', 'Currency not supported');
  if (status === 'missing_rate') return t('კურსი არ არის', 'No rate');
  return '—';
}

export default function ClientBrief({ clientId }: { clientId: string }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const { role, realRole } = useViewAs();
  const canAssign = maySetOwnerOverride(realRole, role);
  const [brief, setBrief] = useState<ClientBriefData | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ClientHistoryRow[]>([]);
  const [more, setMore] = useState(false);
  const [histLoading, setHistLoading] = useState(false);
  const [histFailed, setHistFailed] = useState(false);
  const [ownerLoad, setOwnerLoad] = useState<OwnerLoad | null>(null);
  const [kams, setKams] = useState<KamOption[]>([]);
  const [overrideId, setOverrideId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  function reloadOwner() {
    return loadEffectiveOwners([clientId]).then(setOwnerLoad).catch(() => setOwnerLoad({ status: 'failed' }));
  }

  useEffect(() => {
    let gone = false;
    setLoading(true);
    setFailed(false);
    setBrief(null);
    setOpen(false);
    setRows([]);
    setMore(false);
    setOwnerLoad(null);
    loadClientBrief(clientId)
      .then((next) => { if (!gone) setBrief(next); })
      .catch(() => { if (!gone) setFailed(true); })
      .finally(() => { if (!gone) setLoading(false); });
    loadEffectiveOwners([clientId])
      .then((result) => { if (!gone) setOwnerLoad(result); })
      .catch(() => { if (!gone) setOwnerLoad({ status: 'failed' }); });
    return () => { gone = true; };
  }, [clientId]);

  useEffect(() => {
    if (!canAssign) return;
    let gone = false;
    supabase.from('profiles').select('id, full_name').eq('role', 'kam').order('full_name')
      .then(({ data }) => {
        if (gone) return;
        setKams((data ?? []) as KamOption[]);
      });
    supabase.from('clients').select('assigned_kam_id').eq('client_id', clientId).maybeSingle()
      .then(({ data }) => {
        if (gone) return;
        const id = (data?.assigned_kam_id as string | null) ?? null;
        setOverrideId(id);
        setDraft(id ?? '');
      });
    return () => { gone = true; };
  }, [canAssign, clientId]);

  async function showHistory(offset: number) {
    setHistLoading(true);
    setHistFailed(false);
    try {
      const page = await loadClientHistory(clientId, offset);
      const extra = page.length > PAGE;
      const slice = extra ? page.slice(0, PAGE) : page;
      setRows(offset === 0 ? slice : [...rows, ...slice]);
      setMore(extra);
      setOpen(true);
    } catch {
      setHistFailed(true);
    } finally {
      setHistLoading(false);
    }
  }

  function classLabel(code: string): string {
    if (code === 'won') return t('მოგებული', 'Won');
    if (code === 'lost') return t('დაკარგული', 'Lost');
    return t('ღია', 'Open');
  }

  const readyOwner: EffectiveOwner | null = ownerLoad?.status === 'ok'
    ? (ownerLoad.owners.get(clientId) ?? [...ownerLoad.owners.values()][0] ?? null)
    : null;

  function ownerLine(): { text: string; caption: string } {
    if (ownerLoad?.status === 'failed') return { text: ownerDisplayText('missing', null, lang), caption: '' };
    if (readyOwner) {
      return {
        text: ownerDisplayText(readyOwner.state, readyOwner.ownerName, lang),
        caption: ownerSourceCaption(readyOwner.source, lang),
      };
    }
    if (ownerLoad?.status === 'missing' && brief) {
      return { text: ownerDisplayText(brief.assignedKamState, brief.assignedKamName, lang), caption: '' };
    }
    return { text: '', caption: '' };
  }

  const shown = ownerLine();
  const options = overrideId && !kams.some((kam) => kam.id === overrideId)
    ? [{ id: overrideId, full_name: readyOwner?.source === 'override' ? (readyOwner.ownerName || overrideId) : overrideId }, ...kams]
    : kams;

  async function saveOverride(next: string | null) {
    setSaving(true);
    const { data, error } = await supabase
      .from('clients')
      .update({ assigned_kam_id: next })
      .eq('client_id', clientId)
      .select('assigned_kam_id');
    setSaving(false);
    if (error || !data?.length) {
      toast(error?.message || t('შენახვა არ მოხერხდა.', 'The save did not go through.'), 'error');
      return;
    }
    toast(t('კლიენტის მფლობელი შეინახა.', 'Client owner saved.'));
    setOverrideId(next);
    setDraft(next ?? '');
    await Promise.all([
      reloadOwner(),
      loadClientBrief(clientId).then(setBrief).catch(() => setFailed(true)),
    ]);
  }

  function ownerBlock() {
    if (!shown.text && !canAssign) return null;
    return (
      <>
        {shown.text && (
          <p className="small" style={{ margin: '0 0 8px' }}>
            {t('კლიენტის მფლობელი', 'Client owner')}
            {': '}
            {shown.text}
            {shown.caption ? <span className="tiny muted" style={{ display: 'block' }}>{shown.caption}</span> : null}
          </p>
        )}
        {canAssign && (
          <form
            className="row"
            style={{ gap: 8, margin: '0 0 8px', alignItems: 'end', flexWrap: 'wrap' }}
            onSubmit={(event) => { event.preventDefault(); void saveOverride(draft || null); }}
          >
            <div className="field" style={{ margin: 0, minWidth: 220 }}>
              <label htmlFor={'owner-override-' + clientId}>{t('მფლობელის გადაფარვა', 'Owner override')}</label>
              <select id={'owner-override-' + clientId} className="select" value={draft} onChange={(event) => setDraft(event.target.value)}>
                <option value="">{t('გადაფარვა არ არის', 'No override')}</option>
                {options.map((kam) => <option key={kam.id} value={kam.id}>{kam.full_name}</option>)}
              </select>
            </div>
            <button type="submit" className="btn" disabled={saving}>{saving ? t('ინახება…', 'Saving…') : t('შენახვა', 'Save')}</button>
            <button type="button" className="btn" disabled={saving || !overrideId} onClick={() => void saveOverride(null)}>
              {t('გადაფარვის მოხსნა', 'Clear the override')}
            </button>
            <p className="tiny muted" style={{ flex: '1 1 240px', margin: 0 }}>
              {t(
                'მხოლოდ ადმინი ცვლის გადაფარვას. მოხსნა დათვლილ მფლობელს აბრუნებს. მოთხოვნის KAM არ იცვლება.',
                'Only an admin changes the override. Clearing it restores the counted owner. The request KAM does not change.',
              )}
            </p>
          </form>
        )}
      </>
    );
  }

  return (
    <div className="card" style={{ flex: '1 1 100%', marginTop: 8, padding: 14 }}>
      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>{t('კლიენტის შეჯამება', 'Client summary')}</h3>
      {loading && <LoadingLine />}
      {!loading && failed && (
        <p className="small" style={{ margin: 0 }}>{t('შეჯამება ვერ ჩაიტვირთა.', 'The summary could not be loaded.')}</p>
      )}
      {!loading && !failed && brief?.status === 'invalid_id' && (
        <p className="small" style={{ margin: 0 }}>{t('შეჯამება ვერ ჩაიტვირთა.', 'The summary could not be loaded.')}</p>
      )}
      {!loading && !failed && brief?.status === 'new_client' && (
        <>
          <p className="small" style={{ margin: '0 0 8px' }}>
            {brief.clientName?.trim() || t('სახელი არ არის', 'No name')}
            {' · ID '}
            {brief.clientId}
          </p>
          {ownerBlock()}
          <p className="small" style={{ margin: 0 }}>
            {t('ახალი კლიენტია. მოთხოვნის ისტორია არ არის.', 'New client. There is no request history.')}
          </p>
        </>
      )}
      {!loading && !failed && brief?.status === 'ok' && (
        <>
          <p className="small" style={{ margin: '0 0 8px' }}>
            {brief.clientName?.trim() || t('სახელი არ არის', 'No name')}
            {' · ID '}
            {brief.clientId}
          </p>
          {ownerBlock()}
          <p className="small" style={{ margin: '0 0 8px' }}>
            {t('სულ', 'Total')} {brief.total}
            {' · '}
            {t('მოგებული', 'Won')} {brief.won}
            {' · '}
            {t('დაკარგული', 'Lost')} {brief.lost}
            {' · '}
            {t('ღია', 'Open')} {brief.open}
            {brief.lastRequestDate ? ` · ${t('ბოლო მოთხოვნა', 'Last request')} ${fmtDay(brief.lastRequestDate)}` : ''}
          </p>
          {brief.lossWarning === 'last_three' && (
            <p className="small" style={{ margin: '0 0 8px', background: 'var(--warn-bg)', color: 'var(--warn)', padding: '8px 10px', borderRadius: 8 }}>
              <strong>{t('ბოლო 3 გარიგება არ შედგა', 'The last 3 deals did not go through')}</strong>
              {brief.lossReasons.length > 0 && ` — ${brief.lossReasons.map((reason) => reason || t('მიზეზი არ არის', 'No reason')).join('; ')}`}
            </p>
          )}
          {brief.lossWarning === 'last_lost' && (
            <p className="small" style={{ margin: '0 0 8px', background: 'var(--warn-bg)', color: 'var(--warn)', padding: '8px 10px', borderRadius: 8 }}>
              <strong>{t('ბოლო გარიგება არ შედგა', 'The last deal did not go through')}</strong>
              {` — ${brief.lossReasons[0] || t('მიზეზი არ არის', 'No reason')}`}
            </p>
          )}
          {brief.inactive && brief.inactiveDays != null && (
            <p className="small" style={{ margin: '0 0 8px', background: 'var(--warn-bg)', color: 'var(--warn)', padding: '8px 10px', borderRadius: 8 }}>
              <strong>{t('კლიენტს 30 დღეზე მეტია მოთხოვნა არ დაუფიქსირებია', 'No request has been recorded for this client for more than 30 days')}</strong>
              {` — ${brief.inactiveDays} ${t('დღე', 'days')}`}
            </p>
          )}
          <button type="button" className="btn" onClick={() => { if (open) setOpen(false); else void showHistory(0); }}>
            {t('ყველა მოთხოვნის ნახვა', 'See every request')}
          </button>
          {histFailed && <p className="small" style={{ margin: '8px 0 0' }}>{t('სია ვერ ჩაიტვირთა.', 'The list could not be loaded.')}</p>}
          {histLoading && <LoadingLine />}
          {open && !histLoading && rows.length === 0 && !histFailed && (
            <p className="empty">{t('მოთხოვნა არ არის.', 'No request.')}</p>
          )}
          {open && rows.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table className="table" style={{ minWidth: 720 }}>
                <thead>
                  <tr>
                    <th>{t('თარიღი', 'Date')}</th>
                    <th>{t('წყვილი', 'Pair')}</th>
                    <th className="num">{t('მიღებული თანხა', 'Received amount')}</th>
                    <th className="num">ABS GEL</th>
                    <th>{t('სტატუსი', 'Status')}</th>
                    <th>{t('მიზეზი', 'Reason')}</th>
                    <th>{t('კლიენტის მფლობელი', 'Client owner')}</th>
                    <th>{t('მოთხოვნის KAM', 'Request KAM')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="nowrap">
                        <Link to={'/requests/' + row.id}>{fmtDay(row.requestDate)}</Link>
                      </td>
                      <td className="nowrap">{row.sellsCurrency} → {row.getsCurrency}</td>
                      <td className="num">{row.receivedAmount != null ? `${fmtAmount(row.receivedAmount)} ${row.getsCurrency ?? ''}` : '—'}</td>
                      <td className="num">{absText(row.requestAbsGel, row.valuationStatus, t)}</td>
                      <td>{classLabel(row.kpiClass)}</td>
                      <td>{row.kpiClass === 'lost' ? (row.lossReason || t('მიზეზი არ არის', 'No reason')) : ''}</td>
                      <td>
                        {shown.text}
                        {shown.caption ? <div className="tiny muted">{shown.caption}</div> : null}
                      </td>
                      <td>{row.kamName || t('KAM არ არის', 'No KAM')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {open && more && (
            <button type="button" className="btn" style={{ marginTop: 8 }} disabled={histLoading} onClick={() => void showHistory(rows.length)}>
              {t('კიდევ', 'More')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
