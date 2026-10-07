import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { downloadCsv, fmtShort, fmtWhole, monthOptions } from '../lib/format';
import type { PortfolioRow, Rules, SummaryRow, WinbackRow } from '../lib/types';
import { IconDownload } from '../components/Icons';

export default function Team() {
  const { profile } = useAuth();
  const role = profile!.role;
  const isKam = role === 'kam';
  const months = monthOptions(role === 'admin' ? 36 : 6);
  const [month, setMonth] = useState(months[1]?.value ?? months[0].value);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioRow[]>([]);
  const [winback, setWinback] = useState<WinbackRow[]>([]);
  const [rules, setRules] = useState<Rules | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    Promise.all([
      rpc<SummaryRow[]>('kam_month_summary', { p_month: month }),
      rpc<PortfolioRow[]>('month_portfolio', { p_month: month }),
    ])
      .then(([s, p]) => { if (alive) { setSummary(s ?? []); setPortfolio(p ?? []); } })
      .catch((err) => alive && setError((err as Error).message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [month]);

  useEffect(() => {
    supabase.from('rules').select('*').single().then(({ data }) => setRules(data as Rules));
    rpc<WinbackRow[]>('winback_list').then(setWinback).catch(() => setWinback([]));
  }, []);

  const total = summary.reduce(
    (a, r) => ({
      clients: a.clients + Number(r.clients),
      turnover: a.turnover + Number(r.turnover),
      tns: a.tns + Number(r.turnover_not_successful),
      income: a.income + Number(r.income),
      judged: a.judged + Number(r.requests_judged),
      won: a.won + Number(r.requests_won),
    }),
    { clients: 0, turnover: 0, tns: 0, income: 0, judged: 0, won: 0 },
  );
  const maxTurnover = Math.max(1, ...summary.map((r) => Number(r.turnover)));
  const failedShare = total.turnover > 0 ? Math.round((total.tns / total.turnover) * 100) : 0;
  const biggestFailed = [...portfolio].sort((a, b) => Number(b.turnover_not_successful) - Number(a.turnover_not_successful)).filter((p) => Number(p.turnover_not_successful) > 0).slice(0, 3);
  const monthLabel = (months.find((m) => m.value === month)?.label ?? month).replace(', so far', ', ჯერჯერობით');

  function exportCsv() {
    downloadCsv(`kam-portfolio-${month.slice(0, 7)}.csv`, [
      ['კლიენტის ID', 'კლიენტი', 'KAM', 'მოთხოვნები პერიოდში', 'ბრუნვა GEL', 'აქედან არ გავიდა', 'შემოსავალი GEL', 'ტრანზაქციები'],
      ...portfolio.map((p) => [p.client_id, p.client_name, p.owner_name, p.requests_in_window, p.turnover, p.turnover_not_successful, p.income, p.transactions]),
    ]);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{isKam ? 'ჩემი ციფრები' : 'გუნდი'}</h1>
          <p>{isKam ? 'თქვენი პორტფელი, იგივე წესით, როგორც ყველასი' : 'ყველა KAM-ის პორტფელი, იგივე წესით'}</p>
        </div>
        <div className="row">
          <label className="sr-only" htmlFor="month">თვე</label>
          <select id="month" className="select" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m.value} value={m.value}>{m.label.replace(', so far', ', ჯერჯერობით')}</option>)}
          </select>
          <button type="button" className="btn" onClick={exportCsv} disabled={!portfolio.length}><IconDownload />ჩამოტვირთვა Excel-ისთვის</button>
        </div>
      </div>

      {error && <p className="alert-box" role="alert">{error}</p>}

      <div className="stats big">
        <div className="stat"><div className="label">კლიენტები</div><div className="value">{fmtWhole(total.clients)}</div></div>
        <div className="stat"><div className="label">ბრუნვა</div><div className="value">GEL {fmtShort(total.turnover)}</div></div>
        <div className="stat"><div className="label">შემოსავალი</div><div className="value">GEL {fmtWhole(total.income)}</div></div>
        <div className="stat">
          <div className="label">ბრუნვა, რომელიც არ გავიდა</div>
          <div className="value" style={{ color: failedShare > 0 ? 'var(--alert)' : undefined }}>{failedShare}%</div>
          <div className="small muted">GEL {fmtShort(total.tns)}</div>
        </div>
      </div>

      <section className="card flush" aria-labelledby="score-title">
        <div className="card-head">
          <h2 id="score-title">{isKam ? monthLabel : 'KAM-ის მიხედვით, ' + monthLabel}</h2>
          <div className="legend"><span><i style={{ background: 'var(--aubergine)' }} />გავიდა</span><span><i style={{ background: 'var(--orange)' }} />არ გავიდა</span></div>
        </div>
        {loading && <p className="empty">იტვირთება…</p>}
        {!loading && !summary.length && <p className="empty">ამ თვეში მოთხოვნა ან ბრუნვა ჯერ არ არის.</p>}
        {!loading && summary.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 980 }}>
              <thead>
                <tr>
                  <th>KAM</th><th className="num">კლიენტები</th><th style={{ width: '28%' }}>ბრუნვა</th>
                  <th className="num">არ გავიდა</th><th className="num">შემოსავალი</th><th className="num">შემოსავალი GEL 1 მლნ-ზე</th><th className="num">მოგებული მოთხოვნები</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => {
                  const t = Number(r.turnover), ns = Number(r.turnover_not_successful);
                  return (
                    <tr key={r.kam_id}>
                      <th scope="row">{r.kam_name}</th>
                      <td className="num">{fmtWhole(r.clients)}</td>
                      <td>
                        <div className="row" style={{ gap: 12, flexWrap: 'nowrap' }}>
                          <span className="strong" style={{ minWidth: 70, fontWeight: 500 }}>{fmtShort(t)}</span>
                          <div className="bar" style={{ flex: 1 }} aria-hidden="true">
                            <span className="ok" style={{ width: ((t - ns) / maxTurnover) * 100 + '%' }} />
                            <span className="no" style={{ width: (ns / maxTurnover) * 100 + '%' }} />
                          </div>
                        </div>
                      </td>
                      <td className="num">{fmtShort(ns)}</td>
                      <td className="num">{fmtWhole(r.income)}</td>
                      <td className="num strong">{r.income_per_1m_turnover != null ? fmtWhole(r.income_per_1m_turnover) : ''}</td>
                      <td className="num">{r.requests_judged ? `${r.requests_won} / ${r.requests_judged} (${r.win_rate_pct}%)` : ''}</td>
                    </tr>
                  );
                })}
                {summary.length > 1 && (
                  <tr>
                    <th scope="row" className="strong">სულ</th>
                    <td className="num strong">{fmtWhole(total.clients)}</td>
                    <td className="strong">GEL {fmtShort(total.turnover)}</td>
                    <td className="num strong">{fmtShort(total.tns)}</td>
                    <td className="num strong">{fmtWhole(total.income)}</td>
                    <td className="num strong">{total.turnover ? fmtWhole(Math.round((total.income / total.turnover) * 1_000_000)) : ''}</td>
                    <td className="num strong">{total.judged ? `${total.won} / ${total.judged}` : ''}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="cols">
        <div className="col-main">
          <section className="card" aria-labelledby="fail-title">
            <h2 id="fail-title">ყველაზე დიდი ბრუნვა, რომელიც არ გავიდა</h2>
            <p className="small muted" style={{ margin: '4px 0 14px' }}>{monthLabel}</p>
            {!biggestFailed.length && <p className="empty">ამ თვეში არ არის.</p>}
            <div className="stack-sm">
              {biggestFailed.map((p) => {
                const t = Number(p.turnover), ns = Number(p.turnover_not_successful);
                return (
                  <div key={p.client_id}>
                    <div className="row-between" style={{ marginBottom: 6 }}>
                      <span className="strong" style={{ fontWeight: 500 }}>{p.client_name ?? p.client_id}{!isKam && <span className="muted small">, {p.owner_name}</span>}</span>
                      <span className="small" style={{ color: 'var(--ink-2)' }}>GEL {fmtShort(ns)} {fmtShort(t)}-დან არ გავიდა</span>
                    </div>
                    <div className="bar" style={{ height: 12 }} aria-hidden="true">
                      <span className="ok" style={{ width: ((t - ns) / t) * 100 + '%' }} />
                      <span className="no" style={{ width: (ns / t) * 100 + '%' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
          <section className="card row-between" aria-labelledby="wb-title" style={{ alignItems: 'center' }}>
            <div style={{ maxWidth: 520 }}>
              <h2 id="wb-title">დაბრუნება</h2>
              <p style={{ margin: '6px 0 0', color: 'var(--ink-2)' }}>
                {winback.length} {winback.length === 1 ? 'კლიენტმა' : 'კლიენტებმა'} კურსი ითხოვა და მას შემდეგ წარმატებული ტრანზაქცია არ ჰქონია.
                {' '}პრიორიტეტი A, ჯერ დაუკავშირებელი: {winback.filter((w) => w.tier === 'A' && w.step === 'not_contacted').length}.
              </p>
            </div>
            <Link to="/follow-ups" className="btn btn-dark">დაბრუნების გახსნა</Link>
          </section>
        </div>

        <section className="card tint col-side" aria-labelledby="rules-title">
          <h2 id="rules-title">როგორ ითვლება ეს ციფრები</h2>
          <p className="small" style={{ margin: '4px 0 16px', color: 'var(--ink-2)' }}>იგივე წესებია ყველა ეკრანზე და ყველა ექსპორტში.</p>
          <dl className="stack-sm" style={{ margin: 0 }}>
            <div><dt className="strong">ბრუნვა</dt><dd style={{ margin: '2px 0 0' }}>ABS GEL პლუს Cross GEL, ყველა გადახდის სტატუსი</dd></div>
            <div><dt className="strong">შემოსავალი</dt><dd style={{ margin: '2px 0 0' }}>სრული შემოსავალი, ყველა გადახდის სტატუსი, ზემოდან არაფერი ემატება</dd></div>
            <div><dt className="strong">გავიდა</dt><dd style={{ margin: '2px 0 0' }}>წარმატებული ტრანზაქცია იმავე კლიენტისგან მოთხოვნის დღეს</dd></div>
            <div><dt className="strong">ვისი კლიენტია</dt><dd style={{ margin: '2px 0 0' }}>KAM, რომელსაც ამ თვეში ამ კლიენტზე ყველაზე მეტი მოთხოვნა აქვს; ფრე ბოლო მოთხოვნა წყვეტს</dd></div>
            <div>
              <dt className="strong">თვის ზღვარი</dt>
              <dd style={{ margin: '2px 0 0' }}>
                {rules?.month_grace_days == null
                  ? <span className="warn-text">ჯერ არ არის გადაწყვეტილი, ითვლება კალენდარული თვე.</span>
                  : rules.month_grace_days === 0 ? 'მხოლოდ კალენდარული თვე' : `თვე პლუს ${rules.month_grace_days} დღე`}
              </dd>
            </div>
          </dl>
          {role === 'admin' && <p className="small" style={{ marginTop: 16 }}><Link to="/admin#rules">წესების შეცვლა</Link></p>}
        </section>
      </div>
    </>
  );
}
