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
  const months = monthOptions(6);
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
  const monthLabel = months.find((m) => m.value === month)?.label ?? month;
  const isKam = role === 'kam';

  function exportCsv() {
    downloadCsv(`kam-portfolio-${month.slice(0, 7)}.csv`, [
      ['Client ID', 'Client', 'Owner KAM', 'Requests in period', 'Turnover GEL', 'Of which not successful', 'Income GEL', 'Transactions'],
      ...portfolio.map((p) => [p.client_id, p.client_name, p.owner_name, p.requests_in_window, p.turnover, p.turnover_not_successful, p.income, p.transactions]),
    ]);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{isKam ? 'My numbers' : 'Team'}</h1>
          <p>{isKam ? 'Your book, counted the same way as everyone else\'s' : 'Every KAM\'s book, counted the same way'}</p>
        </div>
        <div className="row">
          <label className="sr-only" htmlFor="month">Month</label>
          <select id="month" className="select" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button type="button" className="btn" onClick={exportCsv} disabled={!portfolio.length}><IconDownload />Download for Excel</button>
        </div>
      </div>

      {error && <p className="alert-box" role="alert">{error}</p>}

      <div className="stats big">
        <div className="stat"><div className="label">Clients</div><div className="value">{fmtWhole(total.clients)}</div></div>
        <div className="stat"><div className="label">Turnover</div><div className="value">GEL {fmtShort(total.turnover)}</div></div>
        <div className="stat"><div className="label">Income</div><div className="value">GEL {fmtWhole(total.income)}</div></div>
        <div className="stat">
          <div className="label">Turnover that didn't go through</div>
          <div className="value" style={{ color: failedShare > 0 ? 'var(--alert)' : undefined }}>{failedShare}%</div>
          <div className="small muted">GEL {fmtShort(total.tns)}</div>
        </div>
      </div>

      <section className="card flush" aria-labelledby="score-title">
        <div className="card-head">
          <h2 id="score-title">{isKam ? monthLabel : 'By KAM, ' + monthLabel}</h2>
          <div className="legend"><span><i style={{ background: 'var(--aubergine)' }} />Went through</span><span><i style={{ background: 'var(--orange)' }} />Didn't go through</span></div>
        </div>
        {loading && <p className="empty">Loading…</p>}
        {!loading && !summary.length && <p className="empty">No requests or turnover in this month yet.</p>}
        {!loading && summary.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 980 }}>
              <thead>
                <tr>
                  <th>KAM</th><th className="num">Clients</th><th style={{ width: '28%' }}>Turnover</th>
                  <th className="num">Didn't go through</th><th className="num">Income</th><th className="num">Income per GEL 1M</th><th className="num">Requests won</th>
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
                      <td className="num">{r.requests_judged ? `${r.requests_won} of ${r.requests_judged} (${r.win_rate_pct}%)` : ''}</td>
                    </tr>
                  );
                })}
                {summary.length > 1 && (
                  <tr>
                    <th scope="row" className="strong">Total</th>
                    <td className="num strong">{fmtWhole(total.clients)}</td>
                    <td className="strong">GEL {fmtShort(total.turnover)}</td>
                    <td className="num strong">{fmtShort(total.tns)}</td>
                    <td className="num strong">{fmtWhole(total.income)}</td>
                    <td className="num strong">{total.turnover ? fmtWhole(Math.round((total.income / total.turnover) * 1_000_000)) : ''}</td>
                    <td className="num strong">{total.judged ? `${total.won} of ${total.judged}` : ''}</td>
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
            <h2 id="fail-title">Biggest turnover that didn't go through</h2>
            <p className="small muted" style={{ margin: '4px 0 14px' }}>{monthLabel}</p>
            {!biggestFailed.length && <p className="empty">None this month.</p>}
            <div className="stack-sm">
              {biggestFailed.map((p) => {
                const t = Number(p.turnover), ns = Number(p.turnover_not_successful);
                return (
                  <div key={p.client_id}>
                    <div className="row-between" style={{ marginBottom: 6 }}>
                      <span className="strong" style={{ fontWeight: 500 }}>{p.client_name ?? p.client_id}{!isKam && <span className="muted small">, {p.owner_name}</span>}</span>
                      <span className="small" style={{ color: 'var(--ink-2)' }}>GEL {fmtShort(ns)} of {fmtShort(t)} didn't go through</span>
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
              <h2 id="wb-title">Win-back</h2>
              <p style={{ margin: '6px 0 0', color: 'var(--ink-2)' }}>
                {winback.length} {winback.length === 1 ? 'client' : 'clients'} asked for a rate and haven't had a successful transaction since.
                {' '}{winback.filter((w) => w.tier === 'A' && w.step === 'not_contacted').length} priority A not contacted yet.
              </p>
            </div>
            <Link to="/follow-ups" className="btn btn-dark">Open follow-ups</Link>
          </section>
        </div>

        <section className="card tint col-side" aria-labelledby="rules-title">
          <h2 id="rules-title">How these numbers are counted</h2>
          <p className="small" style={{ margin: '4px 0 16px', color: 'var(--ink-2)' }}>The same rules apply on every screen and in every export.</p>
          <dl className="stack-sm" style={{ margin: 0 }}>
            <div><dt className="strong">Turnover</dt><dd style={{ margin: '2px 0 0' }}>ABS GEL plus Cross GEL, every payment status</dd></div>
            <div><dt className="strong">Income</dt><dd style={{ margin: '2px 0 0' }}>Total income, every payment status, nothing added on top</dd></div>
            <div><dt className="strong">Went through</dt><dd style={{ margin: '2px 0 0' }}>A successful transaction from the same client on the day of the request</dd></div>
            <div><dt className="strong">Whose client</dt><dd style={{ margin: '2px 0 0' }}>The KAM with the most requests for that client in the month; ties go to the latest</dd></div>
            <div>
              <dt className="strong">Month cutoff</dt>
              <dd style={{ margin: '2px 0 0' }}>
                {rules?.month_grace_days == null
                  ? <span className="warn-text">Not decided yet, counted as the calendar month.</span>
                  : rules.month_grace_days === 0 ? 'Calendar month only' : `Month plus ${rules.month_grace_days} ${rules.month_grace_days === 1 ? 'day' : 'days'}`}
              </dd>
            </div>
          </dl>
          {role === 'admin' && <p className="small" style={{ marginTop: 16 }}><Link to="/admin#rules">Change the rules</Link></p>}
        </section>
      </div>
    </>
  );
}
