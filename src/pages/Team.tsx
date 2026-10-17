import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { monthPortfolioRows, requestKamRows } from '../lib/clientOwnership';
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
  const portfolioSummary = monthPortfolioRows(visibleSummary);
  const requestSummary = requestKamRows(visibleSummary);
  const portfolioClients = portfolioSummary.reduce((sum, row) => sum + Number(row.clients), 0);
  const requestTotals = requestSummary.reduce(
    (sum, row) => ({
      judged: sum.judged + Number(row.requests_judged),
      won: sum.won + Number(row.requests_won),
    }),
    { judged: 0, won: 0 },
  );
  const monthLabel = months.find((m) => m.value === month)?.label ?? month;

  function exportCsv() {
    downloadCsv(`kam-month-portfolio-${month.slice(0, 7)}.csv`, [
      ['კლიენტის ID', 'კლიენტი', 'თვის პორტფელის KAM', 'მოთხოვნები ფანჯარაში'],
      ...visiblePortfolio.map((p) => [p.client_id, p.client_name, p.owner_name, p.requests_in_window]),
    ]);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{isKam ? t('ჩემი ციფრები', 'My numbers') : t('გუნდი', 'Team')}</h1>
          <p>{isKam
            ? t('თვის პორტფელის კლიენტები და მოთხოვნის შედეგი ცალკეა. საბანკო ფაილის ბრუნვა აქ არ ჩანს.', 'Month portfolio clients and request results are separate. Bank-file turnover is not shown here.')
            : t('KAM-ების თვის პორტფელი და მოთხოვნის შედეგი ცალკეა. საბანკო ფაილის ბრუნვა აქ არ ჩანს.', 'Each KAM’s month portfolio and request results are separate. Bank-file turnover is not shown here.')}</p>
        </div>
        <div className="row">
          <label className="sr-only" htmlFor="month">თვე</label>
          <select id="month" className="select" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button type="button" className="btn" onClick={exportCsv} disabled={!visiblePortfolio.length}><IconDownload />{t('თვის პორტფელის ჩამოტვირთვა', 'Download the month portfolio')}</button>
        </div>
      </div>

      {error && <p className="alert-box" role="alert">{error}</p>}

      <div className="stats big">
        <div className="stat">
          <div className="label">{t('თვის პორტფელის კლიენტები', 'Month portfolio clients')}</div>
          <div className="value">{fmtWhole(portfolioClients)}</div>
          <div className="small muted">{t('თვის ფანჯრის კლიენტები. ეს მოთხოვნის შედეგი არ არის.', 'Clients in the month window. This is not a request result.')}</div>
        </div>
        <div className="stat">
          <div className="label">{t('მოთხოვნა, რომელიც გავიდა', 'Requests that went through')}</div>
          <div className="value">{requestTotals.judged ? `${fmtWhole(requestTotals.won)} / ${fmtWhole(requestTotals.judged)}` : '—'}</div>
          <div className="small muted">{t('მოთხოვნის KAM-ის შედეგი. თვის კლიენტების რაოდენობა არ არის.', 'The request KAM’s result. Not the month’s client count.')}</div>
        </div>
      </div>

      <section className="card flush" aria-labelledby="portfolio-title">
        <div className="card-head">
          <h2 id="portfolio-title">{t('თვის პორტფელის კლიენტები', 'Month portfolio clients')}, {monthLabel}</h2>
        </div>
        <p className="small" style={{ margin: '0 16px 8px', color: 'var(--ink-2)' }}>
          {t(
            'კლიენტი, რომელიც ამ თვის ფანჯარაში ამ KAM-ზეა. ეს ყველა დროის კლიენტის მფლობელი არ არის და არც დაფიქსირებული მოთხოვნების რაოდენობაა.',
            'A client held by this KAM in this month’s window. This is not the all-time client owner and it is not how many requests were logged.',
          )}
        </p>
        {loading && <LoadingLine />}
        {!loading && !portfolioSummary.length && <p className="empty">{t('ამ თვეში პორტფელის კლიენტი არ არის.', 'No portfolio client this month.')}</p>}
        {!loading && portfolioSummary.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 480 }}>
              <thead>
                <tr>
                  <th>{t('თვის პორტფელის KAM', 'Month-portfolio KAM')}</th>
                  <th className="num">{t('კლიენტები', 'Clients')}</th>
                </tr>
              </thead>
              <tbody>
                {portfolioSummary.map((r) => (
                  <tr key={r.kam_id}>
                    <th scope="row">{r.kam_name}</th>
                    <td className="num">{fmtWhole(r.clients)}</td>
                  </tr>
                ))}
                {portfolioSummary.length > 1 && (
                  <tr>
                    <th scope="row" className="strong">{t('სულ', 'Total')}</th>
                    <td className="num strong">{fmtWhole(portfolioClients)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card flush" aria-labelledby="score-title" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 id="score-title">{t('მოთხოვნის KAM-ის შედეგი', 'Request KAM results')}, {monthLabel}</h2>
        </div>
        <p className="small" style={{ margin: '0 16px 8px', color: 'var(--ink-2)' }}>
          {t(
            'მოგებული და განხილული მოთხოვნა იმ KAM-ზეა, ვინც მოთხოვნა დააფიქსირა. შედეგი ეკრანის კლასს მიჰყვება. ეს თვის კლიენტების რაოდენობა არ არის.',
            'Won and judged requests stay with the KAM who logged the request. The result follows the display class. This is not the month’s client count.',
          )}
        </p>
        {loading && <LoadingLine />}
        {!loading && !requestSummary.length && <p className="empty">{t('ამ თვეში მოთხოვნა ჯერ არ არის.', 'No request this month yet.')}</p>}
        {!loading && requestSummary.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 640 }}>
              <thead>
                <tr>
                  <th>{t('მოთხოვნის KAM', 'Request KAM')}</th>
                  <th className="num">{t('მოთხოვნა, რომელიც გავიდა', 'Requests that went through')}</th>
                </tr>
              </thead>
              <tbody>
                {requestSummary.map((r) => (
                  <tr key={r.kam_id}>
                    <th scope="row">{r.kam_name}</th>
                    <td className="num">{r.requests_judged ? `${r.requests_won} / ${r.requests_judged} (${r.win_rate_pct}%)` : ''}</td>
                  </tr>
                ))}
                {requestSummary.length > 1 && (
                  <tr>
                    <th scope="row" className="strong">{t('სულ', 'Total')}</th>
                    <td className="num strong">{requestTotals.judged ? `${requestTotals.won} / ${requestTotals.judged}` : ''}</td>
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
            <div><dt className="strong">{t('თვის პორტფელის კლიენტები', 'Month portfolio clients')}</dt><dd style={{ margin: '2px 0 0' }}>{t('თვის ფანჯარა თვის პირველი დღიდან თვის ბოლომდეა, პლუს ზღვრის დღეები. ფრე ბოლო მოთხოვნაზე გადის. ეს ყველა დროის კლიენტის მფლობელი არ არის.', 'The month window runs from the 1st through month end, plus the grace days. A tie goes to the latest request. This is not the all-time client owner.')}</dd></div>
            <div><dt className="strong">{t('მოთხოვნა, რომელიც გავიდა', 'Requests that went through')}</dt><dd style={{ margin: '2px 0 0' }}>{t('მოთხოვნის KAM-ის შედეგი ეკრანის კლასს მიჰყვება. ეს თვის კლიენტების რაოდენობა არ არის და არც ატვირთული საბანკო ფაილის ბრუნვაა.', 'The request KAM’s result follows the display class. This is not the month’s client count and it is not uploaded bank-file turnover.')}</dd></div>
          </dl>
          {role === 'admin' && <p className="small" style={{ marginTop: 16 }}><Link to="/admin#rules">{t('წესების შეცვლა', 'Change the rules')}</Link></p>}
        </section>
      </div>
    </>
  );
}
