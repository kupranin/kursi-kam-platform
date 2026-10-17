import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import LoadingLine from '../../components/LoadingLine';
import { fmtDateTime, sideAmount } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { rpc } from '../../lib/supabase';
import { useToast } from '../../lib/toast';

interface PendingAbs {
  request_id: number;
  requested_at: string;
  client_id: string;
  client_name: string | null;
  kam_name: string | null;
  sells_currency: string | null;
  gets_currency: string | null;
  amount: number | null;
  gets_amount: number | null;
  reason: string | null;
}

function reasonText(code: string | null, t: (ka: string, en: string) => string): string {
  if (code === 'missing_gets_gel') return t('მიღებული ლარის თანხა არ არის', 'The lari amount received is missing');
  if (code === 'no_board_rate') return t('დაფაზე ამ ვალუტის ლარის კურსი არ არის', 'The board has no lari rate for this currency');
  if (code === 'cannot_derive') return t('მიღებული თანხა არ არის და ჯვარედინი კურსიდან ვერ გამოითვლება', 'The received amount is missing and cannot be derived from a cross');
  if (code === 'rounds_to_zero') return t('ლარის თანხა ნულამდე მრგვალდება', 'The lari amount rounds to zero');
  return t('ლარის თანხა ვერ გამოითვალა', 'The lari amount could not be calculated');
}

export default function AbsGelPanel() {
  const { t } = useI18n();
  const toast = useToast();
  const [rows, setRows] = useState<PendingAbs[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const [correctId, setCorrectId] = useState('');
  const [correctAmt, setCorrectAmt] = useState('');
  const [correcting, setCorrecting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await rpc<PendingAbs[]>('pending_abs_gel_queue');
      setRows(data ?? []);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
    setLoaded(true);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(requestId: number, raw: string): Promise<boolean> {
    const parsed = Number(raw.trim().replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast(t('ჩაწერეთ დადებითი ლარი', 'Enter a positive amount in GEL'), 'error');
      return false;
    }
    setSaving(requestId);
    try {
      await rpc('set_request_abs_gel', { p_request_id: requestId, p_amount: parsed });
      toast(t('ლარი ჩაიწერა.', 'The lari amount is saved.'));
      setDrafts((cur) => {
        const next = { ...cur };
        delete next[requestId];
        return next;
      });
      await load();
      return true;
    } catch (err) {
      toast((err as Error).message, 'error');
      return false;
    } finally {
      setSaving(null);
    }
  }

  async function correct(e: FormEvent) {
    e.preventDefault();
    const requestId = Number(correctId.trim());
    if (!Number.isInteger(requestId) || requestId <= 0) {
      toast(t('ჩაწერეთ მოთხოვნის ნომერი', 'Enter the request number'), 'error');
      return;
    }
    setCorrecting(true);
    try {
      const saved = await save(requestId, correctAmt);
      if (saved) {
        setCorrectId('');
        setCorrectAmt('');
      }
    } finally {
      setCorrecting(false);
    }
  }

  return (
    <section id="abs-gel" className="card" aria-labelledby="abs-gel-title">
      <h2 id="abs-gel-title">{t('ABS GEL ელოდება', 'ABS GEL waiting')}</h2>
      <p className="small" style={{ margin: '6px 0 16px', color: 'var(--ink-2)' }}>
        {t(
          'ახალ მოთხოვნას, რომელსაც ლარის თანხა ვერ გამოუვიდა. ჩაწერეთ დადებითი ლარი. ძველ მოთხოვნებს ეს სია არ ეხება.',
          'A new request whose lari amount could not be calculated. Enter a positive amount in GEL. Older requests are not in this list.',
        )}
      </p>
      {error && <p className="alert-box" role="alert">{error}</p>}
      {!loaded && !error && <LoadingLine />}
      {loaded && !error && rows.length === 0 && (
        <p className="empty">{t('მოთხოვნა არ ელოდება.', 'Nothing is waiting.')}</p>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 880 }}>
            <thead>
              <tr>
                <th>{t('მოთხოვნა', 'Request')}</th>
                <th>{t('კლიენტი', 'Client')}</th>
                <th>KAM</th>
                <th>{t('წყვილი', 'Pair')}</th>
                <th>{t('თანხები', 'Amounts')}</th>
                <th>{t('მიზეზი', 'Reason')}</th>
                <th>{t('ლარი', 'GEL')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.request_id}>
                  <td>
                    <Link to={'/log#request-' + row.request_id}>{t('მოთხოვნა {id}', 'Request {id}', { id: row.request_id })}</Link>
                    <div className="tiny muted">{fmtDateTime(row.requested_at)}</div>
                  </td>
                  <td>
                    <div className="strong">{row.client_name ?? row.client_id}</div>
                    <div className="tiny muted">{row.client_id}</div>
                  </td>
                  <td>{row.kam_name ?? '—'}</td>
                  <td className="nowrap">{row.sells_currency} → {row.gets_currency}</td>
                  <td>
                    <div>{t('ყიდის', 'Sells')} {sideAmount(row.sells_currency, row.amount)}</div>
                    <div>{t('იღებს', 'Gets')} {sideAmount(row.gets_currency, row.gets_amount)}</div>
                  </td>
                  <td>{reasonText(row.reason, t)}</td>
                  <td>
                    <form
                      className="row"
                      style={{ gap: 8, alignItems: 'center' }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void save(row.request_id, drafts[row.request_id] ?? '');
                      }}
                    >
                      <label className="sr-only" htmlFor={'abs-gel-' + row.request_id}>
                        {t('ლარი მოთხოვნაზე {id}', 'GEL for request {id}', { id: row.request_id })}
                      </label>
                      <input
                        id={'abs-gel-' + row.request_id}
                        className="input"
                        style={{ width: 120 }}
                        inputMode="decimal"
                        autoComplete="off"
                        value={drafts[row.request_id] ?? ''}
                        onChange={(e) => setDrafts((cur) => ({ ...cur, [row.request_id]: e.target.value }))}
                      />
                      <button type="submit" className="btn btn-primary" disabled={saving === row.request_id}>
                        {saving === row.request_id ? t('ინახება', 'Saving') : t('შენახვა', 'Save')}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={correct} style={{ marginTop: 18 }}>
        <h3 style={{ fontSize: 18, margin: '0 0 8px' }}>{t('ხელით ჩასწორება', 'Correct a manual amount')}</h3>
        <p className="small" style={{ margin: '0 0 10px', color: 'var(--ink-2)' }}>
          {t(
            'უკვე ხელით ჩაწერილი ლარის შეცვლა. დაფის ან კურსის ციფრს ეს არ ცვლის.',
            'Change a lari amount that was entered by hand. This does not replace a board or quote figure.',
          )}
        </p>
        <div className="row" style={{ gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="abs-correct-id">{t('მოთხოვნის ნომერი', 'Request number')}</label>
            <input id="abs-correct-id" className="input" style={{ width: 140 }} inputMode="numeric" autoComplete="off" value={correctId} onChange={(e) => setCorrectId(e.target.value)} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="abs-correct-amt">{t('ლარი', 'GEL')}</label>
            <input id="abs-correct-amt" className="input" style={{ width: 140 }} inputMode="decimal" autoComplete="off" value={correctAmt} onChange={(e) => setCorrectAmt(e.target.value)} />
          </div>
          <button type="submit" className="btn" disabled={correcting}>
            {correcting ? t('ინახება', 'Saving') : t('ჩასწორება', 'Correct')}
          </button>
        </div>
      </form>
    </section>
  );
}
