import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { downloadCsv, fmtDateTime, fmtRate, todayTbilisi } from '../lib/format';
import { IconDownload } from '../components/Icons';

interface MarketRate {
  source: string;
  venue: string;
  venue_kind: 'board' | 'bank' | 'kiosk';
  currency: string;
  quote_currency: string;
  buy: number | null;
  sell: number | null;
  official: number | null;
  fetched_at: string;
}

const BOARDS: { source: string; title: string }[] = [
  { source: 'kursi', title: 'Kursi' },
  { source: 'rico', title: 'Rico' },
  { source: 'valuto', title: 'Valuto' },
  { source: 'expresslombard', title: 'Express Lombard' },
];

const SOURCE_TITLE: Record<string, string> = {
  kursi: 'Kursi',
  rico: 'Rico',
  myvaluta: 'Myvaluta',
  valuto: 'Valuto',
  expresslombard: 'Express Lombard',
};

const SOURCE_ORDER = ['kursi', 'rico', 'myvaluta', 'valuto', 'expresslombard'];
const KIND_TITLE: Record<MarketRate['venue_kind'], string> = {
  board: 'Board',
  bank: 'Bank',
  kiosk: 'Kiosk',
};
const KIND_ORDER: MarketRate['venue_kind'][] = ['board', 'bank', 'kiosk'];

function fetchedStamp(iso: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(d);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tbilisi' });
  return day + ' ' + time;
}

function downloadRates(rows: MarketRate[]) {
  const sorted = [...rows].sort((a, b) =>
    SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)
    || KIND_ORDER.indexOf(a.venue_kind) - KIND_ORDER.indexOf(b.venue_kind)
    || a.venue.localeCompare(b.venue)
    || a.currency.localeCompare(b.currency)
    || a.quote_currency.localeCompare(b.quote_currency));
  downloadCsv(`kursi-rates-${todayTbilisi()}.csv`, [
    ['Source', 'Venue', 'Kind', 'Currency', 'Quote', 'Buy', 'Sell', 'Official', 'Fetched'],
    ...sorted.map((row) => [
      SOURCE_TITLE[row.source] ?? row.source,
      row.venue,
      KIND_TITLE[row.venue_kind],
      row.currency,
      row.quote_currency,
      row.buy,
      row.sell,
      row.official,
      fetchedStamp(row.fetched_at),
    ]),
  ]);
}

function pair(row: MarketRate): string {
  return row.quote_currency === 'GEL' ? row.currency : row.currency + '/' + row.quote_currency;
}

function num(value: number | string | null): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export default function MarketRates() {
  const toast = useToast();
  const { profile } = useAuth();
  const canRefresh = profile?.role === 'admin' || profile?.role === 'treasury';
  const [rows, setRows] = useState<MarketRate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [currency, setCurrency] = useState('USD');

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('market_rates').select('source, venue, venue_kind, currency, quote_currency, buy, sell, official, fetched_at').order('venue');
    if (error) throw new Error(error.message);
    setRows((data ?? []).map((row) => ({
      ...(row as MarketRate),
      buy: num(row.buy),
      sell: num(row.sell),
      official: num(row.official),
    })));
  }, []);

  useEffect(() => {
    let live = true;
    load()
      .then(() => { if (live) setLoaded(true); })
      .catch((err: Error) => { if (live) toast(err.message, 'error'); });
    return () => { live = false; };
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
      if (problems.length) toast('Saved ' + (data?.saved ?? 0) + '. ' + problems.join('; '), 'error');
      else toast('Rates updated');
      await load();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setRefreshing(false);
    }
  }

  const fetched = rows.reduce<string | null>((latest, row) => (!latest || row.fetched_at > latest ? row.fetched_at : latest), null);
  const kursiBanks = rows.filter((row) => row.source === 'kursi' && row.venue_kind === 'bank');
  const myBanks = rows.filter((row) => row.source === 'myvaluta' && row.venue_kind === 'bank');
  const myKiosks = rows.filter((row) => row.source === 'myvaluta' && row.venue_kind === 'kiosk');
  const currencies = [...new Set([...myBanks, ...myKiosks].map((row) => row.currency))];
  const preferred = ['USD', 'EUR', 'GBP', 'RUB', 'GEL'].filter((code) => currencies.includes(code));
  const currencyOptions = [...preferred, ...currencies.filter((code) => !preferred.includes(code)).sort()];
  const selected = currencyOptions.includes(currency) ? currency : (currencyOptions[0] ?? 'USD');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rates</h1>
          <p>Kursi, Rico, Myvaluta, Valuto and Express Lombard{fetched ? '. Updated ' + fmtDateTime(fetched) : ''}</p>
        </div>
        <div className="row">
          <button type="button" className="btn" disabled={!rows.length} onClick={() => downloadRates(rows)}>
            <IconDownload />Download rates
          </button>
          {canRefresh && (
            <button type="button" className="btn btn-primary" disabled={refreshing} onClick={refresh}>
              {refreshing ? 'Updating…' : 'Update rates'}
            </button>
          )}
        </div>
      </div>

      {!loaded && <p className="empty">Loading…</p>}
      {loaded && !rows.length && <p className="empty">No rates stored yet. An admin or treasury can update them.</p>}

      {BOARDS.map((board) => {
        const list = rows.filter((row) => row.source === board.source && row.venue_kind === 'board');
        if (!list.length) return null;
        return <RateTable key={board.source} title={board.title} rows={list} showPair />;
      })}

      {kursiBanks.length > 0 && <RateTable title="Banks published by Kursi" rows={kursiBanks} showVenue showPair />}

      {(myBanks.length > 0 || myKiosks.length > 0) && (
        <div className="row" style={{ margin: '8px 0 0' }}>
          <label htmlFor="market-currency">Currency</label>
          <select id="market-currency" className="select" style={{ width: 'auto' }} value={selected} onChange={(e) => setCurrency(e.target.value)}>
            {currencyOptions.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
        </div>
      )}
      {myBanks.length > 0 && <RateTable title="Banks on Myvaluta" rows={myBanks.filter((row) => row.currency === selected)} showVenue />}
      {myKiosks.length > 0 && <RateTable title="Kiosks on Myvaluta" rows={myKiosks.filter((row) => row.currency === selected)} showVenue />}
    </>
  );
}

function RateTable({ title, rows, showVenue, showPair }: { title: string; rows: MarketRate[]; showVenue?: boolean; showPair?: boolean }) {
  const sorted = [...rows].sort((a, b) => (showVenue ? a.venue.localeCompare(b.venue) : pair(a).localeCompare(pair(b))));
  return (
    <section className="card flush" style={{ marginTop: 18 }} aria-label={title}>
      <div className="card-head"><h2>{title}</h2></div>
      {!sorted.length && <p className="empty">No rates for this currency.</p>}
      {sorted.length > 0 && (
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 520 }}>
            <thead>
              <tr>
                <th>{showVenue ? 'Name' : 'Currency'}</th>
                {showVenue && showPair && <th>Currency</th>}
                <th className="num">Buy</th>
                <th className="num">Sell</th>
                <th className="num">Official</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={row.source + row.venue + row.currency + row.quote_currency}>
                  <th scope="row">{showVenue ? row.venue : pair(row)}</th>
                  {showVenue && showPair && <td>{pair(row)}</td>}
                  <td className="num">{fmtRate(row.buy)}</td>
                  <td className="num">{fmtRate(row.sell)}</td>
                  <td className="num">{row.official == null ? '' : fmtRate(row.official)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
