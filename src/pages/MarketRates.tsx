import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useViewAs } from '../lib/viewAs';
import { useI18n } from '../lib/i18n';
import { useToast } from '../lib/toast';
import { downloadCsv, fmtDateTime, fmtRate, todayTbilisi } from '../lib/format';
import { IconDownload } from '../components/Icons';
import RateCompareCharts from '../components/RateCompareCharts';
import { loadMarketRateData } from '../lib/marketBoard';
import {
  historySheet,
  type CurrentBoard,
  type RateGrid,
  type RateQuote,
} from '../lib/rateGrid';

const EMPTY_GRID: RateGrid = { columns: [], blocks: [], updatedAt: null };
const EMPTY_BOARD: CurrentBoard = { pairs: [], rows: [], updatedAt: null };

function downloadGrid(grid: RateGrid) {
  downloadCsv(`kursi-rates-${todayTbilisi()}.csv`, historySheet(grid));
}

export default function MarketRates() {
  const toast = useToast();
  const { t } = useI18n();
  const { role } = useViewAs();
  const canRefresh = role === 'admin' || role === 'treasury';
  const [grid, setGrid] = useState<RateGrid>(EMPTY_GRID);
  const [board, setBoard] = useState<CurrentBoard>(EMPTY_BOARD);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const view = await loadMarketRateData();
    if (seq !== loadSeq.current) return;
    setGrid(view.grid);
    setBoard(view.board);
  }, []);

  useEffect(() => {
    let live = true;
    const run = (announce: boolean) => {
      load()
        .then(() => { if (live) setLoaded(true); })
        .catch((err: Error) => { if (live && announce) toast(err.message, 'error'); });
    };
    run(true);
    // The 30-minute job writes in the database. Reload the board and the
    // download from those stored rows so an open page picks them up.
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

  const updated = board.updatedAt ? fmtDateTime(board.updatedAt) : '';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('კურსები', 'Rates')}</h1>
          <p>
            {t('ბოლო ყიდვა და გაყიდვა USD, EUR, RUB და CNY GEL-ის მიმართ, შემდეგ კროსები, მაგალითად EUR/USD.', 'Latest buy and sell for USD, EUR, RUB and CNY against GEL, then crosses such as EUR/USD.')}
            {updated ? ' ' + t('განახლდა {when}.', 'Updated {when}.', { when: updated }) : ''} {t('კურსები თავისით ახლდება ყოველ 30 წუთში. ჩამოტვირთეთ კურსები 11:00–19:00 ისტორიისთვის.', 'Rates refresh on their own every 30 minutes. Download them for the 11:00–19:00 history.')}
          </p>
        </div>
        <div className="row">
          <button type="button" className="btn" disabled={!grid.blocks.length} onClick={() => downloadGrid(grid)}>
            <IconDownload />{t('კურსების ჩამოტვირთვა', 'Download rates')}
          </button>
          {canRefresh && (
            <button type="button" className="btn btn-primary" disabled={refreshing} onClick={refresh}>
              {refreshing ? t('ახლდება…', 'Refreshing…') : t('კურსების განახლება', 'Refresh rates')}
            </button>
          )}
        </div>
      </div>

      {!loaded && <p className="empty">{t('იტვირთება…', 'Loading…')}</p>}
      {loaded && !board.rows.length && <p className="empty">{t('კურსი ჯერ არ არის შენახული. ადმინს ან სახაზინოს შეუძლია განახლება.', 'No rate is saved yet. An admin or treasury can refresh.')}</p>}
      {board.rows.length > 0 && <CurrentBoardTable board={board} />}
      {board.rows.length > 0 && <RateCompareCharts board={board} />}
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
