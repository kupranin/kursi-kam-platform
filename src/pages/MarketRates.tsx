import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useViewAs } from '../lib/viewAs';
import { useI18n } from '../lib/i18n';
import { useToast } from '../lib/toast';
import { downloadCsv, fmtDateTime, fmtRate, todayTbilisi } from '../lib/format';
import { IconDownload } from '../components/Icons';
import LoadingLine from '../components/LoadingLine';
import RateCompareCharts from '../components/RateCompareCharts';
import { loadRateHours } from '../lib/marketBoard';
import {
  boardForHour,
  buildCurrentBoard,
  buildStoredHourGrid,
  historySheet,
  storedHours,
  type CurrentBoard,
  type HourlySnap,
  type RateQuote,
} from '../lib/rateGrid';

const EMPTY_BOARD: CurrentBoard = { pairs: [], rows: [], updatedAt: null };

function padHour(hour: number): string {
  return String(hour).padStart(2, '0') + ':00';
}

export default function MarketRates() {
  const toast = useToast();
  const { t } = useI18n();
  const { role } = useViewAs();
  const canRefresh = role === 'admin' || role === 'treasury';
  const [snaps, setSnaps] = useState<HourlySnap[]>([]);
  const [board, setBoard] = useState<CurrentBoard>(EMPTY_BOARD);
  const [day, setDay] = useState(() => todayTbilisi());
  const [fromDay, setFromDay] = useState(() => todayTbilisi());
  const [toDay, setToDay] = useState(() => todayTbilisi());
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const today = todayTbilisi();
    const rows = await loadRateHours(today, today);
    if (seq !== loadSeq.current) return;
    setDay(today);
    setSnaps(rows);
    setBoard(buildCurrentBoard(rows));
  }, []);

  useEffect(() => {
    let live = true;
    const run = (announce: boolean) => {
      load()
        .then(() => { if (live) setLoaded(true); })
        .catch((err: Error) => { if (live && announce) toast(err.message, 'error'); });
    };
    run(true);
    // A later hour is written when rates are saved. Reload the same today
    // read so an open page picks it up. Chart tabs do not call this.
    const timer = window.setInterval(() => run(false), 5 * 60 * 1000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [load, toast]);

  async function refresh() {
    setRefreshing(true);
    try {
      const { data, error } = await supabase.functions.invoke('fetch-market-rates', { body: {} });
      if (error) {
        let message = error.message;
        const ctx = (error as { context?: Response }).context;
        if (ctx && typeof ctx.json === 'function') {
          try {
            const parsed = await ctx.json();
            if (parsed?.error) message = parsed.error;
          } catch { /* keep the generic message */ }
        }
        throw new Error(message);
      }
      const problems = (data?.problems ?? []) as string[];
      if (problems.length) toast('შეინახა ' + (data?.saved ?? 0) + '. ' + problems.join('; '), 'error');
      else toast('კურსები განახლდა');
      await load();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setRefreshing(false);
    }
  }

  async function downloadRange() {
    if (!fromDay || !toDay || fromDay > toDay) {
      toast(t('აირჩიეთ თარიღი ან პერიოდი.', 'Choose a date or a date range.'), 'error');
      return;
    }
    const span = Math.round((Date.parse(toDay + 'T00:00:00Z') - Date.parse(fromDay + 'T00:00:00Z')) / 86_400_000) + 1;
    if (span > 62) {
      toast(t('პერიოდი 62 დღეზე გრძელია.', 'The range is longer than 62 days.'), 'error');
      return;
    }
    setDownloading(true);
    try {
      const rows = fromDay === day && toDay === day ? snaps : await loadRateHours(fromDay, toDay);
      const grid = buildStoredHourGrid(rows);
      if (!grid.blocks.length) {
        toast(t('ამ თარიღებში შენახული კურსი არ არის.', 'No stored rate in those dates.'), 'error');
        return;
      }
      const name = fromDay === toDay ? `kursi-rates-${fromDay}.csv` : `kursi-rates-${fromDay}_${toDay}.csv`;
      downloadCsv(name, historySheet(grid));
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setDownloading(false);
    }
  }

  const updated = board.updatedAt ? fmtDateTime(board.updatedAt) : '';
  const hours = storedHours(snaps, day).filter((hour) => boardForHour(snaps, day, hour).rows.length > 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('კურსები', 'Rates')}</h1>
          <p>
            {t('ბოლო ყიდვა და გაყიდვა USD, EUR, RUB და CNY GEL-ის მიმართ, შემდეგ კროსები, მაგალითად EUR/USD.', 'Latest buy and sell for USD, EUR, RUB and CNY against GEL, then crosses such as EUR/USD.')}
            {updated ? ' ' + t('განახლდა {when}.', 'Updated {when}.', { when: updated }) : ''} {t('ცხრილი დღევანდელ შენახულ საათებს აჩვენებს, თბილისის დროით. ჩამოტვირთვაში აირჩიეთ თარიღი ან პერიოდი.', 'The table shows the hours stored today, Tbilisi time. Choose a date or a range for the download.')}
          </p>
        </div>
        <div className="date-range">
          <div className="field">
            <label htmlFor="rates-from">{t('თარიღიდან', 'From')}</label>
            <input id="rates-from" type="date" className="input" value={fromDay} onChange={(e) => setFromDay(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="rates-to">{t('თარიღამდე', 'To')}</label>
            <input id="rates-to" type="date" className="input" value={toDay} onChange={(e) => setToDay(e.target.value)} />
          </div>
          <button type="button" className="btn" disabled={downloading} onClick={downloadRange}>
            <IconDownload />{downloading ? t('იწერება…', 'Preparing…') : t('კურსების ჩამოტვირთვა', 'Download rates')}
          </button>
          {canRefresh && (
            <button type="button" className="btn btn-primary" disabled={refreshing} onClick={refresh}>
              {refreshing ? t('ახლდება…', 'Refreshing…') : t('კურსების განახლება', 'Refresh rates')}
            </button>
          )}
        </div>
      </div>

      {!loaded && <LoadingLine />}
      {loaded && !board.rows.length && <p className="empty">{t('დღეს შენახული კურსი ჯერ არ არის. ადმინს ან ხაზინას შეუძლია განახლება.', 'No rate is stored today yet. An admin or treasury can refresh.')}</p>}
      {board.rows.length > 0 && <RateCompareCharts board={board} />}
      {hours.map((hour) => (
        <section key={hour} className="rate-hour" aria-label={padHour(hour)}>
          <h2 className="rate-hour-title">{padHour(hour)} <span className="tiny muted">{t('თბილისის დრო', 'Tbilisi time')}</span></h2>
          <CurrentBoardTable board={boardForHour(snaps, day, hour)} />
        </section>
      ))}
    </>
  );
}

function CurrentBoardTable({ board }: { board: CurrentBoard }) {
  const { t } = useI18n();
  return (
    <section className="card flush" aria-label={t('მიმდინარე კურსები', 'Current rates')}>
      <div className="table-wrap">
        <table className="table rate-grid">
          <thead>
            <tr>
              <th className="src" rowSpan={2} scope="col">{t('წყარო', 'Source')}</th>
              {board.pairs.map((pair) => (
                <th key={pair} className="num pair" colSpan={2} scope="colgroup">{pair}</th>
              ))}
            </tr>
            <tr>
              {board.pairs.map((pair) => (
                <PairSides key={pair} />
              ))}
            </tr>
          </thead>
          <tbody>
            {board.rows.map((row) => (
              <tr key={row.key}>
                <th className="src" scope="row">{row.label}</th>
                {row.quotes.map((quote, i) => (
                  <QuoteCells key={board.pairs[i]} quote={quote} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PairSides() {
  const { t } = useI18n();
  return (
    <>
      <th className="num side pair-start" scope="col">{t('ყიდვა', 'Buy')}</th>
      <th className="num side" scope="col">{t('გაყიდვა', 'Sell')}</th>
    </>
  );
}

function QuoteCells({ quote }: { quote: RateQuote }) {
  return (
    <>
      <td className="num pair-start">{fmtRate(quote.buy)}</td>
      <td className="num">{fmtRate(quote.sell)}</td>
    </>
  );
}
