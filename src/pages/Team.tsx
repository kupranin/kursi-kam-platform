import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { downloadCsv, fmtWhole, monthOptions } from '../lib/format';
import type { PortfolioRow, SummaryRow } from '../lib/types';
import { IconDownload } from '../components/Icons';
import LoadingLine from '../components/LoadingLine';

export default function Team() {
  const { profile } = useAuth();
  const { role } = useViewAs();
  const { t } = useI18n();
  const isKam = role === 'kam';
  const months = monthOptions(role === 'admin' ? 36 : 6);
  const [month, setMonth] = useState(months[1]?.value ?? months[0].value);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioRow[]>([]);
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

  const visibleSummary = isKam ? summary.filter((r) => r.kam_id === profile!.id) : summary;
  const visiblePortfolio = isKam ? portfolio.filter((p) => p.owner_id === profile!.id) : portfolio;
  const total = visibleSummary.reduce(
    (a, r) => ({
      clients: a.clients + Number(r.clients),
      judged: a.judged + Number(r.requests_judged),
      won: a.won + Number(r.requests_won),
    }),
    { clients: 0, judged: 0, won: 0 },
  );
  const monthLabel = months.find((m) => m.value === month)?.label ?? month;

  function exportCsv() {
    downloadCsv(`kam-requests-${month.slice(0, 7)}.csv`, [
      ['კლიენტის ID', 'კლიენტი', 'KAM', 'მოთხოვნები პერიოდში'],
      ...visiblePortfolio.map((p) => [p.client_id, p.client_name, p.owner_name, p.requests_in_window]),
    ]);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{isKam ? t('ჩემი ციფრები', 'My numbers') : t('გუნდი', 'Team')}</h1>
          <p>{isKam
            ? t('თქვენი მოთხოვნები ამ თვეში. საბანკო ფაილის ბრუნვა აქ არ ჩანს.', 'Your requests this month. Bank-file turnover is not shown here.')
            : t('KAM-ების მოთხოვნები ამ თვეში. საბანკო ფაილის ბრუნვა აქ არ ჩანს.', 'KAM requests this month. Bank-file turnover is not shown here.')}</p>
        </div>
        <div className="row">
          <label className="sr-only" htmlFor="month">თვე</label>
          <select id="month" className="select" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button type="button" className="btn" onClick={exportCsv} disabled={!visiblePortfolio.length}><IconDownload />ჩამოტვირთვა Excel-ისთვის</button>
        </div>
      </div>

      {error && <p className="alert-box" role="alert">{error}</p>}

      <div className="stats big">
        <div className="stat"><div className="label">{t('კლიენტები', 'Clients')}</div><div className="value">{fmtWhole(total.clients)}</div></div>
        <div className="stat">
          <div className="label">{t('მოთხოვნა, რომელიც გავიდა', 'Requests that went through')}</div>
          <div className="value">{total.judged ? `${fmtWhole(total.won)} / ${fmtWhole(total.judged)}` : '—'}</div>
          <div className="small muted">{t('მოთხოვნის შედეგი. დადასტურებული საბანკო ტრანზაქცია არ არის.', 'A request outcome. Not a confirmed bank transaction.')}</div>
        </div>
      </div>

      <section className="card flush" aria-labelledby="score-title">
        <div className="card-head">
          <h2 id="score-title">{isKam ? monthLabel : 'KAM-ის მიხედვით, ' + monthLabel}</h2>
        </div>
        {loading && <LoadingLine />}
        {!loading && !visibleSummary.length && <p className="empty">{t('ამ თვეში მოთხოვნა ჯერ არ არის.', 'No request this month yet.')}</p>}
        {!loading && visibleSummary.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 640 }}>
              <thead>
                <tr>
                  <th>KAM</th>
                  <th className="num">{t('კლიენტები', 'Clients')}</th>
                  <th className="num">{t('მოთხოვნა, რომელიც გავიდა', 'Requests that went through')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleSummary.map((r) => (
                  <tr key={r.kam_id}>
                    <th scope="row">{r.kam_name}</th>
                    <td className="num">{fmtWhole(r.clients)}</td>
                    <td className="num">{r.requests_judged ? `${r.requests_won} / ${r.requests_judged} (${r.win_rate_pct}%)` : ''}</td>
                  </tr>
                ))}
                {visibleSummary.length > 1 && (
                  <tr>
                    <th scope="row" className="strong">{t('სულ', 'Total')}</th>
                    <td className="num strong">{fmtWhole(total.clients)}</td>
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
          <section className="card row-between" aria-labelledby="wb-title" style={{ alignItems: 'center' }}>
            <div style={{ maxWidth: 520 }}>
              <h2 id="wb-title">{t('დაბრუნება', 'Follow-ups')}</h2>
              <p style={{ margin: '6px 0 0', color: 'var(--ink-2)' }}>
                {t('დაბრუნების სია ღია მოთხოვნებზეა. საბანკო ფაილის ბრუნვა ამ ბარათზე არ ჩანს.', 'The follow-up list is for open requests. Bank-file turnover is not on this card.')}
              </p>
            </div>
            <Link to="/follow-ups" className="btn btn-dark">{t('დაბრუნების გახსნა', 'Open follow-ups')}</Link>
          </section>
        </div>

        <section className="card tint col-side" aria-labelledby="rules-title">
          <h2 id="rules-title">{t('როგორ ითვლება ეს ციფრები', 'How these figures are counted')}</h2>
          <dl className="stack-sm" style={{ margin: '12px 0 0' }}>
            <div><dt className="strong">{t('კლიენტები', 'Clients')}</dt><dd style={{ margin: '2px 0 0' }}>{t('კლიენტი, რომელზეც ამ თვეში მოთხოვნაა.', 'A client with a request this month.')}</dd></div>
            <div><dt className="strong">{t('მოთხოვნა, რომელიც გავიდა', 'Requests that went through')}</dt><dd style={{ margin: '2px 0 0' }}>{t('მოთხოვნის შედეგი: გაწერილი კურსი, გადახდის ნიშანი, ან შედეგის ხედში უკვე დათვლილი დამთხვევა. ეს ატვირთული საბანკო ფაილის ბრუნვა არ არის.', 'The request outcome: a written rate, a payment mark, or a match the outcome view already counts. This is not uploaded bank-file turnover.')}</dd></div>
          </dl>
          {role === 'admin' && <p className="small" style={{ marginTop: 16 }}><Link to="/admin#rules">{t('წესების შეცვლა', 'Change the rules')}</Link></p>}
        </section>
      </div>
    </>
  );
}
