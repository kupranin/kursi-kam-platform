import { useMemo, useState } from 'react';
import {
  coverSelection,
  daySlices,
  describeCoverage,
  formatPct,
  type BoardFetch,
  type CoverSegment,
  type CoverStatus,
  type SideCoverage,
} from '../lib/boardCoverage';
import { fmtAdvantage, fmtTetri, type BoardSide, type RangePreset } from '../lib/competitiveness';
import { fmtDay, fmtRate, fmtTime, tbilisiDayStart } from '../lib/format';
import { useI18n } from '../lib/i18n';

type SideFilter = 'both' | BoardSide;

export default function BoardCoveragePanel({
  fetches,
  truncated,
  grain,
  pair,
  side,
  competitor,
  competitorLabel,
  from,
  to,
  nowMs,
  preset,
}: {
  fetches: readonly BoardFetch[];
  truncated: boolean;
  grain: 'fetches' | 'hours';
  pair: string;
  side: SideFilter;
  competitor: string;
  competitorLabel: string;
  from: string;
  to: string;
  nowMs: number;
  preset: RangePreset;
}) {
  const { t, lang } = useI18n();
  const rows = useMemo(() => coverSelection({
    fetches,
    pair: pair === 'all' ? null : pair,
    sides: side === 'both' ? ['buy', 'sell'] : [side],
    from,
    to,
    nowMs,
    competitor: competitor === 'all' ? null : competitor,
  }), [fetches, pair, side, from, to, nowMs, competitor]);

  const period = periodPhrase(preset, from, to);
  const selected = competitor === 'all' ? null : (competitorLabel || competitor);

  if (truncated) {
    return (
      <section className="card comp-summary">
        <p>{t(
          'შენახული დაფა ბოლომდე ვერ წაიკითხა. პროცენტს არ ვწერ.',
          'The stored board was not fully read. No percentage is shown.',
        )}</p>
      </section>
    );
  }

  if (!rows.length) {
    return (
      <section className="card comp-summary">
        <p>{t(
          'ვარგისი შედარება არ არის. კურსის დაფა ან კონკურენტი აკლია, ან კურსი 45 წუთზე ძველია.',
          'There is no valid comparison. The Kursi board or a competitor is missing, or the rate is older than 45 minutes.',
        )}</p>
      </section>
    );
  }

  return (
    <>
      <section className="card comp-summary">
        {rows.map((cov) => {
          const text = describeCoverage(
            cov,
            period.ka,
            period.en,
            cov.side === 'buy' ? 'ყიდვაზე' : 'გაყიდვაზე',
            cov.side === 'buy' ? 'on buy' : 'on sell',
            selected,
            false,
          );
          return <p key={cov.pair + cov.side}>{t(text.ka, text.en)}</p>;
        })}
        {selected && <p className="comp-note">{t(
          'ზედა პროცენტი და ზოლი მხოლოდ {name}-ს ადარებს. სია თითო კონკურენტს ცალ-ცალკე აჩვენებს.',
          'The percentage and the timeline compare only with {name}. The list still shows each competitor on its own.',
          { name: selected },
        )}</p>}
        <details className="comp-method">
          <summary>{t('როგორ ითვლება', 'How this is counted')}</summary>
          <p>{t(
            'პროცენტი გასული დროა, არა სტრიქონების რაოდენობა. კურსი ვარგისია 45 წუთი: წამოღება 30 წუთში ერთხელაა, ერთი წამოღების წყაროები 10 წუთში ერთ კლასტერად ითვლება, და 45 წუთი ამ ინტერვალს და კლასტერს ფარავს. უფრო ძველი კურსი აღარ ითვლება. ხვრელი არ ივსება და ხაზი ხვრელზე არ გადის.',
            'A percentage is elapsed time, not a count of rows. A rate stays valid for 45 minutes: fetches run every 30 minutes, sources in one fetch count as one cluster when they land within 10 minutes, and 45 minutes covers that interval and the cluster. An older rate is not used. A gap is not filled in, and no line is drawn across it.',
          )}</p>
          <p>{t(
            'ყიდვა: კლიენტი ყიდის საბაზისო ვალუტას, მაღალი ყიდვა უკეთესია. გაყიდვა: კლიენტი ყიდულობს საბაზისო ვალუტას, დაბალი გაყიდვა უკეთესია. მეხუთე ათწილადზე ტოლი სხვაობა ფრეა და კონკურენტულია. ყიდვა და გაყიდვა ერთ პროცენტში არ ერთიანდება.',
            'Buy: the client sells the base, so a higher buy is better. Sell: the client buys the base, so a lower sell is better. A gap that is zero at five decimals is a tie, and a tie is competitive. Buy and sell are not combined into one percentage.',
          )}</p>
          <p>{t(
            'ყველა კონკურენტი ნიშნავს იმ მომენტის საუკეთესო ვარგის კონკურენტს. ერთი კონკურენტი ნიშნავს მხოლოდ მას. კონკურენტების პროცენტები ერთმანეთს შეიძლება გადაეფაროს და 100-ს არ ჯამდება. საერთო დრო ორჯერ არ ითვლება. კონკურენტული, არაკონკურენტული და გამოტოვებული დრო შერჩეულ პერიოდს უდრის. შედარებად დროში პირველი ორი 100%-ია. კურსის დაფის ან კონკურენტის არქონა კონკურენტული არ არის. ეს საჯარო დაფაა, ხაზინის კურსი არა.',
            'All competitors means the best valid competitor at that moment. One competitor means only that competitor. Competitor percentages may overlap and do not need to add to 100%. Overall time is not counted twice. Competitive, noncompetitive, and unavailable time add up to the selected period. Of comparable time, the first two add to 100%. A missing Kursi rate or a missing competitor is not competitive. This is the public board, not the treasury rate.',
          )}</p>
          {grain === 'hours' && <p>{t(
            'შენახული მარცვალი საათობრივია. საათი მაინც 45 წუთში ძველდება და გამოტოვებული წუთი არ ივსება.',
            'The stored grain is hourly. An hour still goes stale after 45 minutes, and a missing minute is not filled in.',
          )}</p>}
        </details>
      </section>

      {rows.map((cov) => (
        <CoverageBlock
          key={cov.pair + '|' + cov.side}
          cov={cov}
          lang={lang}
          selected={selected}
          selectedKey={competitor === 'all' ? null : competitor}
        />
      ))}
    </>
  );
}

