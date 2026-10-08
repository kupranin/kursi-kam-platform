import { useCallback, useEffect, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useViewAs } from '../lib/viewAs';
import { useI18n } from '../lib/i18n';
import { useToast } from '../lib/toast';
import { fmtMinutes, fmtShort, fmtWhole, monthOptions } from '../lib/format';
import { readTransactionFile, TransactionFileError } from '../lib/transactionFile';

interface MonthRow {
  month: string;
  transactions: number;
  clients: number;
  turnover: number;
  turnover_not_successful: number;
  income: number;
}

interface ClientRow {
  client_id: string;
  name: string | null;
  turnover: number;
  income: number;
  transactions: number;
}

interface Kpis {
  transactions: number;
  clients: number;
  turnover: number;
  turnover_not_successful: number;
  income: number;
  successful: number;
  by_month: MonthRow[];
  top_clients: ClientRow[];
}

interface DeskTimes {
  requests: number;
  answered: number;
  waiting_answer: number;
  first_response_minutes: number | null;
  agreed: number;
  written: number;
  waiting_write: number;
  write_minutes: number | null;
}

const EMPTY_TIMES: DeskTimes = {
  requests: 0, answered: 0, waiting_answer: 0, first_response_minutes: null,
  agreed: 0, written: 0, waiting_write: 0, write_minutes: null,
};

function asTimes(raw: DeskTimes | null): DeskTimes {
  if (!raw) return EMPTY_TIMES;
  const n = (v: number | string | null) => (v == null || v === '' ? null : Number(v));
  const c = (v: number | string | null) => Number(v ?? 0);
  return {
    requests: c(raw.requests),
    answered: c(raw.answered),
    waiting_answer: c(raw.waiting_answer),
    first_response_minutes: n(raw.first_response_minutes),
    agreed: c(raw.agreed),
    written: c(raw.written),
    waiting_write: c(raw.waiting_write),
    write_minutes: n(raw.write_minutes),
  };
}

const EMPTY: Kpis = {
  transactions: 0, clients: 0, turnover: 0, turnover_not_successful: 0, income: 0, successful: 0,
  by_month: [], top_clients: [],
};

function monthEnd(start: string): string {
  const [y, m] = start.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0));
  return last.toISOString().slice(0, 10);
}

