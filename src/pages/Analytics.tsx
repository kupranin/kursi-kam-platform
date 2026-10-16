import { useCallback, useEffect, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useViewAs } from '../lib/viewAs';
import { useI18n } from '../lib/i18n';
import { fmtMinutes, fmtShort, fmtWhole, monthOptions } from '../lib/format';
import { loadKamDeals, loadOwnKamDeals, summarizeKamDeals, type KamBreakdown } from '../lib/kamBreakdown';
import LoadingLine from '../components/LoadingLine';

interface DeskTimes {
  requests: number;
  answered: number;
  waiting_answer: number;
  first_response_minutes: number | null;
  agreed: number;
  written: number;
  waiting_write: number;
  write_minutes: number | null;
}

const EMPTY_TIMES: DeskTimes = {
  requests: 0, answered: 0, waiting_answer: 0, first_response_minutes: null,
  agreed: 0, written: 0, waiting_write: 0, write_minutes: null,
};

function asTimes(raw: DeskTimes | null): DeskTimes {
  if (!raw) return EMPTY_TIMES;
  const n = (v: number | string | null) => (v == null || v === '' ? null : Number(v));
  const c = (v: number | string | null) => Number(v ?? 0);
  return {
    requests: c(raw.requests),
    answered: c(raw.answered),
    waiting_answer: c(raw.waiting_answer),
    first_response_minutes: n(raw.first_response_minutes),
    agreed: c(raw.agreed),
    written: c(raw.written),
    waiting_write: c(raw.waiting_write),
    write_minutes: n(raw.write_minutes),
  };
}

function monthEnd(start: string): string {
  const [y, m] = start.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0));
  return last.toISOString().slice(0, 10);
}

export default function Analytics() {
  const { role } = useViewAs();
  if (role === 'kam') return <OwnKamAnalytics />;
  return <CompanyAnalytics />;
}

