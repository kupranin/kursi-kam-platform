import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { downloadCsv, fmtDateTime, fmtRate, todayTbilisi } from '../lib/format';
import { IconDownload } from '../components/Icons';
import {
  assignRateSlots,
  buildCurrentBoard,
  buildRateGrid,
  historySheet,
  orientSnapshot,
  pairAllowed,
  type CurrentBoard,
  type RateGrid,
  type RateQuote,
  type RateSnapshot,
  type SlottedRate,
} from '../lib/rateGrid';

const EMPTY_GRID: RateGrid = { columns: [], blocks: [], updatedAt: null };
const EMPTY_BOARD: CurrentBoard = { pairs: [], rows: [], updatedAt: null };

function num(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asList(data: unknown): unknown[] {
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(data) ? data : [];
}

function toSnapshot(row: Record<string, unknown>): RateSnapshot {
  return {
    source: String(row.source ?? ''),
    venue: String(row.venue ?? ''),
    venue_kind: String(row.venue_kind ?? ''),
    currency: String(row.currency ?? ''),
    quote_currency: String(row.quote_currency ?? ''),
    buy: num(row.buy as number | string | null),
    sell: num(row.sell as number | string | null),
    fetched_at: String(row.fetched_at ?? ''),
  };
}

function toSlotted(row: Record<string, unknown>): SlottedRate | null {
  const day = String(row.day ?? '');
  const slot = Number(row.slot);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(slot)) return null;
  return { ...toSnapshot(row), day, slot };
}

function downloadGrid(grid: RateGrid) {
  downloadCsv(`kursi-rates-${todayTbilisi()}.csv`, historySheet(grid));
}

export default function MarketRates() {
  const toast = useToast();
  const { profile } = useAuth();
  const canRefresh = profile?.role === 'admin' || profile?.role === 'treasury';
  const [grid, setGrid] = useState<RateGrid>(EMPTY_GRID);
  const [board, setBoard] = useState<CurrentBoard>(EMPTY_BOARD);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const { data, error } = await supabase.rpc('market_rate_grid', { p_days: 14 });
    if (seq !== loadSeq.current) return;
    if (!error) {
      const slotted = asList(data).map((row) => toSlotted(row as Record<string, unknown>)).filter((row): row is SlottedRate => row != null);
      const latest = await loadRecentSnapshots();
      if (seq !== loadSeq.current) return;
      setGrid(buildRateGrid(slotted));
      setBoard(buildCurrentBoard(latest.length ? latest : slotted));
      return;
    }
    const missing = /market_rate_grid|schema cache|Could not find the function/i.test(error.message);
    if (!missing) throw new Error(error.message);
    const raw = await loadRawSnapshots();
    if (seq !== loadSeq.current) return;
    setGrid(buildRateGrid(assignRateSlots(raw)));
    setBoard(buildCurrentBoard(raw));
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
          <h1>კურსები</h1>
          <p>
            ბოლო ყიდვა და გაყიდვა USD, EUR, RUB და CNY GEL-ის მიმართ, შემდეგ კროსები, მაგალითად EUR/USD.
            {updated ? ' განახლდა ' + updated + '.' : ''} კურსები თავისით ახლდება ყოველ 30 წუთში.
            ჩამოტვირთეთ კურსები 11:00–19:00 ისტორიისთვის.
          </p>
        </div>
        <div className="row">
          <button type="button" className="btn" disabled={!grid.blocks.length} onClick={() => downloadGrid(grid)}>
            <IconDownload />კურსების ჩამოტვირთვა
          </button>
          {canRefresh && (
            <button type="button" className="btn btn-primary" disabled={refreshing} onClick={refresh}>
              {refreshing ? 'ახლდება…' : 'კურსების განახლება'}
            </button>
          )}
        </div>
      </div>

      {!loaded && <p className="empty">იტვირთება…</p>}
      {loaded && !board.rows.length && <p className="empty">კურსი ჯერ არ არის შენახული. ადმინს ან სახაზინოს შეუძლია განახლება.</p>}
      {board.rows.length > 0 && <CurrentBoardTable board={board} />}
    </>
  );
}

async function loadRecentSnapshots(): Promise<RateSnapshot[]> {
  return loadSnapshots(new Date(Date.now() - 2 * 86_400_000).toISOString());
}

async function loadRawSnapshots(): Promise<RateSnapshot[]> {
  return loadSnapshots(new Date(Date.now() - 15 * 86_400_000).toISOString());
}

async function loadSnapshots(since: string): Promise<RateSnapshot[]> {
  const pageSize = 1000;
  const all: RateSnapshot[] = [];
  for (let from = 0; from < 20000; from += pageSize) {
    const { data, error } = await supabase
      .from('market_rates')
      .select('source, venue, venue_kind, currency, quote_currency, buy, sell, fetched_at')
      .in('currency', ['USD', 'EUR', 'RUB', 'CNY'])
      .in('quote_currency', ['GEL', 'USD', 'EUR', 'RUB', 'CNY'])
      .in('venue_kind', ['board', 'bank'])
      .gte('fetched_at', since)
      .order('fetched_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Record<string, unknown>[];
    for (const row of batch) {
      const snap = orientSnapshot(toSnapshot(row));
      if (pairAllowed(snap.currency, snap.quote_currency)) all.push(snap);
    }
    if (batch.length < pageSize) break;
  }
  return all;
}

function CurrentBoardTable({ board }: { board: CurrentBoard }) {
  return (
    <section className="card flush" aria-label="მიმდინარე კურსები">
      <div className="table-wrap">
        <table className="table rate-grid">
          <thead>
            <tr>
              <th className="src" rowSpan={2} scope="col">წყარო</th>
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
  return (
    <>
      <th className="num side pair-start" scope="col">ყიდვა</th>
      <th className="num side" scope="col">გაყიდვა</th>
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
