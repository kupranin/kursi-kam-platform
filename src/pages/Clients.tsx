import { useEffect, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { fmtDay } from '../lib/format';
import type { ClientMatch } from '../lib/types';

export default function Clients() {
  const { profile } = useAuth();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<ClientMatch[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        const list = await rpc<ClientMatch[]>('search_my_clients', { p_query: q.trim(), p_limit: 20 });
        if (alive) setRows(list ?? []);
      } finally {
        if (alive) setLoading(false);
      }
    }, 200);
    return () => { alive = false; window.clearTimeout(t); };
  }, [q]);

  const mine = profile!.role === 'kam';
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{mine ? 'My clients' : 'Clients'}</h1>
          <p>{mine ? 'Clients you have asked rates for, newest first' : 'All clients, newest request first'}</p>
        </div>
      </div>
      <div className="field" style={{ maxWidth: 420 }}>
        <label htmlFor="client-search">Search by ID or name</label>
        <input id="client-search" className="input" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Start typing" />
      </div>
      <section className="card flush" aria-label="Clients" style={{ paddingTop: 8 }}>
        {!loading && !rows.length && <p className="empty">{q ? 'No match.' : 'No clients yet.'}</p>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 640 }}>
              <thead><tr><th>Client</th><th>ID</th><th>Type</th><th>Last request</th><th>Last deal direction</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.client_id}>
                    <td className="strong">{r.name ?? <span className="muted">No name on file</span>}</td>
                    <td>{r.client_id}</td>
                    <td>{r.kind === 'company' ? 'Company' : 'Person'}</td>
                    <td>{r.last_request_date ? fmtDay(r.last_request_date) : ''}</td>
                    <td>{r.last_sells_currency ? `${r.last_sells_currency} to ${r.last_gets_currency}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {rows.length === 20 && <p className="small muted" style={{ margin: 0 }}>Showing the first 20. Type more to narrow it down.</p>}
    </>
  );
}
