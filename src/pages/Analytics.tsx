import { useCallback, useEffect, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { fmtShort, fmtWhole } from '../lib/format';
import { readTransactionFile, type UploadRow } from '../lib/transactionFile';

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
  return new Date(start + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export default function Analytics() {
  const { profile } = useAuth();
  const toast = useToast();
  const isAdmin = profile!.role === 'admin';
  const [month, setMonth] = useState('all');
  const [months, setMonths] = useState<MonthRow[]>([]);
  const [kpis, setKpis] = useState<Kpis>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState('');

  const load = useCallback(async (which: string) => {
    setLoading(true);
    setError('');
    try {
      const args = which === 'all' ? {} : { p_from: which, p_to: monthEnd(which) };
      const data = await rpc<Kpis>('analytics_kpis', args);
      setKpis(data ?? EMPTY);
      if (which === 'all') setMonths(data?.by_month ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(month); }, [load, month]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setProgress('Reading the file…');
    try {
      const { rows, skipped } = await readTransactionFile(file);
      if (!rows.length) {
        toast('No transactions found. The file needs a transaction id, a date, a sender id, a payment status, abs_gel and total_income.', 'error');
        return;
      }
      let saved = 0;
      let skippedRows = skipped;
      let clientsAdded = 0;
      const size = 500;
      for (let i = 0; i < rows.length; i += size) {
        const batch: UploadRow[] = rows.slice(i, i + size);
        setProgress(`Saving ${Math.min(i + size, rows.length).toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')}…`);
        const result = await rpc<{ upserted: number; skipped: number; clients_added: number }>('import_transactions', { p_rows: batch });
        saved += result.upserted;
        skippedRows += result.skipped;
        clientsAdded += result.clients_added;
      }
      toast(`Saved ${saved.toLocaleString('en-US')} transactions` + (clientsAdded ? `, ${clientsAdded.toLocaleString('en-US')} new clients` : '') + (skippedRows ? `. Skipped ${skippedRows.toLocaleString('en-US')} rows.` : '.'));
      if (month === 'all') await load('all');
      else setMonth('all');
    } catch (err) {
      toast((err as Error).message, 'error');
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
  const label = month === 'all' ? 'All uploaded transactions' : monthLabel(month);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>Turnover and income, counted from the transaction file</p>
        </div>
        <div className="row">
          <label className="sr-only" htmlFor="analytics-month">Period</label>
          <select id="analytics-month" className="select" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="all">All time</option>
            {[...months].reverse().map((m) => <option key={m.month} value={m.month}>{monthLabel(m.month)}</option>)}
          </select>
        </div>
      </div>

      {isAdmin && (
        <section className="card" aria-labelledby="upload-title">
          <h2 id="upload-title">Upload transactions</h2>
          <p className="small" style={{ margin: '6px 0 16px', color: 'var(--ink-2)' }}>
            Excel or CSV, with the columns from the business transactions export: transaction id, created at, sender id, payment status, abs_gel and total_income. Uploading the same file again updates those rows.
          </p>
          <label className={'btn btn-primary' + (uploading ? ' disabled' : '')}>
            {uploading ? progress || 'Uploading…' : 'Choose a file'}
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

      {error && <p className="alert-box" role="alert">{error}</p>}

      <div className="stats big">
        <div className="stat"><div className="label">Transactions</div><div className="value">{fmtWhole(kpis.transactions)}</div></div>
        <div className="stat"><div className="label">Clients</div><div className="value">{fmtWhole(kpis.clients)}</div></div>
        <div className="stat"><div className="label">Turnover</div><div className="value">GEL {fmtShort(turnover)}</div></div>
        <div className="stat"><div className="label">Income</div><div className="value">GEL {fmtWhole(income)}</div></div>
        <div className="stat">
          <div className="label">Didn't go through</div>
          <div className="value" style={{ color: failedShare > 0 ? 'var(--alert)' : undefined }}>{failedShare}%</div>
          <div className="small muted">GEL {fmtShort(failed)}</div>
        </div>
        <div className="stat"><div className="label">Income per GEL 1M</div><div className="value">{perMillion == null ? '—' : fmtWhole(perMillion)}</div></div>
      </div>

      <section className="card flush" aria-labelledby="months-title">
        <div className="card-head">
          <h2 id="months-title">{label}</h2>
        </div>
        {loading && <p className="empty">Loading…</p>}
        {!loading && !kpis.by_month.length && <p className="empty">No transactions in this period yet. An admin can upload the Excel above.</p>}
        {!loading && kpis.by_month.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>Month</th><th className="num">Transactions</th><th className="num">Clients</th>
                  <th className="num">Turnover</th><th className="num">Didn't go through</th><th className="num">Income</th>
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
      </section>

      <section className="card flush" aria-labelledby="top-title">
        <div className="card-head">
          <h2 id="top-title">Largest clients</h2>
          <p className="small muted">{label}</p>
        </div>
        {!loading && !kpis.top_clients.length && <p className="empty">No clients in this period.</p>}
        {kpis.top_clients.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>Client</th><th>ID</th><th className="num">Transactions</th><th className="num">Turnover</th><th className="num">Income</th>
                </tr>
              </thead>
              <tbody>
                {kpis.top_clients.map((c) => (
                  <tr key={c.client_id}>
                    <th scope="row">{c.name || <span className="muted">No name on file</span>}</th>
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
      </section>
    </>
  );
}
