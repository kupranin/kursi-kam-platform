import { useCallback, useEffect, useMemo, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useViewAs } from '../lib/viewAs';
import { useI18n } from '../lib/i18n';
import { fmtMinutes, fmtShort, fmtWhole, monthOptions } from '../lib/format';
import { loadRequestKpis, type KamKpi, type RequestKpis } from '../lib/requestKpis';
import KamMonthPortfolio from '../components/KamMonthPortfolio';
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

const PIE_COLORS = ['#5F245C', '#B185DD', '#F2A65A', '#07624D', '#8A3414', '#FFC639', '#4E3A55', '#A3261A'];

type SortKey = 'name' | 'total' | 'won' | 'wonPct' | 'lost' | 'lostPct' | 'open' | 'abs' | 'wonAbs' | 'lostAbs';

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

function pct(part: number, total: number): string {
  if (total <= 0) return '—';
  return (Math.round((part / total) * 1000) / 10).toFixed(1) + '%';
}

function gelText(value: number | null): string {
  if (value == null) return '—';
  return 'GEL ' + fmtShort(value);
}

function absExtra(
  unavailable: number,
  pending: number,
  t: (ka: string, en: string, vars?: { n: string }) => string,
): string {
  const parts: string[] = [];
  if (pending > 0) parts.push(t('ელოდება ადმინს {n}', 'Waiting for an admin {n}', { n: fmtWhole(pending) }));
  if (unavailable > 0) parts.push(t('არ არის {n}', 'Unavailable {n}', { n: fmtWhole(unavailable) }));
  return parts.join(' · ');
}

export default function Analytics() {
  const { role, realRole } = useViewAs();
  if (role === 'kam') return <OwnKamAnalytics />;
  const canFilter = realRole === 'admin' || realRole === 'manager' || role === 'admin' || role === 'manager';
  return <CompanyAnalytics canFilter={canFilter} />;
}

