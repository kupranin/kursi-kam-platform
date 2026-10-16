import { useEffect, useMemo, useState } from 'react';
import BoardCoveragePanel from '../components/BoardCoveragePanel';
import LoadingLine from '../components/LoadingLine';
import { fmtDay, fmtMinutes, fmtRate, fmtTime, tbilisiDay } from '../lib/format';
import { useI18n } from '../lib/i18n';
import {
  MAX_COMP_DAYS,
  fmtAdvantage,
  fmtBps,
  fmtTetri,
  inclusiveDays,
  loadBoardReport,
  loadBoardSeries,
  missingCompetitiveness,
  presetRange,
  sortPairs,
  type BoardIncident,
  type BoardReport,
  type BoardSeries,
  type BoardSide,
  type RangePreset,
} from '../lib/competitiveness';

type SideFilter = 'both' | BoardSide;
type SortKey = 'start' | 'end' | 'duration' | 'pair' | 'side' | 'max' | 'avg';

const PRESETS: { id: RangePreset; ka: string; en: string }[] = [
  { id: 'today', ka: 'დღეს', en: 'Today' },
  { id: '7d', ka: '7 დღე', en: '7 days' },
  { id: 'week', ka: 'ეს კვირა', en: 'This week' },
  { id: 'prev', ka: 'წინა კვირა', en: 'Previous week' },
  { id: 'custom', ka: 'თარიღები', en: 'Dates' },
];

