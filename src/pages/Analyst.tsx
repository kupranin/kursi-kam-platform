import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useI18n } from '../lib/i18n';
import { useToast } from '../lib/toast';
import { downloadCsv, fmtAmount, fmtMinutes, fmtRate, monthOptions, todayTbilisi } from '../lib/format';

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
  status: Status;
  loss_reason: string | null;
  first_response_minutes: number | null;
  rate_write_minutes: number | null;
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

function asDeal(row: Deal): Deal {
  return {
    ...row,
    sell_amount: num(row.sell_amount),
    gets_amount: num(row.gets_amount),
    rate: num(row.rate),
    amount_gel: num(row.amount_gel),
    first_response_minutes: num(row.first_response_minutes),
    rate_write_minutes: num(row.rate_write_minutes),
  };
}

export default function Analyst() {
  const { t } = useI18n();
  const toast = useToast();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [month, setMonth] = useState('all');
  const [rows, setRows] = useState<Deal[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
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
  }, [status, from, to]);

  function statusText(value: Status): string {
    if (value === 'success') return t('წარმატებული', 'Success');
    if (value === 'lost') return t('დაკარგული', 'Lost');
    return t('ღია', 'Open');
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
          r.client_name,
          r.client_id,
          r.sells_currency,
          r.sell_amount,
          r.gets_currency,
          r.gets_amount,
          r.rate,
          r.amount_gel,
          statusText(r.status),
          r.status === 'lost' ? r.loss_reason : '',
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
          'ლარი ითვლება, როცა ერთი მხარე GEL-ია. კურსი არის ლარი ერთ უცხოურ ერთეულზე. ჩამოტვირთვა იღებს ამ ფილტრის ყველა სტრიქონს.',
          'Lari is calculated when one side is GEL. The rate is lari per 1 foreign unit. Download includes every row in this filter.',
        )}
      </p>

      {error && <p className="alert-box" role="alert">{error}</p>}

      <section className="card flush" aria-label={t('მოთხოვნების ანალიზი', 'Request analysis')}>
        {!loaded && <p className="empty">{t('იტვირთება…', 'Loading…')}</p>}
        {loaded && !error && !rows.length && <p className="empty">{t('ამ ფილტრში მოთხოვნა არ არის.', 'No requests in this filter.')}</p>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 1280 }}>
              <thead>
                <tr>
                  <th>{t('თარიღი', 'Date')}</th>
                  <th className="num">{t('პირველი პასუხი', 'First response')}</th>
                  <th className="num">{t('კურსის გაწერა', 'Rate writing')}</th>
                  <th>KAM</th>
                  <th>{t('კლიენტი', 'Client')}</th>
                  <th>{t('ყიდის', 'Sells')}</th>
                  <th className="num">{t('მოთხოვნილი თანხა', 'Amount asked')}</th>
                  <th>{t('იღებს', 'Gets')}</th>
                  <th className="num">{t('მისაღები თანხა', 'Amount to receive')}</th>
                  <th className="num">{t('კურსი', 'Rate')}</th>
                  <th className="num">{t('თანხა GEL', 'Amount GEL')}</th>
                  <th>{t('სტატუსი', 'Status')}</th>
                  <th>{t('მიზეზი', 'Reason')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{r.request_date}</td>
                    <td className="num">{fmtMinutes(r.first_response_minutes)}</td>
                    <td className="num">{fmtMinutes(r.rate_write_minutes)}</td>
                    <td>{r.kam_name}</td>
                    <td>
                      <div className="strong">{r.client_name ?? r.client_id}</div>
                      <div className="tiny muted">ID {r.client_id}</div>
                    </td>
                    <td>{r.sells_currency}</td>
                    <td className="num">{fmtAmount(r.sell_amount)}</td>
                    <td>{r.gets_currency}</td>
                    <td className="num">{fmtAmount(r.gets_amount)}</td>
                    <td className="num">{r.rate != null ? fmtRate(r.rate) : ''}</td>
                    <td className="num">{fmtAmount(r.amount_gel)}</td>
                    <td>
                      <span className={'pill ' + (r.status === 'success' ? 'pill-ok' : r.status === 'lost' ? 'pill-alert' : 'pill-wait')}>
                        {statusText(r.status)}
                      </span>
                    </td>
                    <td>{r.status === 'lost' ? r.loss_reason : ''}</td>
                  </tr>
                ))}
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
