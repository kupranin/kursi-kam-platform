import { useEffect, useState } from 'react';
import { rpc } from '../../lib/supabase';
import { useToast } from '../../lib/toast';
import { fmtDateTime, fmtWhole } from '../../lib/format';

interface Run { id: number; kind: string; started_at: string; finished_at: string | null; ok: boolean | null; rows_upserted: number | null; error: string | null }
interface Status { freshness: string | null; last_nightly: string | null; backfill_waiting: number; runs: Run[] }

const KIND: Record<string, string> = { hourly: 'საათობრივი', nightly: 'ღამის შემოწმება', manual: 'სინქრონიზაცია ახლა', backfill: 'ახალი კლიენტის ისტორია' };

export default function SyncPanel() {
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setStatus(await rpc<Status>('admin_sync_status')); } catch (err) { toast((err as Error).message, 'error'); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function syncNow() {
    setBusy(true);
    try {
      setStatus(await rpc<Status>('admin_sync_now'));
      toast('სინქრონიზაცია დასრულდა.');
    } catch (err) { toast((err as Error).message, 'error'); }
    setBusy(false);
  }

  return (
    <section id="sync" className="card flush" aria-labelledby="sync-title">
      <div className="card-head" style={{ alignItems: 'center' }}>
        <div>
          <h2 id="sync-title" style={{ fontSize: 22 }}>მონაცემების სინქრონიზაცია</h2>
          <p className="small" style={{ color: 'var(--ink-2)' }}>ტრანზაქციები მოდის ClickHouse-იდან ყოველ საათში, სრული შემოწმებით ყოველ ღამე 03:00-ზე.</p>
        </div>
        <button type="button" className="btn" onClick={syncNow} disabled={busy}>{busy ? 'სინქრონიზდება…' : 'სინქრონიზაცია ახლა'}</button>
      </div>
      {status && (
        <>
          <div className="stats" style={{ padding: '0 24px 18px' }}>
            <div className="stat"><div className="label">ტრანზაქციები განახლდა</div><div className="value" style={{ fontSize: 22, color: status.freshness ? 'var(--ok)' : 'var(--alert)' }}>{status.freshness ? fmtDateTime(status.freshness) : 'არასდროს'}</div></div>
            <div className="stat"><div className="label">გუშინ ღამის შემოწმება</div><div className="value" style={{ fontSize: 22 }}>{status.last_nightly ? fmtDateTime(status.last_nightly) : 'ჯერ არა'}</div></div>
            <div className="stat"><div className="label">ახალი კლიენტები ისტორიის მოლოდინში</div><div className="value" style={{ fontSize: 22 }}>{status.backfill_waiting}</div></div>
          </div>
          {!status.runs.length && <p className="empty">სინქრონიზაცია ჯერ არ გაშვებულა. მიაერთეთ ClickHouse (დაყენების გზამკვლევი, ნაწილი 2).</p>}
          {status.runs.length > 0 && (
            <div className="table-wrap">
              <table className="table" style={{ minWidth: 640 }}>
                <thead><tr><th>დაიწყო</th><th>ტიპი</th><th>შედეგი</th><th>დეტალები</th></tr></thead>
                <tbody>
                  {status.runs.map((r) => (
                    <tr key={r.id}>
                      <td>{fmtDateTime(r.started_at)}</td>
                      <td>{KIND[r.kind] ?? r.kind}</td>
                      <td>{r.ok == null ? <span className="pill pill-wait">მიმდინარეობს</span> : r.ok ? <span className="pill pill-ok">წარმატდა</span> : <span className="pill pill-alert">ჩაიშალა</span>}</td>
                      <td style={{ color: 'var(--ink-2)' }}>{r.ok === false ? r.error : r.rows_upserted != null ? fmtWhole(r.rows_upserted) + ' ტრანზაქცია განახლდა' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