function periodPhrase(preset: RangePreset, from: string, to: string): { ka: string; en: string } {
  if (preset === 'today') return { ka: 'დღეს', en: 'Today' };
  if (preset === '7d') return { ka: 'ბოლო 7 დღეში', en: 'In the last 7 days' };
  if (preset === 'week') return { ka: 'ამ კვირაში', en: 'This week' };
  if (preset === 'prev') return { ka: 'წინა კვირაში', en: 'In the previous week' };
  return { ka: `${from}–${to} შუალედში`, en: `From ${from} to ${to}` };
}

function fmtSpan(ms: number, t: (ka: string, en: string) => string): string {
  const total = Math.max(0, Math.round(ms / 60000));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const hourEn = hours === 1 ? '1 hour' : `${hours} hours`;
  const minuteEn = minutes === 1 ? '1 minute' : `${minutes} minutes`;
  if (hours === 0) return t(`${minutes} წუთი`, minuteEn);
  if (minutes === 0) return t(`${hours} საათი`, hourEn);
  return t(`${hours} საათი ${minutes} წუთი`, `${hourEn} ${minuteEn}`);
}

function gapText(cov: SideCoverage, value: number | null, t: (ka: string, en: string) => string): string {
  if (value == null) return t('ჩამორჩენა არ ყოფილა', 'No disadvantage');
  if (cov.gel) return `${value.toFixed(2)} ${t('თეთრი', 'tetri')}`;
  return `${value.toFixed(5)} ${cov.quote} · ${t('თეთრი არაა', 'not tetri')}`;
}

