import { useEffect, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
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

  const { t } = useI18n();
  const mine = profile!.role === 'kam';
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{mine ? t('ჩემი კლიენტები', 'My clients') : t('კლიენტები', 'Clients')}</h1>
          <p>{mine ? t('კლიენტები, რომლებსაც კურსი სთხოვეთ, ახლიდან ძველისკენ', 'Clients you asked a rate for, newest first') : t('ყველა კლიენტი, ბოლო მოთხოვნიდან', 'Every client, from the latest request')}</p>
        </div>
      </div>
      <div className="field" style={{ maxWidth: 420 }}>
        <label htmlFor="client-search">{t('ძებნა ID-ით ან სახელით', 'Search by ID or name')}</label>
        <input id="client-search" className="input" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('დაიწყეთ აკრეფა', 'Start typing')} />
      </div>
      <section className="card flush" aria-label={t('კლიენტები', 'Clients')} style={{ paddingTop: 8 }}>
        {!loading && !rows.length && <p className="empty">{q ? t('ვერ მოიძებნა.', 'Nothing found.') : t('კლიენტები ჯერ არ არის.', 'No clients yet.')}</p>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 640 }}>
              <thead><tr><th>{t('კლიენტი', 'Client')}</th><th>ID</th><th>{t('ტიპი', 'Type')}</th><th>{t('ბოლო მოთხოვნა', 'Last request')}</th><th>{t('ბოლო მიმართულება', 'Last direction')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.client_id}>
                    <td className="strong">{r.name ?? <span className="muted">{t('სახელი არ არის', 'No name')}</span>}</td>
                    <td>{r.client_id}</td>
                    <td>{r.kind === 'company' ? t('კომპანია', 'Company') : t('ფიზიკური პირი', 'Person')}</td>
                    <td>{r.last_request_date ? fmtDay(r.last_request_date) : ''}</td>
                    <td>{r.last_sells_currency ? `${r.last_sells_currency} → ${r.last_gets_currency}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {rows.length === 20 && <p className="small muted" style={{ margin: 0 }}>{t('ნაჩვენებია პირველი 20. უფრო ზუსტად აკრიფეთ.', 'Showing the first 20. Type more to narrow it.')}</p>}
    </>
  );
}