function monthLabel(start: string): string {
  return new Date(start + 'T00:00:00Z').toLocaleDateString('ka-GE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

interface ImportResult {
  upserted: number;
  skipped: number;
  clients_added: number;
  run_id: number | null;
  matched: number;
  ambiguous: number;
}

function uploadCount(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function uploadError(err: unknown, t: (ka: string, en: string) => string): string {
  if (err instanceof TransactionFileError && err.code === 'no-amount') {
    return t(
      'ამ ფაილში ლარის თანხა ვერ მოიძებნა (abs_gel ან cross_gel), ამიტომ არ ჩაიტვირთა.',
      'This file has no lari amount (abs_gel or cross_gel), so it was not loaded.',
    );
  }
  if (err instanceof TransactionFileError && err.code === 'range-too-wide') {
    return t(
      'ფურცლის დიაპაზონი ძალიან დიდია (სვეტები XFD-მდე მიდის). შეინახეთ მხოლოდ რეალური სვეტები და სცადეთ თავიდან.',
      'The sheet’s used range is too large (columns run out to XFD). Save only the real columns and try again.',
    );
  }
  if (err instanceof RangeError) {
    return t(
      'ფაილი ზედმეტად დიდია და ვერ წაიკითხა. ფურცლის დიაპაზონი XFD-მდე არ უნდა მიდიოდეს.',
      'This file is too large to read. The sheet range must not run out to column XFD.',
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/could not find the function/i.test(message) && /import_transactions/i.test(message)) {
    return t(
      'ჯერ ჩასვით SQL ფაილი 17_amount_match, შემდეგ სცადეთ თავიდან.',
      'Paste SQL file 17_amount_match first, then try again.',
    );
  }
  return message;
}

export default function Analytics() {
  const { role } = useViewAs();
  const { t } = useI18n();
  const toast = useToast();
  const isAdmin = role === 'admin';
  const seeTransactions = role === 'admin' || role === 'manager';
  const [month, setMonth] = useState('all');
  const [months, setMonths] = useState<MonthRow[]>([]);
  const [kpis, setKpis] = useState<Kpis>(EMPTY);
  const [times, setTimes] = useState<DeskTimes>(EMPTY_TIMES);
  const [timesError, setTimesError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState('');

  const load = useCallback(async (which: string) => {
    setLoading(true);
    setError('');
    setTimesError('');
    const args = which === 'all' ? {} : { p_from: which, p_to: monthEnd(which) };
    try {
      const data = await rpc<DeskTimes>('analytics_response_times', args);
      setTimes(asTimes(data));
    } catch (err) {
      setTimes(EMPTY_TIMES);
      setTimesError((err as Error).message);
    }
    if (seeTransactions) {
      try {
        const data = await rpc<Kpis>('analytics_kpis', args);
        setKpis(data ?? EMPTY);
        if (which === 'all') setMonths(data?.by_month ?? []);
      } catch (err) {
        setError((err as Error).message);
      }
    }
    setLoading(false);
  }, [seeTransactions]);

  useEffect(() => { load(month); }, [load, month]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setProgress(t('ფაილი იკითხება…', 'Reading the file…'));
    try {
      let saved = 0;
      let skippedRows = 0;
      let clientsAdded = 0;
      let sentSoFar = 0;
      let runId: number | null = null;
      const { skipped, sent, mode, missing } = await readTransactionFile(file, async (batch, batchMode) => {
        sentSoFar += batch.length;
        setProgress(t('ინახება {n}…', 'Saving {n}…', { n: sentSoFar.toLocaleString('en-US') }));
        const result = await rpc<ImportResult>(
          'import_transactions',
          batchMode === 'amount'
            ? { p_rows: batch, p_run: runId, p_finish: false }
            : { p_rows: batch },
        );
        saved += uploadCount(result.upserted);
        skippedRows += uploadCount(result.skipped);
        clientsAdded += uploadCount(result.clients_added);
        if (result.run_id != null) runId = uploadCount(result.run_id);
      });
      skippedRows += skipped;
      let matched = 0;
      let ambiguous = 0;
      if (mode === 'amount' && sent) {
        if (runId == null) {
          throw new Error(t(
            'ატვირთვა მოთხოვნას ვერ დაემთხვა. ჯერ ჩასვით SQL ფაილი 17_amount_match, შემდეგ სცადეთ თავიდან.',
            'The upload could not match requests. Paste SQL file 17_amount_match first, then try again.',
          ));
        }
        setProgress(t('მოთხოვნებს ემთხვევა…', 'Matching requests…'));
        const done = await rpc<ImportResult>('import_transactions', { p_rows: [], p_run: runId, p_finish: true });
        matched = uploadCount(done.matched);
        ambiguous = uploadCount(done.ambiguous);
      }
      if (!sent) {
        const gaps: string[] = [];
        const gapsEn: string[] = [];
        if (missing.date) {
          gaps.push('თარიღი (created date ან created at)');
          gapsEn.push('a date (created date or created at)');
        }
        if (missing.client) {
          gaps.push('sender id');
          gapsEn.push('sender id');
        }
        if (missing.amount) {
          gaps.push('ლარის თანხა (abs_gel ან cross_gel)');
          gapsEn.push('a lari amount (abs_gel or cross_gel)');
        }
        if (missing.status) {
          gaps.push('payment status');
          gapsEn.push('payment status');
        }
        toast(gaps.length
          ? t(
            'ტრანზაქცია ვერ მოიძებნა. ფაილში აკლია: {what}.',
            'No transactions found. The file is missing: {what}.',
            { what: t(gaps.join(', '), gapsEn.join(', ')) },
          )
          : t('ტრანზაქცია ვერ მოიძებნა.', 'No transactions found.'), 'error');
        return;
      }
      const savedText = saved.toLocaleString('en-US');
      const parts = [
        t('შეინახა {n} ტრანზაქცია', 'Saved {n} transactions', { n: savedText })
          + (clientsAdded
            ? t(', {n} ახალი კლიენტი', ', {n} new clients', { n: clientsAdded.toLocaleString('en-US') })
            : ''),
      ];
      if (mode === 'amount') {
        parts.push(t(
          'მოთხოვნას დაემთხვა {n}.',
          'Matched {n} to a request.',
          { n: matched.toLocaleString('en-US') },
        ));
        if (ambiguous) {
          parts.push(t(
            '{n} არ მიება, რადგან ეს თანხა ერთ მოთხოვნაზე ზუსტად არ ჯდება.',
            '{n} were not attached, because that amount does not fit exactly one request.',
            { n: ambiguous.toLocaleString('en-US') },
          ));
        }
      }
      if (skippedRows) {
        parts.push(t('გამოტოვებულია {n} სტრიქონი.', 'Skipped {n} rows.', { n: skippedRows.toLocaleString('en-US') }));
      }
      toast(parts.join(' '));
      if (month === 'all') await load('all');
      else setMonth('all');
    } catch (err) {
      toast(uploadError(err, t), 'error');
    } finally {
      setUploading(false);
      setProgress('');
    }
  }

  const turnover = Number(kpis.turnover);
  const failed = Number(kpis.turnover_not_successful);
  const income = Number(kpis.income);
  const failedShare = turnover > 0 ? Math.round((failed / turnover) * 100) : 0;
  const perMillion = turnover > 0 ? Math.round((income / turnover) * 1_000_000) : null;
  const label = month === 'all' ? 'ყველა ატვირთული ტრანზაქცია' : monthLabel(month);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('ანალიტიკა', 'Analytics')}</h1>
          <p>{seeTransactions
            ? 'ბრუნვა და შემოსავალი, ტრანზაქციების ფაილიდან. ქვემოთ სახაზინოს დროცაა.'
            : t('სახაზინოს პასუხისა და კურსის გაწერის დრო.', 'How long treasury takes to answer, and to write the rate.')}</p>
        </div>
        <div className="row">
          <label className="sr-only" htmlFor="analytics-month">პერიოდი</label>
          <select id="analytics-month" className="select" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="all">{t('მთელი პერიოდი', 'Whole period')}</option>
            {seeTransactions
              ? [...months].reverse().map((m) => <option key={m.month} value={m.month}>{monthLabel(m.month)}</option>)
              : monthOptions(18).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
      </div>

      <section className="card" aria-labelledby="times-title">
        <h2 id="times-title">{t('სახაზინოს დრო', 'Treasury time')}</h2>
        <p className="small" style={{ margin: '6px 0 16px', color: 'var(--ink-2)' }}>
          {t(
            'პირველი პასუხი: KAM-ის მოთხოვნიდან სახაზინოს პირველ პასუხამდე. კურსის გაწერა: კლიენტის დათანხმებიდან იმ მომენტამდე, როცა სახაზინო კურსს გაწერილად მონიშნავს. თუ ჯერ არ არის გაწერილი, ეს დრო ცარიელია. ძველი ფაილის სტრიქონები აქ არ შედის.',
            'First response: from the KAM placing the request until treasury’s first answer. Rate writing: from the client agreeing until treasury marks the rate as written. If it is not written yet, that time stays empty. Rows from the old file are not included.',
          )}
        </p>
        {timesError && <p className="alert-box" role="alert">{timesError}</p>}
        {!timesError && (
          <div className="stats">
            <div className="stat">
              <div className="label">{t('პირველი პასუხი', 'First response')}</div>
              <div className="value">{times.answered ? fmtMinutes(times.first_response_minutes) : '—'}</div>
              <div className="small muted">{t('საშუალო. პასუხი აქვს', 'Average. Answered')} {fmtWhole(times.answered)} / {fmtWhole(times.requests)}. {t('ელოდება', 'Waiting')} {fmtWhole(times.waiting_answer)}.</div>
            </div>
            <div className="stat">
              <div className="label">{t('კურსის გაწერა', 'Rate writing')}</div>
              <div className="value">{times.written ? fmtMinutes(times.write_minutes) : '—'}</div>
              <div className="small muted">{t('საშუალო. გაწერილია', 'Average. Written')} {fmtWhole(times.written)} / {fmtWhole(times.agreed)}. {t('ელოდება გაწერას', 'Waiting to be written')} {fmtWhole(times.waiting_write)}.</div>
            </div>
          </div>
        )}
      </section>

      {seeTransactions && isAdmin && (
        <section className="card" aria-labelledby="upload-title">
          <h2 id="upload-title">ტრანზაქციების ატვირთვა</h2>
          <p className="small" style={{ margin: '6px 0 16px', color: 'var(--ink-2)' }}>
            {t(
              'Excel ან CSV. სტრიქონი მოთხოვნას ემთხვევა: იგივე კლიენტი (sender id), იგივე დღე, იგივე ვალუტები (currency და currency to send) და ზუსტად იგივე ლარის თანხა (abs_gel, ან cross_gel თუ არც ერთი მხარე ლარი არ არის). თუ ფაილში არის Create time, მოთხოვნის დროც უნდა ემთხვეოდეს იმავე წუთს (თბილისის დრო). წამები არ ითვლება. თუ დრო არ არის, საკმარისია იგივე დღე. თუ ეს ერთ მოთხოვნაზე ზუსტად არ ჯდება, სტრიქონი არ მიება. იგივე დღეების ხელახალი ატვირთვა იმ დღეებს ცვლის, რომ ორჯერ არ დაითვალოს. თარიღი: created at ან created date. დრო: create time. ასევე payment status. total_income საკომისიოა და აუცილებელი არ არის.',
              'Excel or CSV. A row matches a request when the client (sender id), the day, the currencies (currency and currency to send), and the lari amount (abs_gel, or cross_gel when neither side is lari) are the same. If the file has a Create time, the request must be the same minute, in Tbilisi. Seconds are not required. If there is no time, the day is enough. If that does not fit exactly one request, the row is not attached. Uploading those days again replaces them, so they are not counted twice. Date: created at or created date. Time: create time. Also payment status. total_income is the fee and is not required.',
            )}
          </p>
          <label className={'btn btn-primary' + (uploading ? ' disabled' : '')}>
            {uploading ? progress || 'იტვირთება…' : 'ფაილის არჩევა'}
            <input
              type="file"
              accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              disabled={uploading}
              style={{ display: 'none' }}
              onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }}
            />
          </label>
        </section>
      )}

      {seeTransactions && error && <p className="alert-box" role="alert">{error}</p>}

      {seeTransactions && <div className="stats big">
        <div className="stat"><div className="label">ტრანზაქციები</div><div className="value">{fmtWhole(kpis.transactions)}</div></div>
        <div className="stat"><div className="label">კლიენტები</div><div className="value">{fmtWhole(kpis.clients)}</div></div>
        <div className="stat"><div className="label">ბრუნვა</div><div className="value">GEL {fmtShort(turnover)}</div></div>
        <div className="stat"><div className="label">შემოსავალი</div><div className="value">GEL {fmtWhole(income)}</div></div>
        <div className="stat">
          <div className="label">არ გავიდა</div>
          <div className="value" style={{ color: failedShare > 0 ? 'var(--alert)' : undefined }}>{failedShare}%</div>
          <div className="small muted">GEL {fmtShort(failed)}</div>
        </div>
        <div className="stat"><div className="label">შემოსავალი GEL 1 მლნ-ზე</div><div className="value">{perMillion == null ? '—' : fmtWhole(perMillion)}</div></div>
      </div>}

      {seeTransactions && <section className="card flush" aria-labelledby="months-title">
        <div className="card-head">
          <h2 id="months-title">{label}</h2>
        </div>
        {loading && <p className="empty">იტვირთება…</p>}
        {!loading && !kpis.by_month.length && <p className="empty">ამ პერიოდში ტრანზაქცია ჯერ არ არის. ადმინს შეუძლია Excel-ის ატვირთვა ზემოთ.</p>}
        {!loading && kpis.by_month.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>თვე</th><th className="num">ტრანზაქციები</th><th className="num">კლიენტები</th>
                  <th className="num">ბრუნვა</th><th className="num">არ გავიდა</th><th className="num">შემოსავალი</th>
                </tr>
              </thead>
              <tbody>
                {kpis.by_month.map((m) => (
                  <tr key={m.month}>
                    <th scope="row">{monthLabel(m.month)}</th>
                    <td className="num">{fmtWhole(m.transactions)}</td>
                    <td className="num">{fmtWhole(m.clients)}</td>
                    <td className="num">{fmtShort(m.turnover)}</td>
                    <td className="num">{fmtShort(m.turnover_not_successful)}</td>
                    <td className="num">{fmtWhole(m.income)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>}

      {seeTransactions && <section className="card flush" aria-labelledby="top-title">
        <div className="card-head">
          <h2 id="top-title">უდიდესი კლიენტები</h2>
          <p className="small muted">{label}</p>
        </div>
        {!loading && !kpis.top_clients.length && <p className="empty">ამ პერიოდში კლიენტი არ არის.</p>}
        {kpis.top_clients.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>კლიენტი</th><th>ID</th><th className="num">ტრანზაქციები</th><th className="num">ბრუნვა</th><th className="num">შემოსავალი</th>
                </tr>
              </thead>
              <tbody>
                {kpis.top_clients.map((c) => (
                  <tr key={c.client_id}>
                    <th scope="row">{c.name || <span className="muted">სახელი არ არის</span>}</th>
                    <td>{c.client_id}</td>
                    <td className="num">{fmtWhole(c.transactions)}</td>
                    <td className="num">{fmtShort(c.turnover)}</td>
                    <td className="num">{fmtWhole(c.income)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>}
    </>
  );
}
