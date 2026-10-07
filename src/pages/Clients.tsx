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
          <h1>{mine ? 'ჩემი კლიენტები' : 'კლიენტები'}</h1>
          <p>{mine ? 'კლიენტები, რომლებსაც კურსი სთხოვეთ, ახლიდან ძველისკენ' : 'ყველა კლიენტი, ბოლო მოთხოვნიდან'}</p>
        </div>
      </div>
      <div className="field" style={{ maxWidth: 420 }}>
        <label htmlFor="client-search">ძებნა ID-ით ან სახელით</label>
        <input id="client-search" className="input" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} placeholder="დაიწყეთ აკრეფა" />
      </div>
      <section className="card flush" aria-label="კლიენტები" style={{ paddingTop: 8 }}>
        {!loading && !rows.length && <p className="empty">{q ? 'ვერ მოიძებნა.' : 'კლიენტები ჯერ არ არის.'}</p>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 640 }}>
              <thead><tr><th>კლიენტი</th><th>ID</th><th>ტიპი</th><th>ბოლო მოთხოვნა</th><th>ბოლო მიმართულება</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.client_id}>
                    <td className="strong">{r.name ?? <span className="muted">სახელი არ არის</span>}</td>
                    <td>{r.client_id}</td>
                    <td>{r.kind === 'company' ? 'კომპანია' : 'ფიზიკური პირი'}</td>
                    <td>{r.last_request_date ? fmtDay(r.last_request_date) : ''}</td>
                    <td>{r.last_sells_currency ? `${r.last_sells_currency} → ${r.last_gets_currency}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {rows.length === 20 && <p className="small muted" style={{ margin: 0 }}>ნაჩვენებია პირველი 20. უფრო ზუსტად აკრიფეთ.</p>}
    </>
  );
}
