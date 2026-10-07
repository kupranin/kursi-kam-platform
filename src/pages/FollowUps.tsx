import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { describeDeal, fmtDay, fmtRate, fmtWhole, todayTbilisi } from '../lib/format';
import type { LossReason, RequestRow, WinbackRow } from '../lib/types';
import { IconCheck } from '../components/Icons';

function isOther(reason: LossReason): boolean {
  return reason.code === 'other' || reason.label_en.trim().toLowerCase() === 'other';
}

const STEPS: { value: string; label: string }[] = [
  { value: 'not_contacted', label: 'Not contacted' },
  { value: 'called', label: 'Called' },
  { value: 'meeting_set', label: 'Meeting set' },
  { value: 'converted', label: 'Converted again' },
  { value: 'not_interested', label: 'Not interested' },
];

export default function FollowUps() {
  const { profile } = useAuth();
  const toast = useToast();
  const role = profile!.role;
  const canAct = role === 'kam' || role === 'admin';
  const showOwner = role !== 'kam';

  const [asks, setAsks] = useState<RequestRow[]>([]);
  const [answered, setAnswered] = useState<Record<number, string>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  const [reasons, setReasons] = useState<LossReason[]>([]);
  const [winback, setWinback] = useState<WinbackRow[]>([]);
  const [filter, setFilter] = useState<'All' | 'A' | 'B' | 'C'>('All');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    let q = supabase.from('request_outcomes').select('*')
      .eq('outcome', 'did_not_go_through').is('loss_reason', null)
      .gte('request_date', todayTbilisi(-7))
      .order('request_date', { ascending: false });
    if (role === 'kam') q = q.eq('kam_id', profile!.id);
    const [a, r, w] = await Promise.all([
      q,
      supabase.from('loss_reasons').select('*').eq('active', true).order('sort_order'),
      rpc<WinbackRow[]>('winback_list').catch(() => [] as WinbackRow[]),
    ]);
    setAsks((a.data ?? []) as RequestRow[]);
    setReasons((r.data ?? []) as LossReason[]);
    setWinback(w ?? []);
    setLoaded(true);
  }, [profile, role]);

  useEffect(() => { load(); }, [load]);

  async function answer(row: RequestRow, code: string | null) {
    const reason = reasons.find((r) => r.code === code);
    const detail = reason && isOther(reason) ? (otherText[row.id] ?? '').trim() : null;
    try {
      await rpc('set_loss_reason', { p_request_id: row.id, p_reason: code, p_detail: detail || null });
      setAnswered((m) => {
        const next = { ...m };
        if (code) next[row.id] = code; else delete next[row.id];
        return next;
      });
    } catch (err) { toast((err as Error).message, 'error'); }
  }

  async function setStep(w: WinbackRow, step: string) {
    try {
      await rpc('set_winback_step', { p_client_id: w.client_id, p_step: step, p_note: null });
      setWinback((list) => list.map((x) => (x.client_id === w.client_id ? { ...x, step } : x)));
      toast(`${w.client_name ?? w.client_id}: ${STEPS.find((s) => s.value === step)?.label}`);
    } catch (err) { toast((err as Error).message, 'error'); }
  }

  const label = (code: string) => reasons.find((r) => r.code === code)?.label_en ?? code;
  const savedLabel = (id: number) => {
    const code = answered[id];
    const reason = reasons.find((r) => r.code === code);
    const text = (otherText[id] ?? '').trim();
    if (reason && isOther(reason) && text) return `${reason.label_en}: ${text}`;
    return label(code);
  };
  const left = asks.filter((a) => !answered[a.id]).length;
  const shown = useMemo(() => winback.filter((w) => filter === 'All' || w.tier === filter), [winback, filter]);
  const contacted = winback.filter((w) => w.step !== 'not_contacted').length;
  const pct = winback.length ? Math.round((contacted / winback.length) * 100) : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Follow-ups</h1>
          <p>Answers and calls that come after the day's requests</p>
        </div>
      </div>

      <section className="card tint" aria-labelledby="ask-title">
        <div className="card-head">
          <div>
            <h2 id="ask-title" style={{ fontSize: 22 }}>Why didn't these go through?</h2>
            <p className="small" style={{ color: 'var(--ink-2)' }}>Requests from the last 7 days with no matching transaction.{canAct ? ' Pick a reason. Next to Other, type your own if you need to.' : ''}</p>
          </div>
          {asks.length > 0 && <span className="strong" style={{ color: 'var(--aubergine)' }}>{left === 0 ? 'All answered. Thank you.' : left + ' left'}</span>}
        </div>
        {loaded && !asks.length && <p className="empty">Nothing to answer. Well done.</p>}
        <div className="stack-sm">
          {asks.map((a) => (
            <div key={a.id} style={{ background: '#fff', borderRadius: 12, padding: '16px 18px' }} className="row-between">
              <div style={{ flex: '1 1 280px', minWidth: 0 }}>
                <div className="name">{a.client_name ?? a.client_id}</div>
                <div className="small muted">
                  {fmtDay(a.request_date)}: {describeDeal(a.sells_currency, a.amount, a.gets_currency, a.gets_amount)}{a.rate ? ' at ' + fmtRate(a.rate) : ''}
                  {showOwner && a.kam_name ? ', ' + a.kam_name : ''}
                </div>
              </div>
              {answered[a.id] ? (
                <div className="row">
                  <span className="ok-text strong row" style={{ gap: 8 }}><IconCheck />Saved: {savedLabel(a.id)}</span>
                  <button type="button" className="link" onClick={() => answer(a, null)}>Undo</button>
                </div>
              ) : canAct ? (
                <div className="chips">
                  {reasons.map((r) => isOther(r) ? (
                    <span key={r.code} className="other-reason">
                      <button type="button" className="chip" onClick={() => answer(a, r.code)}>{r.label_en}</button>
                      <input
                        className="input"
                        aria-label="Other reason"
                        placeholder="Type the reason"
                        value={otherText[a.id] ?? ''}
                        onChange={(e) => setOtherText((m) => ({ ...m, [a.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); answer(a, r.code); } }}
                      />
                    </span>
                  ) : (
                    <button key={r.code} type="button" className="chip" onClick={() => answer(a, r.code)}>{r.label_en}</button>
                  ))}
                </div>
              ) : (
                <span className="pill pill-wait">Waiting for the KAM</span>
              )}
            </div>
          ))}
        </div>
      </section>

      <div className="page-head" style={{ marginTop: 8 }}>
        <div style={{ maxWidth: 640 }}>
          <h2 style={{ fontSize: 22 }}>Clients to win back</h2>
          <p className="small" style={{ fontSize: 15 }}>They asked for a rate, then stopped, with no successful transaction since. Start with priority A.</p>
        </div>
        {winback.length > 0 && (
          <div style={{ minWidth: 240 }}>
            <div className="strong small">{contacted} of {winback.length} contacted</div>
            <div className="bar" style={{ marginTop: 8, height: 10 }} aria-hidden="true"><span className="ok" style={{ width: pct + '%' }} /></div>
          </div>
        )}
      </div>

      <div className="chips">
        {(['All', 'A', 'B', 'C'] as const).map((t) => (
          <button key={t} type="button" className="chip" aria-pressed={filter === t} onClick={() => setFilter(t)}>
            {t === 'All' ? 'All' : 'Priority ' + t} ({winback.filter((w) => t === 'All' || w.tier === t).length})
          </button>
        ))}
      </div>

      <section className="card flush" aria-label="Clients to win back" style={{ paddingTop: 8 }}>
        {loaded && !shown.length && <p className="empty">No clients to win back here.</p>}
        {shown.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>Priority</th><th>Client</th>{showOwner && <th>KAM</th>}<th>Last request</th><th>Last deal</th>
                  <th className="num">Usual size</th><th>Reason given</th><th>Next step</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((w) => (
                  <tr key={w.client_id}>
                    <td><span className={'tier tier-' + w.tier} aria-label={'Priority ' + w.tier}>{w.tier}</span></td>
                    <td><div className="strong">{w.client_name ?? w.client_id}</div><div className="tiny muted">ID {w.client_id}</div></td>
                    {showOwner && <td>{w.owner_name}</td>}
                    <td>{fmtDay(w.last_request)}</td>
                    <td className={w.last_deal ? '' : 'warn-text'}>{w.last_deal ? fmtDay(w.last_deal) : 'Never'}</td>
                    <td className="num nowrap">GEL {fmtWhole(Math.max(Number(w.prior_turnover_gel) || 0, Number(w.max_request_gel) || 0))}</td>
                    <td>{w.last_reason ? label(w.last_reason) : <span className="muted">None</span>}</td>
                    <td>
                      <label className="sr-only" htmlFor={'step-' + w.client_id}>Next step for {w.client_name}</label>
                      <select id={'step-' + w.client_id} className="select" style={{ minHeight: 44, width: 'auto' }} value={w.step} disabled={!canAct} onChange={(e) => setStep(w, e.target.value)}>
                        {STEPS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="small muted" style={{ margin: 0 }}>Priority A means the largest past turnover or request size, C the smallest. A client leaves this list on their own once a successful transaction arrives.</p>
    </>
  );
}
