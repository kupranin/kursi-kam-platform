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
  { value: 'not_contacted', label: 'ჯერ არ დაკავშირებულა' },
  { value: 'called', label: 'დარეკა' },
  { value: 'meeting_set', label: 'შეხვედრა დანიშნულია' },
  { value: 'converted', label: 'კვლავ გადაიყვანა' },
  { value: 'not_interested', label: 'არ აინტერესებს' },
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
    const detail = reason && isOther(reason) ? (otherText[row.id] ?? '').trim() : '';
    try {
      await rpc('set_loss_reason', {
        p_request_id: row.id,
        p_reason: code,
        ...(detail ? { p_detail: detail } : {}),
      });
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

  const reasonText = (r: LossReason) => r.label_ka.trim() || r.label_en;
  const label = (code: string) => {
    const reason = reasons.find((r) => r.code === code);
    return reason ? reasonText(reason) : code;
  };
  const savedLabel = (id: number) => {
    const code = answered[id];
    const reason = reasons.find((r) => r.code === code);
    const text = (otherText[id] ?? '').trim();
    if (reason && isOther(reason) && text) return `${reasonText(reason)}: ${text}`;
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
          <h1>დაბრუნება</h1>
          <p>პასუხები და ზარები დღის მოთხოვნების შემდეგ</p>
        </div>
      </div>

      <section className="card tint" aria-labelledby="ask-title">
        <div className="card-head">
          <div>
            <h2 id="ask-title" style={{ fontSize: 22 }}>რატომ არ გავიდა ეს მოთხოვნები?</h2>
            <p className="small" style={{ color: 'var(--ink-2)' }}>ბოლო 7 დღის მოთხოვნები, შესაბამისი ტრანზაქციის გარეშე.{canAct ? ' აირჩიეთ მიზეზი. „სხვა“-ს გვერდით ჩაწერეთ თქვენი, თუ გჭირდებათ.' : ''}</p>
          </div>
          {asks.length > 0 && <span className="strong" style={{ color: 'var(--aubergine)' }}>{left === 0 ? 'ყველას პასუხი გაეცა. გმადლობთ.' : left + ' დარჩა'}</span>}
        </div>
        {loaded && !asks.length && <p className="empty">საპასუხო არაფერია.</p>}
        <div className="stack-sm">
          {asks.map((a) => (
            <div key={a.id} style={{ background: '#fff', borderRadius: 12, padding: '16px 18px' }} className="row-between">
              <div style={{ flex: '1 1 280px', minWidth: 0 }}>
                <div className="name">{a.client_name ?? a.client_id}</div>
                <div className="small muted">
                  {fmtDay(a.request_date)}: {describeDeal(a.sells_currency, a.amount, a.gets_currency, a.gets_amount)}{a.rate ? ' კურსით ' + fmtRate(a.rate) : ''}
                  {showOwner && a.kam_name ? ', ' + a.kam_name : ''}
                </div>
              </div>
              {answered[a.id] ? (
                <div className="row">
                  <span className="ok-text strong row" style={{ gap: 8 }}><IconCheck />შენახულია: {savedLabel(a.id)}</span>
                  <button type="button" className="link" onClick={() => answer(a, null)}>გაუქმება</button>
                </div>
              ) : canAct ? (
                <div className="chips">
                  {reasons.map((r) => isOther(r) ? (
                    <span key={r.code} className="other-reason">
                      <button type="button" className="chip" onClick={() => answer(a, r.code)}>{reasonText(r)}</button>
                      <input
                        className="input"
                        aria-label="სხვა მიზეზი"
                        placeholder="ჩაწერეთ მიზეზი"
                        value={otherText[a.id] ?? ''}
                        onChange={(e) => setOtherText((m) => ({ ...m, [a.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); answer(a, r.code); } }}
                      />
                    </span>
                  ) : (
                    <button key={r.code} type="button" className="chip" onClick={() => answer(a, r.code)}>{reasonText(r)}</button>
                  ))}
                </div>
              ) : (
                <span className="pill pill-wait">KAM-ს ელოდება</span>
              )}
            </div>
          ))}
        </div>
      </section>

      <div className="page-head" style={{ marginTop: 8 }}>
        <div style={{ maxWidth: 640 }}>
          <h2 style={{ fontSize: 22 }}>დასაბრუნებელი კლიენტები</h2>
          <p className="small" style={{ fontSize: 15 }}>კურსი ითხოვეს, შემდეგ გაჩერდნენ, წარმატებული ტრანზაქციის გარეშე. დაიწყეთ პრიორიტეტი A-დან.</p>
        </div>
        {winback.length > 0 && (
          <div style={{ minWidth: 240 }}>
            <div className="strong small">{contacted} {winback.length}-დან დაკავშირებულია</div>
            <div className="bar" style={{ marginTop: 8, height: 10 }} aria-hidden="true"><span className="ok" style={{ width: pct + '%' }} /></div>
          </div>
        )}
      </div>

      <div className="chips">
        {(['All', 'A', 'B', 'C'] as const).map((t) => (
          <button key={t} type="button" className="chip" aria-pressed={filter === t} onClick={() => setFilter(t)}>
            {t === 'All' ? 'ყველა' : 'პრიორიტეტი ' + t} ({winback.filter((w) => t === 'All' || w.tier === t).length})
          </button>
        ))}
      </div>

      <section className="card flush" aria-label="დასაბრუნებელი კლიენტები" style={{ paddingTop: 8 }}>
        {loaded && !shown.length && <p className="empty">აქ დასაბრუნებელი კლიენტი არ არის.</p>}
        {shown.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>პრიორიტეტი</th><th>კლიენტი</th>{showOwner && <th>KAM</th>}<th>ბოლო მოთხოვნა</th><th>ბოლო გარიგება</th>
                  <th className="num">ჩვეულებრივი ზომა</th><th>მითითებული მიზეზი</th><th>შემდეგი ნაბიჯი</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((w) => (
                  <tr key={w.client_id}>
                    <td><span className={'tier tier-' + w.tier} aria-label={'პრიორიტეტი ' + w.tier}>{w.tier}</span></td>
                    <td><div className="strong">{w.client_name ?? w.client_id}</div><div className="tiny muted">ID {w.client_id}</div></td>
                    {showOwner && <td>{w.owner_name}</td>}
                    <td>{fmtDay(w.last_request)}</td>
                    <td className={w.last_deal ? '' : 'warn-text'}>{w.last_deal ? fmtDay(w.last_deal) : 'არასდროს'}</td>
                    <td className="num nowrap">GEL {fmtWhole(Math.max(Number(w.prior_turnover_gel) || 0, Number(w.max_request_gel) || 0))}</td>
                    <td>{w.last_reason ? label(w.last_reason) : <span className="muted">არ არის</span>}</td>
                    <td>
                      <label className="sr-only" htmlFor={'step-' + w.client_id}>შემდეგი ნაბიჯი: {w.client_name}</label>
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
      <p className="small muted" style={{ margin: 0 }}>პრიორიტეტი A ნიშნავს ყველაზე დიდ წარსულ ბრუნვას ან მოთხოვნის ზომას, C ყველაზე პატარას. კლიენტი ამ სიას თავისით ტოვებს, როცა წარმატებული ტრანზაქცია მოდის.</p>
    </>
  );
}
