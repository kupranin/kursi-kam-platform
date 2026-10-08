import { useCallback, useEffect, useState } from 'react';
import { rpc, supabase } from '../lib/supabase';
import { useI18n } from '../lib/i18n';
import { useToast } from '../lib/toast';
import { useViewAs } from '../lib/viewAs';
import { downloadCsv, fmtAmount, fmtMinutes, fmtRate, monthOptions, parseRate, todayTbilisi } from '../lib/format';

type Status = 'success' | 'lost' | 'open';
type StatusFilter = 'all' | Status;

interface Deal {
  id: number;
  request_date: string;
  kam_name: string | null;
  client_id: string;
  client_name: string | null;
  sells_currency: string | null;
  sell_amount: number | null;
  gets_currency: string | null;
  gets_amount: number | null;
  rate: number | null;
  amount_gel: number | null;
  gel_amount: number | null;
  status: Status;
  loss_reason: string | null;
  first_response_minutes: number | null;
  rate_write_minutes: number | null;
  quoted_by_name: string | null;
}

const PAGE = 100;

function monthEnd(start: string): string {
  const [y, m] = start.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0));
  return last.toISOString().slice(0, 10);
}

function num(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function draftText(value: number | null): string {
  return value == null ? '' : String(value);
}

interface Draft {
  sell: string;
  gets: string;
  rate: string;
  gel: string;
  gelTouched: boolean;
}

function asDeal(row: Deal): Deal {
  return {
    ...row,
    sell_amount: num(row.sell_amount),
    gets_amount: num(row.gets_amount),
    rate: num(row.rate),
    amount_gel: num(row.amount_gel),
    gel_amount: num(row.gel_amount),
    first_response_minutes: num(row.first_response_minutes),
    rate_write_minutes: num(row.rate_write_minutes),
  };
}

export default function Analyst() {
  const { t } = useI18n();
  const toast = useToast();
  const { role, realRole } = useViewAs();
  const canEdit = realRole === 'admin' && role === 'admin';
  const [status, setStatus] = useState<StatusFilter>('all');
  const [month, setMonth] = useState('all');
  const [rows, setRows] = useState<Deal[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>({ sell: '', gets: '', rate: '', gel: '', gelTouched: false });
  const [tried, setTried] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const months = monthOptions(18);

  const from = month === 'all' ? null : month;
  const to = month === 'all' ? null : monthEnd(month);

  const load = useCallback(async (append: boolean) => {
    const start = append ? rows.length : 0;
    let q = supabase.from('analyst_deals').select('*').order('request_date', { ascending: false }).order('id', { ascending: false });
    if (status !== 'all') q = q.eq('status', status);
    if (from) q = q.gte('request_date', from);
    if (to) q = q.lte('request_date', to);
    const { data, error: err } = await q.range(start, start + PAGE - 1);
    if (err) {
      if (!append) setRows([]);
      setError(err.message);
      setMore(false);
    } else {
      const page = ((data ?? []) as Deal[]).map(asDeal);
      setRows(append ? [...rows, ...page] : page);
      setMore(page.length === PAGE);
      setError('');
    }
    setLoaded(true);
  }, [status, from, to, rows]);

  useEffect(() => {
    let gone = false;
    (async () => {
      let q = supabase.from('analyst_deals').select('*').order('request_date', { ascending: false }).order('id', { ascending: false });
      if (status !== 'all') q = q.eq('status', status);
      if (from) q = q.gte('request_date', from);
      if (to) q = q.lte('request_date', to);
      const { data, error: err } = await q.range(0, PAGE - 1);
      if (gone) return;
      if (err) {
        setRows([]);
        setError(err.message);
        setMore(false);
      } else {
        const page = ((data ?? []) as Deal[]).map(asDeal);
        setRows(page);
        setMore(page.length === PAGE);
        setError('');
      }
      setLoaded(true);
    })();
    return () => { gone = true; };
  }, [status, from, to, reloadKey]);

  function statusText(value: Status): string {
    if (value === 'success') return t('წარმატებული', 'Success');
    if (value === 'lost') return t('დაკარგული', 'Lost');
    return t('ღია', 'Open');
  }

  function startEdit(r: Deal) {
    setTried(false);
    setEditing(r.id);
    setDraft({
      sell: draftText(r.sell_amount),
      gets: draftText(r.gets_amount),
      rate: r.rate != null ? fmtRate(r.rate) : '',
      gel: draftText(r.amount_gel),
      gelTouched: false,
    });
  }

  async function saveRow(r: Deal) {
    const sell = parseRate(draft.sell);
    const gets = parseRate(draft.gets);
    const rate = parseRate(draft.rate);
    const gel = parseRate(draft.gel);
    if (!sell.ok || !gets.ok || !rate.ok || !gel.ok) {
      setTried(true);
      toast(t('ჩაწერეთ დადებითი რიცხვი, ან დატოვეთ ცარიელი.', 'Enter a positive number, or leave the field empty.'), 'error');
      return;
    }
    const gelAmount = draft.gelTouched ? gel.value : (r.gel_amount != null ? r.gel_amount : null);
    setSavingId(r.id);
    try {
      await rpc('admin_correct_request', {
        p_request_id: r.id,
        p_sell_amount: sell.value,
        p_gets_amount: gets.value,
        p_rate: rate.value,
        p_gel_amount: gelAmount,
      });
      setEditing(null);
      setReloadKey((n) => n + 1);
      toast(t('შენახულია.', 'Saved.'));
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSavingId(null);
    }
  }

  async function download() {
    setDownloading(true);
    try {
      const all: Deal[] = [];
      for (let start = 0; ; start += 1000) {
        let q = supabase.from('analyst_deals').select('*').order('request_date', { ascending: false }).order('id', { ascending: false });
        if (status !== 'all') q = q.eq('status', status);
        if (from) q = q.gte('request_date', from);
        if (to) q = q.lte('request_date', to);
        const { data, error: err } = await q.range(start, start + 999);
        if (err) throw err;
        const page = ((data ?? []) as Deal[]).map(asDeal);
        all.push(...page);
        if (page.length < 1000) break;
      }
      if (!all.length) {
        toast(t('ამ ფილტრში მოთხოვნა არ არის.', 'No requests in this filter.'), 'error');
        return;
      }
      const headers = [
        t('თარიღი', 'Date'),
        t('პირველი პასუხი (წუთი)', 'First response (minutes)'),
        t('კურსის გაწერა (წუთი)', 'Rate writing (minutes)'),
        'KAM',
        t('კლიენტი', 'Client'),
        'ID',
        t('ყიდის', 'Sells'),
        t('მოთხოვნილი თანხა', 'Amount asked'),
        t('იღებს', 'Gets'),
        t('მისაღები თანხა', 'Amount to receive'),
        t('კურსი', 'Rate'),
        t('კურსი გასცა', 'Quoted by'),
        t('თანხა GEL', 'Amount GEL'),
        t('სტატუსი', 'Status'),
        t('მიზეზი', 'Reason'),
      ];
      downloadCsv(`kursi-requests-${todayTbilisi()}.csv`, [
        headers,
        ...all.map((r) => [
          r.request_date,
          r.first_response_minutes,
          r.rate_write_minutes,
          r.kam_name,
          r.client_name ?? '',
          r.client_id,
          r.sells_currency,
          r.sell_amount,
          r.gets_currency,
          r.gets_amount,
          r.rate,
          r.quoted_by_name ?? '',
          r.amount_gel,
          statusText(r.status),
          r.loss_reason ?? '',
        ]),
      ]);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setDownloading(false);
    }
  }

  const chips: { id: StatusFilter; label: string }[] = [
    { id: 'all', label: t('ყველა', 'All') },
    { id: 'success', label: t('წარმატებული', 'Success') },
    { id: 'lost', label: t('დაკარგული', 'Lost') },
    { id: 'open', label: t('ღია', 'Open') },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('მოთხოვნების ანალიზი', 'Request analysis')}</h1>
          <p>{t(
            'ყველა მოთხოვნა: თანხები, კურსი, ლარში გადაყვანა, შედეგი და მიზეზი. თარიღი ყოველ სტრიქონზეა.',
            'Every request: amounts, rate, lari value, result, and reason. Each row has its date.',
          )}</p>
        </div>
        <div className="row">
          <label className="sr-only" htmlFor="analysis-month">{t('თვე', 'Month')}</label>
          <select id="analysis-month" className="select" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="all">{t('ყველა თვე', 'All months')}</option>
            {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button type="button" className="btn" onClick={download} disabled={downloading}>
            {downloading ? t('იწერება…', 'Preparing…') : t('ჩამოტვირთვა', 'Download')}
          </button>
        </div>
      </div>

      <div className="chips">
        {chips.map((c) => (
          <button key={c.id} type="button" className="chip" aria-pressed={status === c.id} onClick={() => setStatus(c.id)}>{c.label}</button>
        ))}
      </div>

      <p className="small" style={{ color: 'var(--ink-2)', marginTop: 8 }}>
        {t(
          'GEL თანხა, როცა შევსებულია, ლარის ციფრია. რუბლზე 1-ზე ნაკლები კურსი ლარია ერთ რუბლზე. რუბლის კურსი 1 ან მეტი ლარი არ არის, ამიტომ ლარი ცარიელი რჩება. ჩამოტვირთვა იღებს ამ ფილტრის ყველა სტრიქონს.',
          'When the GEL amount is filled, that is the lari figure. A ruble rate below 1 is lari per 1 ruble. A ruble rate of 1 or more is not a lari rate, so the lari figure stays empty. Download includes every row in this filter.',
        )}
        {canEdit && <> {t('ადმინს შეუძლია კურსის და თანხების გასწორება.', 'An admin can correct the rate and the amounts.')}</>}
      </p>

      {error && <p className="alert-box" role="alert">{error}</p>}

      <section className="card flush" aria-label={t('მოთხოვნების ანალიზი', 'Request analysis')}>
        {!loaded && <p className="empty">{t('იტვირთება…', 'Loading…')}</p>}
        {loaded && !error && !rows.length && <p className="empty">{t('ამ ფილტრში მოთხოვნა არ არის.', 'No requests in this filter.')}</p>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: canEdit ? 1760 : 1520 }}>
              <thead>
                <tr>
                  <th>{t('თარიღი', 'Date')}</th>
                  <th className="num">{t('პირველი პასუხი', 'First response')}</th>
                  <th className="num">{t('კურსის გაწერა', 'Rate writing')}</th>
                  <th>KAM</th>
                  <th>{t('კლიენტი', 'Client')}</th>
                  <th>ID</th>
                  <th>{t('ყიდის', 'Sells')}</th>
                  <th className="num">{t('მოთხოვნილი თანხა', 'Amount asked')}</th>
                  <th>{t('იღებს', 'Gets')}</th>
                  <th className="num">{t('მისაღები თანხა', 'Amount to receive')}</th>
                  <th className="num">{t('კურსი', 'Rate')}</th>
                  <th>{t('კურსი გასცა', 'Quoted by')}</th>
                  <th className="num">{t('თანხა GEL', 'Amount GEL')}</th>
                  <th>{t('სტატუსი', 'Status')}</th>
                  <th>{t('მიზეზი', 'Reason')}</th>
                  {canEdit && <th>{t('შესწორება', 'Edit')}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const open = canEdit && editing === r.id;
                  const sellP = open ? parseRate(draft.sell) : null;
                  const getsP = open ? parseRate(draft.gets) : null;
                  const rateP = open ? parseRate(draft.rate) : null;
                  const gelP = open ? parseRate(draft.gel) : null;
                  return (
                  <tr key={r.id}>
                    <td className="nowrap">{r.request_date}</td>
                    <td className="num">{fmtMinutes(r.first_response_minutes)}</td>
                    <td className="num">{fmtMinutes(r.rate_write_minutes)}</td>
                    <td>{r.kam_name}</td>
                    <td className="strong">{r.client_name ?? <span className="muted">{t('სახელი არ არის', 'No name')}</span>}</td>
                    <td className="nowrap">{r.client_id}</td>
                    <td>{r.sells_currency}</td>
                    <td className="num">
                      {open ? (
                        <input className={'input cell' + (tried && sellP && !sellP.ok ? ' invalid' : '')} inputMode="decimal" aria-label={t('მოთხოვნილი თანხა', 'Amount asked')} value={draft.sell} onChange={(e) => setDraft({ ...draft, sell: e.target.value })} />
                      ) : fmtAmount(r.sell_amount)}
                    </td>
                    <td>{r.gets_currency}</td>
                    <td className="num">
                      {open ? (
                        <input className={'input cell' + (tried && getsP && !getsP.ok ? ' invalid' : '')} inputMode="decimal" aria-label={t('მისაღები თანხა', 'Amount to receive')} value={draft.gets} onChange={(e) => setDraft({ ...draft, gets: e.target.value })} />
                      ) : fmtAmount(r.gets_amount)}
                    </td>
                    <td className="num">
                      {open ? (
                        <input className={'input cell' + (tried && rateP && !rateP.ok ? ' invalid' : '')} inputMode="decimal" aria-label={t('კურსი', 'Rate')} value={draft.rate} onChange={(e) => setDraft({ ...draft, rate: e.target.value })} />
                      ) : (r.rate != null ? fmtRate(r.rate) : '')}
                    </td>
                    <td>{r.quoted_by_name ?? ''}</td>
                    <td className="num">
                      {open ? (
                        <input className={'input cell' + (tried && gelP && !gelP.ok ? ' invalid' : '')} inputMode="decimal" aria-label={t('თანხა GEL', 'Amount GEL')} value={draft.gel} onChange={(e) => setDraft({ ...draft, gel: e.target.value, gelTouched: true })} />
                      ) : fmtAmount(r.amount_gel)}
                    </td>
                    <td>
                      <span className={'pill ' + (r.status === 'success' ? 'pill-ok' : r.status === 'lost' ? 'pill-alert' : 'pill-wait')}>
                        {statusText(r.status)}
                      </span>
                    </td>
                    <td>{r.loss_reason ?? ''}</td>
                    {canEdit && (
                      <td className="nowrap">
                        {open ? (
                          <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                            <button type="button" className="btn btn-primary" disabled={savingId === r.id} onClick={() => saveRow(r)}>
                              {savingId === r.id ? t('ინახება…', 'Saving…') : t('შენახვა', 'Save')}
                            </button>
                            <button type="button" className="btn" disabled={savingId === r.id} onClick={() => setEditing(null)}>{t('გაუქმება', 'Cancel')}</button>
                          </div>
                        ) : (
                          <button type="button" className="btn" onClick={() => startEdit(r)}>{t('შესწორება', 'Edit')}</button>
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
        {more && (
          <div style={{ padding: 16 }}>
            <button type="button" className="btn" onClick={() => load(true)}>{t('მეტის ჩვენება', 'Show more')}</button>
          </div>
        )}
      </section>
    </>
  );
}