function CoverageBlock({ cov, lang, selected, selectedKey }: {
  cov: SideCoverage;
  lang: 'ka' | 'en';
  selected: string | null;
  selectedKey: string | null;
}) {
  const { t } = useI18n();
  const sideKa = cov.side === 'buy' ? 'ყიდვა' : 'გაყიდვა';
  const sideEn = cov.side === 'buy' ? 'Buy' : 'Sell';
  const hint = cov.side === 'buy'
    ? t('კლიენტი ყიდის საბაზისო ვალუტას', 'The client sells the base')
    : t('კლიენტი ყიდულობს საბაზისო ვალუტას', 'The client buys the base');
  const comparable = cov.validMs > 0;
  const [pinned, setPinned] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const activeAt = pinned ?? hover;
  const active = activeAt == null ? null : cov.segments.find((seg) => seg.startMs === activeAt) ?? null;
  const run = active && active.status === 'noncompetitive' ? runBounds(cov.segments, active.startMs) : null;
  const days = cov.segments.length
    ? daySlices(cov.segments[0].startMs, cov.segments[cov.segments.length - 1].endMs)
    : [];
  const leader = cov.singleBest;

  return (
    <section className="comp-block" aria-label={`${cov.pair} ${t(sideKa, sideEn)}`}>
      <h2>{cov.pair} · {t(sideKa, sideEn)} <span className="tiny muted">{hint}</span></h2>
      {selected && <p className="comp-note">{t('შედარება მხოლოდ {name}-სთან.', 'Compared only with {name}.', { name: selected })}</p>}

      <div className="stats big comp-kpis">
        <div className={comparable && (cov.noncompetitivePct ?? 0) > 0 ? 'stat comp-kpi-main' : 'stat'}>
          <div className="label">{t('არაკონკურენტული დრო', 'Noncompetitive time')}</div>
          <div className="value">{comparable ? formatPct(cov.noncompetitivePct) + '%' : t('არ არის', 'Unavailable')}</div>
          <div className="tiny muted">{comparable ? fmtSpan(cov.noncompetitiveMs, t) : t('შედარებადი დრო არ არის', 'No comparable time')}</div>
        </div>
        <div className="stat">
          <div className="label">{t('კონკურენტული დრო', 'Competitive time')}</div>
          <div className="value">{comparable ? formatPct(cov.competitivePct) + '%' : t('არ არის', 'Unavailable')}</div>
          <div className="tiny muted">{comparable ? fmtSpan(cov.competitiveMs, t) : t('შედარებადი დრო არ არის', 'No comparable time')}</div>
        </div>
        <div className="stat">
          <div className="label">{t('მონაცემების დაფარვა', 'Data coverage')}</div>
          <div className="value">{cov.elapsedMs > 0 ? formatPct(cov.coveragePct) + '%' : t('არ არის', 'Unavailable')}</div>
          <div className="tiny muted">{t('გამოტოვებულია {time}', 'Missing {time}', { time: fmtSpan(cov.unavailableMs, t) })}</div>
        </div>
        <div className="stat">
          <div className="label">{t('საშუალო ჩამორჩენა', 'Average disadvantage')}</div>
          <div className="value">{gapText(cov, cov.noncompetitiveMs > 0 ? (cov.gel ? cov.avgTetri : cov.avgDisadvantage) : null, t)}</div>
          <div className="tiny muted">{t('მხოლოდ არაკონკურენტულ დროზე', 'Only while noncompetitive')}</div>
        </div>
        <div className="stat">
          <div className="label">{t('მაქსიმალური ჩამორჩენა', 'Maximum disadvantage')}</div>
          <div className="value">{gapText(cov, cov.noncompetitiveMs > 0 ? (cov.gel ? cov.maxTetri : cov.maxDisadvantage) : null, t)}</div>
          <div className="tiny muted">{cov.noncompetitiveMs > 0 ? t('ყველაზე დიდი ჩამორჩენა', 'Widest disadvantage') : t('ჩამორჩენა არ ყოფილა', 'No disadvantage')}</div>
        </div>
      </div>

      <section className="card" aria-labelledby={'comp-who-' + cov.pair.replace('/', '-') + '-' + cov.side}>
        <h3 id={'comp-who-' + cov.pair.replace('/', '-') + '-' + cov.side}>{t('რომელ კონკურენტებთან ვიყავით არაკონკურენტული?', 'Which competitors were we noncompetitive against?')}</h3>
        {cov.competitors.length === 0 && <p className="comp-note">{t('ამ ფილტრზე კონკურენტი არ ჩანს.', 'No competitor is stored for this filter.')}</p>}
        <ul className="comp-bars">
          {cov.competitors.map((item) => {
            const width = item.betterPct == null ? 0 : Math.max(0, Math.min(100, item.betterPct));
            return (
              <li key={item.key} className={selectedKey === item.key ? 'comp-bar-on' : undefined}>
                <div className="comp-bar-head">
                  <span className="strong">{item.label}</span>
                  <span>{item.betterPct == null ? t('შედარება არ არის', 'No comparison') : formatPct(item.betterPct) + '%'}</span>
                </div>
                <div className="comp-bar-track" aria-hidden="true">
                  <div className="comp-bar-fill" style={{ width: width + '%' }} />
                </div>
                <p className="tiny muted">
                  {item.betterPct == null
                    ? t('საერთო ვარგისი დრო არ არის', 'There is no shared valid time')
                    : t('{time} · საშუალო {avg} · მაქს. {max} · დაფარვა {cover}', '{time} · average {avg} · max {max} · coverage {cover}', {
                      time: fmtSpan(item.betterMs, t),
                      avg: gapText(cov, item.avgTetri ?? item.avgDisadvantage, t),
                      max: gapText(cov, item.maxTetri ?? item.maxDisadvantage, t),
                      cover: formatPct(item.coveragePct) + '%',
                    })}
                </p>
              </li>
            );
          })}
        </ul>
        <p className="comp-note">{leader.length
          ? t('ყველა კონკურენტს შორის ერთადერთი საუკეთესო ყველაზე დიდხანს {name} იყო ({time}). ხუთ ნიშნამდე ფრე არც ერთს არ ერიცხება.', 'Across all competitors, {name} was the single best for the most time ({time}). A five-decimal tie is not given to either name.', {
            name: leader.map((item) => item.label).join(', '),
            time: fmtSpan(leader[0].ms, t),
          })
          : t('ერთადერთი საუკეთესო კურსი არ გამოყოფილა: ან შედარება არ იყო, ან საუკეთესო კურსი ხუთ ნიშნამდე იყოფოდა.', 'No single best rate stands out: there was no comparison, or the best rate was tied at five decimals.')}</p>
      </section>

      <section className="card" aria-labelledby={'comp-time-' + cov.pair.replace('/', '-') + '-' + cov.side}>
        <h3 id={'comp-time-' + cov.pair.replace('/', '-') + '-' + cov.side}>{t('კვირის განმავლობაში კონკურენტუნარიანობა', 'Competitiveness through the week')}</h3>
        <ul className="comp-legend">
          <li><span className="comp-swatch comp-seg-bad" aria-hidden="true" />{t('არაკონკურენტული', 'Noncompetitive')}</li>
          <li><span className="comp-swatch comp-seg-ok" aria-hidden="true" />{t('კონკურენტული', 'Competitive')}</li>
          <li><span className="comp-swatch comp-seg-none" aria-hidden="true" />{t('მონაცემი არ არის', 'Unavailable')}</li>
        </ul>
        <div className="comp-days">
          {days.map((day) => {
            const span = day.endMs - day.startMs;
            const full = Date.parse(tbilisiDayStart(day.day));
            const fullEnd = full + 24 * 60 * 60 * 1000;
            const clock = day.startMs === full && day.endMs === fullEnd
              ? '00:00–24:00'
              : fmtTime(new Date(day.startMs).toISOString()) + '–' + fmtTime(new Date(day.endMs).toISOString());
            return (
              <div key={day.day + day.startMs} className="comp-day">
                <div className="comp-day-label">
                  <div>{weekdayName(day.day, lang)} {fmtDay(day.day)}</div>
                  <div className="tiny muted">{clock}</div>
                </div>
                <div className="comp-track">
                  {cov.segments.map((seg) => {
                    const a = Math.max(seg.startMs, day.startMs);
                    const b = Math.min(seg.endMs, day.endMs);
                    if (b <= a || span <= 0) return null;
                    const wide = (b - a) / span > 0.12;
                    const label = statusWord(seg.status, t);
                    return (
                      <button
                        key={seg.startMs + ':' + a}
                        type="button"
                        className={'comp-seg comp-seg-' + statusClass(seg.status)}
                        style={{ flexGrow: b - a, flexBasis: 0, minWidth: seg.status === 'noncompetitive' ? 4 : 0 }}
                        aria-pressed={active?.startMs === seg.startMs}
                        aria-label={segmentLabel(seg, t)}
                        onMouseEnter={() => setHover(seg.startMs)}
                        onFocus={() => setHover(seg.startMs)}
                        onClick={() => setPinned((current) => current === seg.startMs ? null : seg.startMs)}
                      >
                        {wide ? label : <span className="sr-only">{label}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {active && <SegmentDetail seg={active} run={run} gel={cov.gel} quote={cov.quote} />}
      </section>
    </section>
  );
}

function statusClass(status: CoverStatus): string {
  if (status === 'noncompetitive') return 'bad';
  if (status === 'competitive') return 'ok';
  return 'none';
}

function statusWord(status: CoverStatus, t: (ka: string, en: string) => string): string {
  if (status === 'noncompetitive') return t('არაკონკურენტული', 'Noncompetitive');
  if (status === 'competitive') return t('კონკურენტული', 'Competitive');
  return t('მონაცემი არ არის', 'Unavailable');
}

function weekdayName(day: string, lang: 'ka' | 'en'): string {
  const mid = new Date(Date.parse(tbilisiDayStart(day)) + 12 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ka-GE', {
    weekday: 'short',
    timeZone: 'Asia/Tbilisi',
  }).format(mid);
}

function runBounds(segments: CoverSegment[], startMs: number): { startMs: number; endMs: number } | null {
  const index = segments.findIndex((seg) => seg.startMs === startMs);
  if (index < 0) return null;
  let from = index;
  let to = index;
  while (from > 0 && segments[from - 1].status === 'noncompetitive' && segments[from - 1].endMs === segments[from].startMs) from -= 1;
  while (to + 1 < segments.length && segments[to + 1].status === 'noncompetitive' && segments[to].endMs === segments[to + 1].startMs) to += 1;
  return { startMs: segments[from].startMs, endMs: segments[to].endMs };
}

function segmentLabel(seg: CoverSegment, t: (ka: string, en: string) => string): string {
  const when = fmtDay(isoDay(seg.startMs)) + ' ' + fmtTime(new Date(seg.startMs).toISOString());
  return statusWord(seg.status, t) + ' ' + when;
}

function SegmentDetail({ seg, run, gel, quote }: {
  seg: CoverSegment;
  run: { startMs: number; endMs: number } | null;
  gel: boolean;
  quote: string;
}) {
  const { t } = useI18n();
  const when = fmtDay(isoDay(seg.startMs)) + ' ' + fmtTime(new Date(seg.startMs).toISOString())
    + ' – ' + fmtTime(new Date(seg.endMs).toISOString());
  return (
    <div className="comp-tip">
      <p className="strong">{when} · {statusWord(seg.status, t)}</p>
      {seg.status === 'unavailable' && <p>{t(
        'ამ წუთებში კურსის დაფა ან კონკურენტი არ არის, ან კურსი 45 წუთზე ძველია.',
        'In these minutes the Kursi board or a competitor is missing, or the rate is older than 45 minutes.',
      )}</p>}
      {seg.kursiRate != null && <p>{t('კურსის დაფა {rate}', 'Kursi board {rate}', { rate: fmtRate(seg.kursiRate) })}</p>}
      {seg.bestRate != null && <p>{t('საუკეთესო კონკურენტი {name}, კურსი {rate}', 'Best competitor {name}, rate {rate}', {
        name: seg.bestNames || '—',
        rate: fmtRate(seg.bestRate),
      })}</p>}
      {seg.advantage != null && <p>
        {t('სხვაობა {gap}', 'Difference {gap}', { gap: fmtAdvantage(seg.advantage) })}
        {gel && seg.tetri != null ? ` · ${fmtTetri(seg.tetri)} ${t('თეთრი', 'tetri')}` : ''}
        {!gel && ` · ${t('თეთრი არ იწერება', 'Not written in tetri')} (${quote})`}
      </p>}
      {seg.status === 'noncompetitive' && seg.aheadNames && <p>{t(
        'უკეთესი კურსი ჰქონდა: {name}',
        'A better rate was at: {name}',
        { name: seg.aheadNames },
      )}</p>}
      {run && <p>{t(
        'არაკონკურენტული მონაკვეთი დაიწყო {start} და დასრულდა {end}.',
        'The noncompetitive run started {start} and ended {end}.',
        {
          start: fmtDay(isoDay(run.startMs)) + ' ' + fmtTime(new Date(run.startMs).toISOString()),
          end: fmtDay(isoDay(run.endMs)) + ' ' + fmtTime(new Date(run.endMs).toISOString()),
        },
      )}</p>}
    </div>
  );
}

function isoDay(ms: number): string {
  const iso = new Date(ms).toISOString();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date(iso));
  return day;
}