function OwnKamAnalytics() {
  const { profile } = useAuth();
  const { t } = useI18n();
  const [month, setMonth] = useState('all');
  const [stats, setStats] = useState<RequestKpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const months = monthOptions(18);

  useEffect(() => {
    if (!profile) return;
    let gone = false;
    setLoading(true);
    setError('');
    loadRequestKpis(month, profile.id)
      .then((next) => { if (!gone) setStats(next); })
      .catch((err: unknown) => {
        if (!gone) {
          setStats(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => { if (!gone) setLoading(false); });
    return () => { gone = true; };
  }, [month, profile]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('ანალიტიკა', 'Analytics')}</h1>
          <p>{t(
            'მხოლოდ თქვენი მოთხოვნები. მოგებული მხოლოდ გაწერილი კურსია. დაკარგული ცალკეა. ღია არც ერთია. მოთხოვნების ABS GEL მიღებული თანხის ლარის ექვივალენტია, დადასტურებული საბანკო ბრუნვა არ არის.',
            'Only your requests. Won is only a written rate. Lost is separate. Open is neither. Request ABS GEL is the lari equivalent of the received amount, not confirmed bank turnover.',
          )}</p>
        </div>
        <PeriodSelect month={month} months={months} onChange={setMonth} />
      </div>
      <RequestKpiCards stats={stats} loading={loading} error={error} showBankGap />
    </>
  );
}

function CompanyAnalytics({ canFilter }: { canFilter: boolean }) {
  const { role } = useViewAs();
  const { t } = useI18n();
  const seePortfolios = role === 'admin' || role === 'manager';
  const [month, setMonth] = useState('all');
  const [kamId, setKamId] = useState('');
  const [times, setTimes] = useState<DeskTimes>(EMPTY_TIMES);
  const [timesError, setTimesError] = useState('');
  const [stats, setStats] = useState<RequestKpis | null>(null);
  const [directory, setDirectory] = useState<KamKpi[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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
    setLoading(true);
    setError('');
    loadRequestKpis(month, kamId || null)
      .then((next) => {
        if (!gone) {
          setStats(next);
          if (!kamId) setDirectory(next.kams.filter((kam) => kam.kamId));
        }
      })
      .catch((err: unknown) => {
        if (!gone) {
          setStats(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => { if (!gone) setLoading(false); });
    return () => { gone = true; };
  }, [month, kamId]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('ანალიტიკა', 'Analytics')}</h1>
          <p>{seePortfolios
            ? t(
              'ჯერ KAM-ების თვის პორტფელია: თვის კლიენტები და მოთხოვნის შედეგი ცალკეა. შემდეგ მოთხოვნები KAM-ების მიხედვით. მოგებული მხოლოდ გაწერილი კურსია. გადახდის ნიშანი და ტრანზაქცია მოგებაში არ შედის. მოთხოვნების ABS GEL მიღებული თანხის ლარის ექვივალენტია. ბოლოს ხაზინის დროა.',
              'KAM month portfolios come first: month clients and request results are separate. Then requests by KAM. Won is only a written rate. A payment mark and a transaction are not wins. Request ABS GEL is the lari equivalent of the received amount. Treasury time is last.',
            )
            : t(
              'მოთხოვნები KAM-ების მიხედვით. მოგებული მხოლოდ გაწერილი კურსია. გადახდის ნიშანი და ტრანზაქცია მოგებაში არ შედის. მოთხოვნების ABS GEL მიღებული თანხის ლარის ექვივალენტია. ქვემოთ ხაზინის დროცაა.',
              'Requests by KAM. Won is only a written rate. A payment mark and a transaction are not wins. Request ABS GEL is the lari equivalent of the received amount. Treasury time is below.',
            )}</p>
        </div>
        <div className="row">
          <PeriodSelect month={month} months={months} onChange={(value) => { setMonth(value); setKamId(''); }} />
          {canFilter && (
            <label className="field" style={{ margin: 0 }}>
              <span className="sr-only">{t('KAM', 'KAM')}</span>
              <select className="select" style={{ width: 'auto' }} value={kamId} onChange={(e) => setKamId(e.target.value)}>
                <option value="">{t('ყველა KAM', 'Every KAM')}</option>
                {directory.map((kam) => (
                  <option key={kam.kamId ?? kam.state} value={kam.kamId ?? ''}>
                    {kamLabel(kam, t)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {seePortfolios && <KamMonthPortfolio />}

      <RequestKpiCards stats={stats} loading={loading} error={error} showKams />

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

function PeriodSelect({
  month,
  months,
  onChange,
}: {
  month: string;
  months: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <label className="sr-only" htmlFor="analytics-month">{t('პერიოდი', 'Period')}</label>
      <select id="analytics-month" className="select" style={{ width: 'auto' }} value={month} onChange={(e) => onChange(e.target.value)}>
        <option value="all">{t('მთელი პერიოდი', 'Whole period')}</option>
        {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
    </div>
  );
}

function kamLabel(kam: KamKpi, t: (ka: string, en: string) => string): string {
  if (kam.state === 'unassigned') return t('მიუწერელი', 'Unassigned');
  if (kam.state === 'deleted') return t('წაშლილი პროფილი', 'Deleted profile');
  return kam.name || t('სახელი არ არის', 'No name');
}

function RequestKpiCards({
  stats,
  loading,
  error,
  showKams = false,
  showBankGap = false,
}: {
  stats: RequestKpis | null;
  loading: boolean;
  error: string;
  showKams?: boolean;
  showBankGap?: boolean;
}) {
  const { t } = useI18n();
  const note = t(
    'მოგებული მხოლოდ გაწერილი კურსია. გადახდის ნიშანი, ტრანზაქცია და ძველი ფაილის სტატუსი არც მოგებაა და არც დანაკარგი. დაკარგული: დანაკარგის ნიშანი, მიზეზი, ან კლიენტის თუ ხაზინის უარი. ღია დანარჩენია. პროცენტის მნიშვნელი ამ პერიოდის ყველა მოთხოვნაა. მოთხოვნების ABS GEL მიღებული თანხის ლარის ექვივალენტია, დადასტურებული საბანკო ბრუნვა არ არის. სადაც ABS GEL არ არის, ის ჯამში ნულად არ შედის. როცა ახალი მოთხოვნა ადმინს ელოდება, ის ცალკე ჩანს და ნულად არ იკრიბება.',
    'Won is only a written rate. A payment mark, a transaction, and a legacy file status are neither a win nor a loss. Lost is a loss mark, a reason, or a client or treasury decline. Open is the rest. The percentage denominator is every request in this period. Request ABS GEL is the lari equivalent of the received amount, not confirmed bank turnover. A request with no ABS GEL is not added as zero. A new request waiting for an admin is shown separately and is not added as zero.',
  );

  return (
    <section className="card" aria-labelledby="kam-requests-title">
      <h2 id="kam-requests-title">{showKams ? t('მოთხოვნები KAM-ების მიხედვით', 'Requests by KAM') : t('ჩემი მოთხოვნები', 'My requests')}</h2>
      <p className="small" style={{ margin: '6px 0 16px', color: 'var(--ink-2)' }}>{note}</p>
      {error && <p className="alert-box" role="alert">{error}</p>}
      {loading && !error && <LoadingLine />}
      {!loading && !error && stats && (
        <>
          <div className="stats big">
            <Stat label={t('სულ მოთხოვნა', 'Total requests')} value={fmtWhole(stats.total)} hint={t('მნიშვნელი', 'Denominator')} />
            <Stat label={t('მოგებული', 'Won')} value={fmtWhole(stats.won)} hint={`${pct(stats.won, stats.total)} · ${fmtWhole(stats.won)} / ${fmtWhole(stats.total)}`} />
            <Stat label={t('დაკარგული', 'Lost')} value={fmtWhole(stats.lost)} hint={`${pct(stats.lost, stats.total)} · ${fmtWhole(stats.lost)} / ${fmtWhole(stats.total)}`} />
            <Stat label={t('ღია', 'Open')} value={fmtWhole(stats.open)} hint={`${pct(stats.open, stats.total)} · ${fmtWhole(stats.open)} / ${fmtWhole(stats.total)}`} />
            <Stat
              label={t('მოთხოვნების ABS GEL', 'Request ABS GEL')}
              value={stats.absGel == null ? '—' : 'GEL ' + fmtShort(stats.absGel)}
              hint={absExtra(stats.absUnavailable, stats.absPending, t)
                || t('მიღებული თანხის ლარის ექვივალენტი. საბანკო ბრუნვა არ არის.', 'Lari equivalent of the received amount. Not bank turnover.')}
            />
            <Stat
              label={t('მოგებული ABS GEL', 'Won ABS GEL')}
              value={stats.wonAbsGel == null ? '—' : 'GEL ' + fmtShort(stats.wonAbsGel)}
              hint={absExtra(stats.wonAbsUnavailable, stats.wonAbsPending, t)
                || t('მხოლოდ მოგებული მოთხოვნები', 'Won requests only')}
            />
            <Stat
              label={t('დაკარგული ABS GEL', 'Lost ABS GEL')}
              value={stats.lostAbsGel == null ? '—' : 'GEL ' + fmtShort(stats.lostAbsGel)}
              hint={absExtra(stats.lostAbsUnavailable, stats.lostAbsPending, t)
                || t('მხოლოდ დაკარგული მოთხოვნები', 'Lost requests only')}
            />
            {showBankGap && (
              <Stat label={t('დადასტურებული საბანკო ბრუნვა', 'Confirmed bank turnover')} value="—" hint={t('ჯერ არ არის', 'Not available yet')} />
            )}
          </div>
          <LostReasons stats={stats} />
          {showKams && <KamTable stats={stats} />}
        </>
      )}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="small muted">{hint}</div>
    </div>
  );
}

function LostReasons({ stats }: { stats: RequestKpis }) {
  const { t } = useI18n();
  const slices = stats.reasons.filter((reason) => reason.count > 0);
  return (
    <>
      <h3 style={{ fontSize: 18, margin: '22px 0 8px' }}>{t('დაკარგვის მიზეზები', 'Lost reasons')}</h3>
      {!slices.length && <p className="empty">{t('დაკარგული მოთხოვნა არ არის.', 'No lost request.')}</p>}
      {slices.length > 0 && (
        <div className="row" style={{ alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <ReasonPie reasons={slices} lost={stats.lost} />
          <div className="table-wrap" style={{ flex: '1 1 420px' }}>
            <table className="table" style={{ minWidth: 520 }}>
              <thead>
                <tr>
                  <th>{t('მიზეზი', 'Reason')}</th>
                  <th className="num">{t('რაოდენობა', 'Count')}</th>
                  <th className="num">{t('დაკარგულის %', '% of lost')}</th>
                  <th className="num">{t('დაკარგული ABS GEL', 'Lost ABS GEL')}</th>
                </tr>
              </thead>
              <tbody>
                {slices.map((reason) => (
                  <tr key={reason.label || 'none'}>
                    <th scope="row">{reason.label || t('მიზეზი არ არის', 'No reason')}</th>
                    <td className="num">{fmtWhole(reason.count)}</td>
                    <td className="num">{pct(reason.count, stats.lost)} · {fmtWhole(reason.count)} / {fmtWhole(stats.lost)}</td>
                    <td className="num">
                      {reason.lostAbsGel == null ? '—' : 'GEL ' + fmtShort(reason.lostAbsGel)}
                      {absExtra(reason.absUnavailable, reason.absPending, t) ? ` · ${absExtra(reason.absUnavailable, reason.absPending, t)}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function ReasonPie({ reasons, lost }: { reasons: { label: string; count: number }[]; lost: number }) {
  const { t } = useI18n();
  const total = reasons.reduce((sum, reason) => sum + reason.count, 0);
  if (total <= 0) return null;
  let cursor = 0;
  const stops = reasons.map((reason, index) => {
    const start = cursor;
    cursor += reason.count / total;
    return `${PIE_COLORS[index % PIE_COLORS.length]} ${start * 100}% ${cursor * 100}%`;
  });
  return (
    <div style={{ width: 180, textAlign: 'center' }} aria-hidden="true">
      <div style={{ position: 'relative', width: 160, height: 160, margin: '0 auto' }}>
        <div style={{ width: 160, height: 160, borderRadius: '50%', background: `conic-gradient(${stops.join(', ')})` }} />
        <div style={{ position: 'absolute', inset: 46, borderRadius: '50%', background: '#fff' }} />
      </div>
      <div className="small muted" style={{ marginTop: 8 }}>{t('დაკარგული', 'Lost')} {fmtWhole(lost)}</div>
    </div>
  );
}

function KamTable({ stats }: { stats: RequestKpis }) {
  const { t } = useI18n();
  const [sort, setSort] = useState<SortKey>('total');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');

  function toggle(key: SortKey) {
    if (sort === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(key);
      setDir(key === 'name' ? 'asc' : 'desc');
    }
  }

  const rows = useMemo(() => {
    const value = (kam: KamKpi): number | string => {
      if (sort === 'name') return kamLabel(kam, t);
      if (sort === 'total') return kam.total;
      if (sort === 'won') return kam.won;
      if (sort === 'wonPct') return kam.total ? kam.won / kam.total : -1;
      if (sort === 'lost') return kam.lost;
      if (sort === 'lostPct') return kam.total ? kam.lost / kam.total : -1;
      if (sort === 'open') return kam.open;
      if (sort === 'abs') return kam.absGel ?? -1;
      if (sort === 'wonAbs') return kam.wonAbsGel ?? -1;
      return kam.lostAbsGel ?? -1;
    };
    return [...stats.kams].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      const cmp = typeof av === 'string' || typeof bv === 'string'
        ? String(av).localeCompare(String(bv), 'ka')
        : av - bv;
      return dir === 'asc' ? cmp : -cmp;
    });
  }, [stats.kams, sort, dir, t]);

  function head(key: SortKey, label: string) {
    return (
      <th className={key === 'name' ? '' : 'num'}>
        <button type="button" className="link" onClick={() => toggle(key)}>{label}</button>
      </th>
    );
  }

  return (
    <div style={{ marginTop: 22 }}>
      <div className="card-head" style={{ paddingLeft: 0 }}>
        <h3 id="kam-table-title" style={{ fontSize: 18, margin: 0 }}>{t('თითო KAM', 'Each KAM')}</h3>
      </div>
      <div className="table-wrap">
        <table className="table" style={{ minWidth: 980 }}>
          <thead>
            <tr>
              {head('name', 'KAM')}
              {head('total', t('სულ', 'Total'))}
              {head('won', t('მოგებული', 'Won'))}
              {head('wonPct', t('მოგებული %', 'Won %'))}
              {head('lost', t('დაკარგული', 'Lost'))}
              {head('lostPct', t('დაკარგული %', 'Lost %'))}
              {head('open', t('ღია', 'Open'))}
              {head('abs', t('მოთხოვნების ABS GEL', 'Request ABS GEL'))}
              {head('wonAbs', t('მოგებული ABS GEL', 'Won ABS GEL'))}
              {head('lostAbs', t('დაკარგული ABS GEL', 'Lost ABS GEL'))}
            </tr>
          </thead>
          <tbody>
            {rows.map((kam) => (
              <tr key={(kam.kamId ?? kam.state) + (kam.name ?? '')}>
                <th scope="row">{kamLabel(kam, t)}</th>
                <td className="num">{fmtWhole(kam.total)}</td>
                <td className="num">{fmtWhole(kam.won)}</td>
                <td className="num">{pct(kam.won, kam.total)}</td>
                <td className="num">{fmtWhole(kam.lost)}</td>
                <td className="num">{pct(kam.lost, kam.total)}</td>
                <td className="num">{fmtWhole(kam.open)}</td>
                <td className="num">{gelText(kam.absGel)}{absExtra(kam.absUnavailable, kam.absPending, t) ? ` · ${absExtra(kam.absUnavailable, kam.absPending, t)}` : ''}</td>
                <td className="num">{kam.wonAbsGel == null ? '—' : 'GEL ' + fmtShort(kam.wonAbsGel)}</td>
                <td className="num">{kam.lostAbsGel == null ? '—' : 'GEL ' + fmtShort(kam.lostAbsGel)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