function OwnKamAnalytics() {
  const { profile } = useAuth();
  const { t } = useI18n();
  const [month, setMonth] = useState('all');
  const [kamStats, setKamStats] = useState<KamBreakdown | null>(null);
  const [kamLoading, setKamLoading] = useState(true);
  const [kamError, setKamError] = useState('');
  const months = monthOptions(18);

  useEffect(() => {
    if (!profile) return;
    let gone = false;
    setKamLoading(true);
    setKamError('');
    loadOwnKamDeals(month, profile.id)
      .then((rows) => { if (!gone) setKamStats(summarizeKamDeals(rows)); })
      .catch((err: unknown) => {
        if (!gone) {
          setKamStats(null);
          setKamError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => { if (!gone) setKamLoading(false); });
    return () => { gone = true; };
  }, [month, profile]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('ანალიტიკა', 'Analytics')}</h1>
          <p>{t(
            'მხოლოდ თქვენი მოთხოვნები: სულ, ღია, წარმატებული, დაკარგული, მიზეზები და მოთხოვნის ლარი. ეს დადასტურებული საბანკო ტრანზაქცია არ არის.',
            'Only your requests: total, open, successful, lost, reasons, and request lari. This is not a confirmed bank transaction.',
          )}</p>
        </div>
        <div className="row">
          <label className="sr-only" htmlFor="analytics-month">{t('პერიოდი', 'Period')}</label>
          <select id="analytics-month" className="select" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="all">{t('მთელი პერიოდი', 'Whole period')}</option>
            {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
      </div>
      <RequestStats
        stats={kamStats}
        loading={kamLoading}
        error={kamError}
        gelLabel={t('მოთხოვნის ლარი', 'Request lari')}
        note={t(
          'წარმატებული მოთხოვნის ლარის თანხა. ცარიელი ლარი არ ემატება. გაწერილი კურსი ან გადახდის ნიშანი მოთხოვნას წარმატებულად თვლის. ეს ბანკის ფაილის ბრუნვა არ არის.',
          'The lari amount on successful requests. A blank lari figure is not added. A written rate or a payment mark counts the request as successful. This is not bank-file turnover.',
        )}
      />
    </>
  );
}

function CompanyAnalytics() {
  const { t } = useI18n();
  const [month, setMonth] = useState('all');
  const [times, setTimes] = useState<DeskTimes>(EMPTY_TIMES);
  const [timesError, setTimesError] = useState('');
  const [kamStats, setKamStats] = useState<KamBreakdown | null>(null);
  const [kamLoading, setKamLoading] = useState(true);
  const [kamError, setKamError] = useState('');
  const months = monthOptions(18);

  const loadTimes = useCallback(async (which: string) => {
    setTimesError('');
    const args = which === 'all' ? {} : { p_from: which, p_to: monthEnd(which) };
    try {
      const data = await rpc<DeskTimes>('analytics_response_times', args);
      setTimes(asTimes(data));
    } catch (err) {
      setTimes(EMPTY_TIMES);
      setTimesError((err as Error).message);
    }
  }, []);

  useEffect(() => { void loadTimes(month); }, [loadTimes, month]);

  useEffect(() => {
    let gone = false;
    setKamLoading(true);
    setKamError('');
    loadKamDeals(month)
      .then((rows) => { if (!gone) setKamStats(summarizeKamDeals(rows)); })
      .catch((err: unknown) => {
        if (!gone) {
          setKamStats(null);
          setKamError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => { if (!gone) setKamLoading(false); });
    return () => { gone = true; };
  }, [month]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('ანალიტიკა', 'Analytics')}</h1>
          <p>{t(
            'მოთხოვნები KAM-ების მიხედვით: წარმატებული, დაკარგული, მიზეზები და ლარის თანხა მოთხოვნაზე. ქვემოთ ხაზინის დროცაა.',
            'Requests by KAM: successful, lost, reasons, and the lari amount on the request. Treasury time is below.',
          )}</p>
        </div>
        <div className="row">
          <label className="sr-only" htmlFor="analytics-month">{t('პერიოდი', 'Period')}</label>
          <select id="analytics-month" className="select" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="all">{t('მთელი პერიოდი', 'Whole period')}</option>
            {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
      </div>

      <RequestStats
        stats={kamStats}
        loading={kamLoading}
        error={kamError}
        gelLabel={t('ბრუნვა GEL', 'GEL turnover')}
        note={t(
          'სულ მოთხოვნა, მათ შორის წარმატებული და დაკარგული. ბრუნვა GEL არის წარმატებული მოთხოვნის ლარის თანხა. ცარიელი ლარი არ ემატება. დაკარგვის მიზეზები იმ სტრიქონებისაა, რომლებიც დაკარგულია. ეს არ არის ბანკის ფაილის ბრუნვა.',
          'Total requests, including successful and lost. GEL turnover is the lari amount on successful requests. A blank lari figure is not added. Lost reasons are counted on rows that are lost. This is not the bank-file turnover.',
        )}
        showKams
      />

      <section className="card" aria-labelledby="times-title">
        <h2 id="times-title">{t('ხაზინის დრო', 'Treasury time')}</h2>
        <p className="small" style={{ margin: '6px 0 16px', color: 'var(--ink-2)' }}>
          {t(
            'პირველი პასუხი: KAM-ის მოთხოვნიდან ხაზინის პირველ პასუხამდე. კურსის გაწერა: კლიენტის დათანხმებიდან იმ მომენტამდე, როცა ხაზინა კურსს გაწერილად მონიშნავს. თუ ჯერ არ არის გაწერილი, ეს დრო ცარიელია. ძველი ფაილის სტრიქონები აქ არ შედის.',
            'First response: from the KAM placing the request until treasury’s first answer. Rate writing: from the client agreeing until treasury marks the rate as written. If it is not written yet, that time stays empty. Rows from the old file are not included.',
          )}
        </p>
        {timesError && <p className="alert-box" role="alert">{timesError}</p>}
        {!timesError && (
          <div className="stats">
            <div className="stat">
              <div className="label">{t('პირველი პასუხი', 'First response')}</div>
              <div className="value">{times.answered ? fmtMinutes(times.first_response_minutes) : '—'}</div>
              <div className="small muted">{t('საშუალო. პასუხი აქვს', 'Average. Answered')} {fmtWhole(times.answered)} / {fmtWhole(times.requests)}. {t('ელოდება', 'Waiting')} {fmtWhole(times.waiting_answer)}.</div>
            </div>
            <div className="stat">
              <div className="label">{t('კურსის გაწერა', 'Rate writing')}</div>
              <div className="value">{times.written ? fmtMinutes(times.write_minutes) : '—'}</div>
              <div className="small muted">{t('საშუალო. გაწერილია', 'Average. Written')} {fmtWhole(times.written)} / {fmtWhole(times.agreed)}. {t('ელოდება გაწერას', 'Waiting to be written')} {fmtWhole(times.waiting_write)}.</div>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function RequestStats({
  stats,
  loading,
  error,
  gelLabel,
  note,
  showKams = false,
}: {
  stats: KamBreakdown | null;
  loading: boolean;
  error: string;
  gelLabel: string;
  note: string;
  showKams?: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      <section className="card" aria-labelledby="kam-requests-title">
        <h2 id="kam-requests-title">{showKams ? t('მოთხოვნები KAM-ების მიხედვით', 'Requests by KAM') : t('ჩემი მოთხოვნები', 'My requests')}</h2>
        <p className="small" style={{ margin: '6px 0 16px', color: 'var(--ink-2)' }}>{note}</p>
        {error && <p className="alert-box" role="alert">{error}</p>}
        {loading && !error && <LoadingLine />}
        {!loading && !error && stats && (
          <>
            <div className="stats">
              <div className="stat">
                <div className="label">{t('სულ მოთხოვნა', 'Total requests')}</div>
                <div className="value">{fmtWhole(stats.total)}</div>
                {(!showKams || stats.open > 0) && <div className="small muted">{t('ღია', 'Open')} {fmtWhole(stats.open)}</div>}
              </div>
              <div className="stat">
                <div className="label">{t('წარმატებული', 'Successful')}</div>
                <div className="value">{fmtWhole(stats.success)}</div>
              </div>
              <div className="stat">
                <div className="label">{t('დაკარგული', 'Lost')}</div>
                <div className="value">{fmtWhole(stats.lost)}</div>
              </div>
              <div className="stat">
                <div className="label">{gelLabel}</div>
                <div className="value">GEL {fmtShort(stats.gel)}</div>
              </div>
            </div>
            <h3 style={{ fontSize: 18, margin: '22px 0 8px' }}>{t('დაკარგვის მიზეზები', 'Lost reasons')}</h3>
            {!stats.reasons.length && <p className="empty">{t('დაკარგული მოთხოვნა არ არის.', 'No lost request.')}</p>}
            {stats.reasons.length > 0 && (
              <div className="table-wrap">
                <table className="table" style={{ minWidth: 420 }}>
                  <thead>
                    <tr>
                      <th>{t('მიზეზი', 'Reason')}</th>
                      <th className="num">{t('რაოდენობა', 'Count')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.reasons.map((reason) => (
                      <tr key={reason.label || 'none'}>
                        <th scope="row">{reason.label || t('მიზეზი არ არის', 'No reason')}</th>
                        <td className="num">{fmtWhole(reason.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      {showKams && !loading && !error && stats && stats.kams.length > 0 && (
        <section className="card flush" aria-labelledby="kam-table-title">
          <div className="card-head">
            <h2 id="kam-table-title">{t('თითო KAM', 'Each KAM')}</h2>
          </div>
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 880 }}>
              <thead>
                <tr>
                  <th>KAM</th>
                  <th className="num">{t('მოთხოვნები', 'Requests')}</th>
                  <th className="num">{t('წარმატებული', 'Successful')}</th>
                  <th className="num">{t('დაკარგული', 'Lost')}</th>
                  <th className="num">{gelLabel}</th>
                  <th>{t('დაკარგვის მიზეზები', 'Lost reasons')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.kams.map((kam) => (
                  <tr key={kam.name}>
                    <th scope="row">{kam.name}</th>
                    <td className="num">{fmtWhole(kam.total)}</td>
                    <td className="num">{fmtWhole(kam.success)}</td>
                    <td className="num">{fmtWhole(kam.lost)}</td>
                    <td className="num">GEL {fmtShort(kam.gel)}</td>
                    <td>
                      {kam.reasons.length
                        ? kam.reasons.map((reason) => `${reason.label || t('მიზეზი არ არის', 'No reason')} ${fmtWhole(reason.count)}`).join(', ')
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