export default function Competitiveness() {
  const { t } = useI18n();
  const initial = presetRange('week');
  const [preset, setPreset] = useState<RangePreset>('week');
  const [customFrom, setCustomFrom] = useState(initial.from);
  const [customTo, setCustomTo] = useState(initial.to);
  const [pair, setPair] = useState('USD/GEL');
  const [side, setSide] = useState<SideFilter>('both');
  const [competitor, setCompetitor] = useState('all');
  const [report, setReport] = useState<BoardReport | null>(null);
  const [series, setSeries] = useState<BoardSeries | null>(null);
  const [seriesError, setSeriesError] = useState('');
  const [asOf, setAsOf] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('start');
  const [sortDesc, setSortDesc] = useState(true);

  const range = preset === 'custom'
    ? { from: customFrom, to: customTo }
    : presetRange(preset);
  const span = inclusiveDays(range.from, range.to);
  const tooLong = !range.from || !range.to || range.from > range.to || span > MAX_COMP_DAYS;

  useEffect(() => {
    if (tooLong) return;
    let live = true;
    setLoaded(false);
    setError('');
    setMissing(false);
    setSeries(null);
    setSeriesError('');
    setAsOf(Date.now());
    loadBoardReport(range.from, range.to, pair === 'all' ? null : pair)
      .then(async (next) => {
        if (!live) return;
        setReport(next);
        if (next.grain === 'fetches' || next.grain === 'hours') {
          try {
            const loadedSeries = await loadBoardSeries(range.from, range.to, next.grain);
            if (!live) return;
            setSeries(loadedSeries);
          } catch (err) {
            if (!live) return;
            setSeriesError(err instanceof Error ? err.message : String(err));
          }
        }
        if (live) setLoaded(true);
      })
      .catch((err: Error) => {
        if (!live) return;
        if (missingCompetitiveness(err.message)) {
          setReport(null);
          setMissing(true);
        } else {
          setError(err.message);
        }
        setLoaded(true);
      });
    return () => { live = false; };
  }, [range.from, range.to, pair, tooLong]);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    const remember = (keys: string[], label: string) => {
      const parts = label.split(', ').map((item) => item.trim()).filter(Boolean);
      if (parts.length === keys.length) keys.forEach((key, i) => map.set(key, parts[i]));
      else keys.forEach((key) => { if (!map.has(key)) map.set(key, key); });
    };
    for (const incident of report?.incidents ?? []) remember(incident.bestKeysAny, incident.bestNames);
    for (const point of report?.observations ?? []) remember(point.bestKeys, point.bestNames);
    return map;
  }, [report]);

  const competitors = useMemo(
    () => [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])),
    [names],
  );

  const pairOptions = useMemo(() => {
    const have = new Set(report?.pairs ?? []);
    if (pair !== 'all') have.add(pair);
    return sortPairs([...have]);
  }, [report, pair]);

  const shown = useMemo(() => {
    const rows = (report?.incidents ?? []).filter((incident) => {
      if (pair !== 'all' && incident.pair !== pair) return false;
      if (side !== 'both' && incident.side !== side) return false;
      if (competitor !== 'all' && !incident.bestKeysAny.includes(competitor)) return false;
      return true;
    });
    const dir = sortDesc ? -1 : 1;
    rows.sort((a, b) => dir * compareIncident(a, b, sortKey));
    return rows;
  }, [report, pair, side, competitor, sortKey, sortDesc]);

  useEffect(() => {
    if (selected && !shown.some((incident) => incident.id === selected)) setSelected(null);
  }, [shown, selected]);

  const detail = shown.find((incident) => incident.id === selected) ?? null;
  const noHistory = missing || report?.reason === 'single_generation' || report?.grain === 'none';
  const noRows = !!report && report.grain !== 'none' && report.pairs.length === 0 && report.incidents.length === 0;
  const noneWorse = !!report && report.grain !== 'none' && report.incidents.length === 0 && report.pairs.length > 0;

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDesc((value) => !value);
    else {
      setSortKey(key);
      setSortDesc(key === 'start' || key === 'end' || key === 'duration');
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('კონკურენტუნარიანობა', 'Competitiveness')}</h1>
          <p>{t(
            'საჯარო დაფა, როცა Kursi საუკეთესო კონკურენტზე უარესი იყო. ხაზინის კურსი აქ არ შედის.',
            'The public board, when Kursi was worse than the best competitor. The treasury rate is not included.',
          )}</p>
        </div>
      </div>

      <nav className="page-links" aria-label={t('პერიოდი', 'Period')}>
        {PRESETS.map((item) => (
          <button key={item.id} type="button" className={preset === item.id ? 'active' : ''} onClick={() => setPreset(item.id)}>
            {t(item.ka, item.en)}
          </button>
        ))}
      </nav>

      <div className="date-range">
        {preset === 'custom' && (
          <>
            <div className="field">
              <label htmlFor="comp-from">{t('თარიღიდან', 'From')}</label>
              <input id="comp-from" type="date" className="input" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="comp-to">{t('თარიღამდე', 'To')}</label>
              <input id="comp-to" type="date" className="input" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="comp-pair">{t('წყვილი', 'Pair')}</label>
          <select id="comp-pair" className="select" value={pair} onChange={(e) => setPair(e.target.value)}>
            <option value="all">{t('ყველა წყვილი', 'All pairs')}</option>
            {pairOptions.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="comp-side">{t('მიმართულება', 'Direction')}</label>
          <select id="comp-side" className="select" value={side} onChange={(e) => setSide(e.target.value as SideFilter)}>
            <option value="both">{t('ორივე', 'Both')}</option>
            <option value="buy">{t('ყიდვა', 'Buy')}</option>
            <option value="sell">{t('გაყიდვა', 'Sell')}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="comp-who">{t('კონკურენტი', 'Competitor')}</label>
          <select id="comp-who" className="select" value={competitor} onChange={(e) => setCompetitor(e.target.value)}>
            <option value="all">{t('ყველა', 'All')}</option>
            {competitors.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </div>
      </div>

      {tooLong && <p className="alert-box" role="alert">{t('პერიოდი 92 დღეზე გრძელია.', 'The range is longer than 92 days.')}</p>}
      {!tooLong && !loaded && <LoadingLine />}
      {!tooLong && loaded && missing && (
        <p className="empty">{t(
          'შენახული კურსებიდან წარსული პერიოდი ჯერ არ იკითხება. სია ცარიელია.',
          'Past periods cannot be read from the stored rates yet. The log stays blank.',
        )}</p>
      )}
      {!tooLong && loaded && error && <p className="alert-box" role="alert">{error}</p>}
      {!tooLong && loaded && !missing && !error && noHistory && (
        <p className="empty">{t(
          'შენახულ კურსებში წარსული წამოღებები არ არის. წინა პერიოდები ვერ აღდგება.',
          'The stored rates do not include past fetches. Earlier periods cannot be reconstructed.',
        )}</p>
      )}
      {!tooLong && loaded && !missing && !error && !noHistory && report && (
        <>
          {seriesError && <p className="alert-box" role="alert">{seriesError}</p>}
          {!seriesError && series && (report.grain === 'fetches' || report.grain === 'hours') && (
            <BoardCoveragePanel
              fetches={series.fetches}
              truncated={series.truncated}
              grain={report.grain}
              pair={pair}
              side={side}
              competitor={competitor}
              competitorLabel={names.get(competitor) ?? competitor}
              from={range.from}
              to={range.to}
              nowMs={asOf}
              preset={preset}
            />
          )}
          <p className="comp-note">{report?.grain === 'hours'
            ? t('საათობრივი მარცვალი: თითო თბილისის საათში ბოლო წამოღება რჩება. საათის შიგნით მოძრაობა არ ჩანს და საათი არ ივსება.', 'Hour grain: the last fetch in each Tbilisi hour is kept. A move inside the hour is not shown, and missing hours are not filled in.')
            : t('ანგარიში შენახული წამოღებებიდანაა. ერთი წამოღება ცალკე სტრიქონი არ არის.', 'Built from stored fetches. One fetch is not its own row.')}</p>
          <p className="comp-note">{t('მეხუთე ათწილადზე ტოლი კურსი ფრეა. 0 ფრეა. ზემოთ დაფა უკეთესია, ქვემოთ უარესი.', 'Rates that match at five decimals are a tie. 0 is a tie. Above, the board is better. Below, it is worse.')}</p>
          {(pair === 'RUB/GEL' || shown.some((incident) => incident.pair === 'RUB/GEL')) && (
            <p className="comp-note">{t('RUB/GEL არის ლარი 1 რუბლზე. 1-ზე მეტი კურსი აქ არ გადაიყვანება.', 'RUB/GEL is lari per 1 ruble. A rate of 1 or more is not converted here.')}</p>
          )}

          {noRows && <p className="empty">{t('ამ პერიოდში შენახული დაფა არ არის.', 'No stored board in this period.')}</p>}
          {noneWorse && <p className="empty">{t('ამ პერიოდში საჯარო დაფა საუკეთესო კონკურენტზე უარესი არ ყოფილა.', 'In this period the public board was not worse than the best competitor.')}</p>}
          {!noRows && !noneWorse && shown.length === 0 && (
            <p className="empty">{t('ამ ფილტრზე უარესი პერიოდი არ არის.', 'No worse period matches this filter.')}</p>
          )}

          {shown.length > 0 && (
            <section className="card flush">
              <div className="table-wrap">
                <table className="table comp-log">
                  <thead>
                    <tr>
                      <th scope="col">{t('თარიღი', 'Date')}</th>
                      <SortTh label={t('დასაწყისი', 'Start')} k="start" sortKey={sortKey} desc={sortDesc} onSort={toggleSort} />
                      <SortTh label={t('დასასრული', 'End')} k="end" sortKey={sortKey} desc={sortDesc} onSort={toggleSort} />
                      <SortTh label={t('ხანგრძლივობა', 'Duration')} k="duration" sortKey={sortKey} desc={sortDesc} onSort={toggleSort} />
                      <SortTh label={t('წყვილი', 'Pair')} k="pair" sortKey={sortKey} desc={sortDesc} onSort={toggleSort} />
                      <SortTh label={t('მიმართულება', 'Direction')} k="side" sortKey={sortKey} desc={sortDesc} onSort={toggleSort} />
                      <th scope="col" className="num">{t('კურსის დაფა', 'Kursi board')}</th>
                      <th scope="col">{t('კონკურენტი', 'Competitor')}</th>
                      <th scope="col" className="num">{t('კონკურენტის კურსი', 'Competitor rate')}</th>
                      <SortTh label={t('მაქს. სხვაობა', 'Max gap')} k="max" sortKey={sortKey} desc={sortDesc} onSort={toggleSort} num />
                      <SortTh label={t('საშუალო სხვაობა', 'Average gap')} k="avg" sortKey={sortKey} desc={sortDesc} onSort={toggleSort} num />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((incident) => (
                      <tr
                        key={incident.id}
                        className={incident.id === selected ? 'comp-on' : ''}
                        onClick={() => setSelected((current) => current === incident.id ? null : incident.id)}
                      >
                        <td>{fmtDay(tbilisiDay(incident.startedAt))}</td>
                        <td>{fmtTime(incident.startedAt)}</td>
                        <td>{incident.endedAt ? endLabel(incident) : ''}</td>
                        <td>{fmtMinutes(incident.durationMinutes)}</td>
                        <td>{incident.pair}</td>
                        <td>
                          {incident.side === 'buy' ? t('ყიდვა', 'Buy') : t('გაყიდვა', 'Sell')}
                          <div className="tiny muted">{incident.side === 'buy'
                            ? t('კლიენტი ყიდის საბაზისო ვალუტას', 'The client sells the base')
                            : t('კლიენტი ყიდულობს საბაზისო ვალუტას', 'The client buys the base')}</div>
                        </td>
                        <td className="num">{fmtRate(incident.kursiRate)}</td>
                        <td>{incident.bestNames}</td>
                        <td className="num">{fmtRate(incident.bestRate)}</td>
                        <td className="num">
                          {fmtAdvantage(incident.maxGap)}
                          {incident.tetri != null && <div className="tiny muted">{fmtTetri(incident.tetri)} {t('თეთრი', 'tetri')}</div>}
                        </td>
                        <td className="num">{fmtAdvantage(incident.avgGap)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {shown.length > 0 && (
            <p className="comp-note">{report?.grain === 'hours'
              ? t('ხანგრძლივობა შენახულ საათებს შორისაა. საშუალო სხვაობა საათებს თანაბრად თვლის. დასასრული, როცა დაფა აღარ არის უარესი, შემდეგი დაკვირვებაა, არა წუთი, როცა დაფა შეიცვალა.', 'Duration is between stored hours. The average gap weights each stored hour equally. When the board is no longer worse, the end is the next observation, not the minute the board changed.')
              : t('ხანგრძლივობა შენახულ წერტილებს შორისაა. საშუალო სხვაობა დროით არის აწონილი. დასასრული, როცა დაფა აღარ არის უარესი, შემდეგი დაკვირვებაა, არა წუთი, როცა დაფა შეიცვალა.', 'Duration is between stored points. The average gap is weighted by time. When the board is no longer worse, the end is the next observation, not the minute the board changed.')}</p>
          )}

          {detail && <IncidentDetail incident={detail} />}
        </>
      )}
    </>
  );
}

function endLabel(incident: BoardIncident): string {
  if (!incident.endedAt) return '';
  if (tbilisiDay(incident.endedAt) !== tbilisiDay(incident.startedAt)) {
    return fmtDay(tbilisiDay(incident.endedAt)) + ' ' + fmtTime(incident.endedAt);
  }
  return fmtTime(incident.endedAt);
}

function compareIncident(a: BoardIncident, b: BoardIncident, key: SortKey): number {
  if (key === 'end') return (a.endedAt ?? a.startedAt).localeCompare(b.endedAt ?? b.startedAt);
  if (key === 'duration') return a.durationMinutes - b.durationMinutes;
  if (key === 'pair') return a.pair.localeCompare(b.pair) || a.side.localeCompare(b.side);
  if (key === 'side') return a.side.localeCompare(b.side) || a.pair.localeCompare(b.pair);
  if (key === 'max') return (a.maxGap ?? 0) - (b.maxGap ?? 0);
  if (key === 'avg') return (a.avgGap ?? 0) - (b.avgGap ?? 0);
  return a.startedAt.localeCompare(b.startedAt);
}

function SortTh({ label, k, sortKey, desc, onSort, num = false }: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  desc: boolean;
  onSort: (key: SortKey) => void;
  num?: boolean;
}) {
  const on = sortKey === k;
  return (
    <th scope="col" className={num ? 'num' : undefined} aria-sort={on ? (desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="comp-sort" aria-pressed={on} onClick={() => onSort(k)}>{label}</button>
    </th>
  );
}

function IncidentDetail({ incident }: { incident: BoardIncident }) {
  const { t } = useI18n();
  const endNote = incident.endKind === 'open'
    ? t('ბოლო შენახულ წერტილზე დაფა კვლავ უარესია.', 'At the last stored point the board is still worse.')
    : incident.endKind === 'break'
      ? t('შედარება აქ წყდება: შემდეგი შენახული წერტილი შორსაა, ან კურსის დაფა არ არის. ხვრელი უარესად არ ითვლება.', 'The comparison stops here: the next stored point is too far, or the Kursi board rate is missing. A hole is not counted as worse.')
      : t('ბოლო არის პირველი დაკვირვება, როცა დაფა აღარ იყო უარესი. ცვლილება ამ წუთამდე მოხდა.', 'The end is the first observation that was no longer worse. The change happened before that minute.');
  return (
    <section className="card comp-detail" aria-label={incident.pair}>
      <h2>{incident.pair} · {incident.side === 'buy' ? t('ყიდვა', 'Buy') : t('გაყიდვა', 'Sell')}</h2>
      <p className="comp-note">{endNote}</p>
      <p>
        {t('დასაწყისში დაფა {rate}, საუკეთესო {name}.', 'At the start the board was {rate}, best {name}.', {
          rate: fmtRate(incident.startKursiRate),
          name: incident.startNames || '—',
        })}
        {' '}
        {t('ყველაზე დიდ სხვაობაზე დაფა {rate}.', 'At the widest gap the board was {rate}.', { rate: fmtRate(incident.kursiRate) })}
        {' '}
        {incident.endedAt
          ? t('ბოლოს დაფა {rate}, საუკეთესო {name}.', 'At the end the board was {rate}, best {name}.', {
            rate: fmtRate(incident.endKursiRate),
            name: incident.endNames || '—',
          })
          : t('დასასრული ჯერ არ არის.', 'There is no end yet.')}
      </p>
      {(incident.tetri != null || incident.bps != null) && (
        <p className="comp-note">
          {incident.tetri != null && t('მაქს. სხვაობა {n} თეთრი 1 საბაზისოზე.', 'Max gap {n} tetri per 1 base.', { n: fmtTetri(incident.tetri) })}
          {incident.tetri != null && incident.bps != null && ' '}
          {incident.bps != null && t('{n} ბაზისური პუნქტი.', '{n} basis points.', { n: fmtBps(incident.bps) })}
        </p>
      )}
      <div className="table-wrap comp-points">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('დრო', 'Time')}</th>
              <th scope="col" className="num">{t('კურსის დაფა', 'Kursi board')}</th>
              <th scope="col">{t('კონკურენტი', 'Competitor')}</th>
              <th scope="col" className="num">{t('კონკურენტის კურსი', 'Competitor rate')}</th>
              <th scope="col" className="num">{t('სხვაობა', 'Gap')}</th>
            </tr>
          </thead>
          <tbody>
            {incident.points.map((point, index) => (
              <tr key={point.at + ':' + index}>
                <td>{fmtDay(tbilisiDay(point.at))} {fmtTime(point.at)}</td>
                <td className="num">{fmtRate(point.kursiRate)}</td>
                <td>{point.bestNames}</td>
                <td className="num">{fmtRate(point.bestRate)}</td>
                <td className="num">{fmtAdvantage(point.advantage)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
