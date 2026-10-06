import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { useLive, useTick } from '../lib/useLive';
import { describeDeal, fmtAmount, fmtDay, fmtRate, fmtTime, fmtWhole, longToday, minutesSince, rateUnit } from '../lib/format';
import type { QueueRow, QuoteToday, ReferenceRate } from '../lib/types';
import { IconClock } from '../components/Icons';

const DECLINE_REASONS = ['Amount too large', 'Market moving too fast', 'Need more details'];
const FAR_PCT = 3;

interface CardState { rate: string; valid: number; declining: boolean; confirmFar: boolean; tried: boolean }

export default function RateDesk() {
  const toast = useToast();
  useTick(10000);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [quotes, setQuotes] = useState<QuoteToday[]>([]);
  const [rates, setRates] = useState<ReferenceRate[]>([]);
  const [defaultValid, setDefaultValid] = useState(15);
  const [cards, setCards] = useState<Record<number, CardState>>({});
  const [loaded, setLoaded] = useState(false);
  const firstSeen = useRef<Map<number, number>>(new Map());
  const initial = useRef(true);

  const load = useCallback(async () => {
    try {
      const [q, t] = await Promise.all([
        rpc<QueueRow[]>('treasury_queue'),
        rpc<QuoteToday[]>('treasury_quotes_today'),
      ]);
      const now = Date.now();
      for (const r of q ?? []) {
        if (!firstSeen.current.has(r.request_id)) firstSeen.current.set(r.request_id, initial.current ? 0 : now);
      }
      if (!initial.current && (q ?? []).some((r) => firstSeen.current.get(r.request_id) === now)) {
        const fresh = (q ?? []).filter((r) => firstSeen.current.get(r.request_id) === now);
        toast(fresh.length === 1 ? `New request from ${fresh[0].kam_name}: ${fresh[0].client_name ?? fresh[0].client_id}` : `${fresh.length} new requests`);
      }
      initial.current = false;
      setQueue(q ?? []);
      setQuotes(t ?? []);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setLoaded(true);
  }, [toast]);

  useEffect(() => {
    load();
    rpc<ReferenceRate[]>('treasury_rates').then(setRates).catch(() => setRates([]));
    supabase.from('rules').select('default_quote_minutes').single().then(({ data }) => {
      if (data?.default_quote_minutes) setDefaultValid(data.default_quote_minutes);
    });
  }, [load]);
  useLive(['requests'], load, 15000);

  const card = (id: number): CardState => cards[id] ?? { rate: '', valid: defaultValid, declining: false, confirmFar: false, tried: false };
  const patch = (id: number, p: Partial<CardState>) => setCards((c) => ({ ...c, [id]: { ...card(id), ...p } }));

  async function send(r: QueueRow) {
    const c = card(r.request_id);
    const rate = Number(c.rate.trim());
    if (!c.rate.trim() || !(rate > 0)) { patch(r.request_id, { tried: true }); return; }
    if (r.standard_rate && Math.abs(rate - r.standard_rate) / r.standard_rate * 100 > FAR_PCT && !c.confirmFar) {
      patch(r.request_id, { confirmFar: true });
      return;
    }
    try {
      const until = await rpc<string>('treasury_quote', { p_request_id: r.request_id, p_rate: rate, p_valid_minutes: c.valid });
      toast(`Rate ${fmtRate(rate)} sent to ${r.kam_name.split(' ')[0]}, valid until ${fmtTime(until)}`);
      setCards((all) => { const n = { ...all }; delete n[r.request_id]; return n; });
      load();
    } catch (err) { toast((err as Error).message, 'error'); load(); }
  }

  async function decline(r: QueueRow, reason: string) {
    try {
      await rpc('treasury_decline', { p_request_id: r.request_id, p_reason: reason });
      toast(`Sent back to ${r.kam_name.split(' ')[0]}: ${reason}`);
      load();
    } catch (err) { toast((err as Error).message, 'error'); load(); }
  }

  // ---- reference rates
  const gelRows = Array.from(new Set(rates.filter((r) => r.quote_currency === 'GEL').map((r) => r.currency))).map((ccy) => ({
    ccy,
    std: rates.find((r) => r.source === 'standard' && r.currency === ccy && r.quote_currency === 'GEL'),
    nbg: rates.find((r) => r.source === 'nbg' && r.currency === ccy),
  }));
  const crossRows = rates.filter((r) => r.source === 'standard' && r.quote_currency !== 'GEL');
  const stdAsOf = rates.find((r) => r.source === 'standard')?.as_of;
  const nbgAsOf = rates.find((r) => r.source === 'nbg')?.as_of;
  const nbgMap: Record<string, number> = { GEL: 1 };
  rates.filter((r) => r.source === 'nbg' && r.official).forEach((r) => { nbgMap[r.currency] = Number(r.official); });

  // ---- special rates today, by direction
  const groups = new Map<string, QuoteToday[]>();
  for (const q of quotes) {
    const k = q.sells_currency + '>' + q.gets_currency;
    groups.set(k, [...(groups.get(k) ?? []), q]);
  }

  // ---- what valid quotes would do to each currency
  const effect: Record<string, number> = {};
  for (const q of quotes.filter((x) => x.quote_state === 'quoted' && !x.went_through && new Date(x.valid_until) > new Date())) {
    const a = Number(q.amount), rate = Number(q.rate);
    if (q.sells_currency !== 'GEL') effect[q.sells_currency] = (effect[q.sells_currency] ?? 0) + a;
    if (q.gets_currency !== 'GEL') {
      const paid = q.sells_currency === 'GEL' ? a / rate : a * rate;
      effect[q.gets_currency] = (effect[q.gets_currency] ?? 0) - paid;
    }
  }
  const usdEq = (ccy: string, v: number) => (nbgMap[ccy] && nbgMap.USD ? (v * nbgMap[ccy]) / nbgMap.USD : null);

  const validCount = quotes.filter((q) => q.quote_state === 'quoted' && !q.went_through).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rate desk</h1>
          <p>{longToday()}</p>
        </div>
        <div className="stats">
          <div className="stat"><div className="label">Waiting for a rate</div><div className="value" style={{ color: 'var(--aubergine)' }}>{queue.length}</div></div>
          <div className="stat"><div className="label">Valid quotes</div><div className="value">{validCount}</div></div>
          <div className="stat"><div className="label">Quoted today</div><div className="value">{quotes.length}</div></div>
        </div>
      </div>

      <div className="cols">
        <div className="col-main">
          <section aria-labelledby="queue-title">
            <div className="row-between" style={{ marginBottom: 12 }}>
              <h2 id="queue-title" style={{ fontSize: 22 }}>Waiting for a rate</h2>
              <span className="small muted">Oldest first. Type the rate and press Enter to send it to the KAM.</span>
            </div>
            {loaded && !queue.length && <div className="card"><p className="empty">Nothing waiting. New requests from KAMs appear here.</p></div>}
            <div className="stack-sm">
              {queue.map((r) => {
                const c = card(r.request_id);
                const late = minutesSince(r.asked_at) >= 2;
                const seenAt = firstSeen.current.get(r.request_id) ?? 0;
                const isNew = seenAt > 0 && Date.now() - seenAt < 60000;
                const rateNum = Number(c.rate);
                const rateOk = c.rate.trim() !== '' && rateNum > 0;
                const dev = rateOk && r.standard_rate ? Math.abs(rateNum - r.standard_rate) / r.standard_rate * 100 : 0;
                const refs = [
                  r.standard_rate != null && { label: 'Our standard', value: r.standard_rate },
                  r.nbg_rate != null && { label: 'NBG', value: r.nbg_rate },
                  r.last_given_today != null && { label: 'Last given today', value: r.last_given_today },
                  r.last_rate != null && { label: 'Last to this client', value: r.last_rate },
                ].filter(Boolean) as { label: string; value: number }[];
                return (
                  <article key={r.request_id} className={'req-card' + (isNew ? ' new' : late ? ' late' : '')}>
                    <div className="row small" style={{ gap: '8px 14px', marginBottom: 10 }}>
                      <span className={'pill ' + (late ? 'pill-alert' : 'pill-wait')}><IconClock />{minutesSince(r.asked_at) < 1 ? 'Just now' : 'Waiting ' + minutesSince(r.asked_at) + ' min'}</span>
                      <span style={{ color: 'var(--ink-2)' }}>from {r.kam_name}</span>
                      {isNew && <span className="pill pill-gold">New</span>}
                      {r.is_new_client && <span className="pill pill-dark">New client</span>}
                    </div>
                    <div className="row-between">
                      <div>
                        <div style={{ fontSize: 20, fontWeight: 600 }}>{describeDeal(r.sells_currency, r.amount, r.gets_currency)}</div>
                        <div className="small muted">{r.client_name ?? 'No name on file'}, ID {r.client_id}</div>
                      </div>
                      {r.last_rate != null && <div className="small" style={{ color: 'var(--ink-2)' }}>Last rate to this client {fmtRate(r.last_rate)}{r.last_rate_at ? ', ' + fmtDay(r.last_rate_at.slice(0, 10)) : ''}</div>}
                    </div>
                    {r.note && <p className="note-box">KAM's note: {r.note}</p>}

                    {!c.declining && (
                      <>
                        {refs.length > 0 && (
                          <div className="row" style={{ marginTop: 16, gap: 8 }}>
                            <span className="small strong" style={{ marginRight: 4 }}>Rates for this deal</span>
                            {refs.map((x) => (
                              <button key={x.label} type="button" className="ref-chip" title="Use as a starting point" onClick={() => patch(r.request_id, { rate: fmtRate(x.value), confirmFar: false, tried: false })}>
                                <span>{x.label}</span><span>{fmtRate(x.value)}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="form-row" style={{ marginTop: 12 }}>
                          <div className="field" style={{ flex: '0 1 190px' }}>
                            <label htmlFor={'rate-' + r.request_id}>Rate</label>
                            <input
                              id={'rate-' + r.request_id}
                              className={'input big' + (c.tried && !rateOk ? ' invalid' : '')}
                              inputMode="decimal"
                              autoComplete="off"
                              value={c.rate}
                              onChange={(e) => patch(r.request_id, { rate: e.target.value.replace(',', '.'), confirmFar: false })}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(r); } }}
                            />
                            <span className={'hint' + (c.tried && !rateOk ? ' error' : '')}>{c.tried && !rateOk ? 'Enter a rate first' : rateUnit(r.sells_currency, r.gets_currency)}</span>
                          </div>
                          <div className="field">
                            <span className="label" id={'valid-' + r.request_id}>Valid for</span>
                            <div className="seg dark" role="group" aria-labelledby={'valid-' + r.request_id}>
                              {[5, 15, 30].map((m) => (
                                <button key={m} type="button" aria-pressed={c.valid === m} onClick={() => patch(r.request_id, { valid: m })}>{m} min</button>
                              ))}
                            </div>
                          </div>
                          <div className="row" style={{ flex: '1 1 auto', justifyContent: 'flex-end', paddingTop: 27 }}>
                            <button type="button" className="btn btn-quiet" style={{ minHeight: 52 }} onClick={() => patch(r.request_id, { declining: true })}>Can't quote</button>
                            <button type="button" className="btn btn-primary btn-big" onClick={() => send(r)}>{dev > FAR_PCT && c.confirmFar ? 'Send anyway' : 'Send rate'}</button>
                          </div>
                        </div>
                        {dev > FAR_PCT && c.confirmFar && (
                          <p className="alert-box" role="alert">Check the rate: {c.rate} is {dev.toFixed(1)}% away from our standard rate {fmtRate(r.standard_rate)}. Press Send anyway if it is right.</p>
                        )}
                      </>
                    )}
                    {c.declining && (
                      <div style={{ marginTop: 16 }}>
                        <div className="small strong" style={{ marginBottom: 8 }}>Tell {r.kam_name.split(' ')[0]} why</div>
                        <div className="chips">
                          {DECLINE_REASONS.map((reason) => (
                            <button key={reason} type="button" className="chip" onClick={() => decline(r, reason)}>{reason}</button>
                          ))}
                          <button type="button" className="link" onClick={() => patch(r.request_id, { declining: false })}>Back</button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>

          <section className="card flush" aria-labelledby="quotes-title">
            <div className="card-head">
              <h2 id="quotes-title">Today's quotes</h2>
              <span className="small muted">A quote shows "went through" when the client's transaction arrives</span>
            </div>
            {loaded && !quotes.length && <p className="empty">No rates given yet today.</p>}
            {quotes.length > 0 && (
              <div className="table-wrap">
                <table className="table" style={{ minWidth: 720 }}>
                  <thead><tr><th>Client</th><th>Deal</th><th className="num">Rate</th><th>KAM</th><th>Status</th></tr></thead>
                  <tbody>
                    {quotes.map((q) => {
                      const valid = q.quote_state === 'quoted' && new Date(q.valid_until) > new Date();
                      return (
                        <tr key={q.request_id}>
                          <td className="strong">{q.client_name}</td>
                          <td>{describeDeal(q.sells_currency, q.amount, q.gets_currency)}</td>
                          <td className="num strong">{fmtRate(q.rate)}</td>
                          <td>{q.kam_name.split(' ')[0]}</td>
                          <td>
                            {q.went_through ? <span className="pill pill-ok">Went through</span>
                              : valid ? <span className="pill pill-ok">Valid until {fmtTime(q.valid_until)}</span>
                              : <span className="pill pill-wait">Expired at {fmtTime(q.valid_until)}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="col-side">
          <section className="card flush" aria-labelledby="rates-title">
            <div className="card-head" style={{ display: 'block' }}>
              <h2 id="rates-title">Rates now</h2>
              <p className="small" style={{ color: 'var(--ink-2)' }}>GEL per 1 unit. We buy when the client sells.</p>
            </div>
            {!rates.length && <p className="empty">No rates loaded yet. They arrive from the rate feeds (see the setup guide).</p>}
            {gelRows.length > 0 && (
              <table className="table">
                <thead><tr><th>Currency</th><th className="num">NBG</th><th className="num">We buy</th><th className="num">We sell</th></tr></thead>
                <tbody>
                  {gelRows.map((g) => (
                    <tr key={g.ccy}>
                      <th scope="row" className="strong">{g.ccy}</th>
                      <td className="num muted">{fmtRate(g.nbg?.official)}</td>
                      <td className="num strong">{fmtRate(g.std?.buy)}</td>
                      <td className="num strong">{fmtRate(g.std?.sell)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {crossRows.length > 0 && (
              <p className="small" style={{ margin: '12px 24px 0', color: 'var(--ink-2)' }}>
                Cross, our standard: {crossRows.map((c) => `${c.currency} to ${c.quote_currency} ${fmtRate(c.buy)}`).join(', ')}
              </p>
            )}
            {rates.length > 0 && (
              <p className="tiny muted" style={{ margin: '8px 24px 12px' }}>
                {stdAsOf && 'Standard rates as of ' + fmtTime(stdAsOf) + '. '}{nbgAsOf && 'NBG official rate for ' + fmtDay(nbgAsOf.slice(0, 10)) + '.'}
              </p>
            )}
          </section>

          <section className="card" aria-labelledby="given-title">
            <h2 id="given-title">Special rates given today</h2>
            <p className="small" style={{ margin: '4px 0 10px', color: 'var(--ink-2)' }}>By deal direction, including expired ones</p>
            {!groups.size && <p className="empty">None yet.</p>}
            {Array.from(groups.entries()).map(([k, list]) => {
              const [a, b] = k.split('>');
              const values = list.map((x) => Number(x.rate));
              const std = b === 'GEL'
                ? rates.find((x) => x.source === 'standard' && x.currency === a && x.quote_currency === 'GEL')?.buy
                : a === 'GEL'
                  ? rates.find((x) => x.source === 'standard' && x.currency === b && x.quote_currency === 'GEL')?.sell
                  : rates.find((x) => x.source === 'standard' && x.currency === a && x.quote_currency === b)?.buy;
              return (
                <div key={k} style={{ padding: '10px 0', borderTop: '1px solid var(--line-soft)' }}>
                  <div className="row-between"><span className="strong" style={{ fontWeight: 500 }}>Client sells {a} for {b}</span><span className="strong">{fmtRate(values[0])}</span></div>
                  <div className="tiny muted">
                    {values.length} {values.length === 1 ? 'rate' : 'rates'}
                    {values.length > 1 && `, from ${fmtRate(Math.min(...values))} to ${fmtRate(Math.max(...values))}`}
                    {std != null && `. Our standard ${fmtRate(std)}.`}
                  </div>
                </div>
              );
            })}
          </section>

          <section className="card" aria-labelledby="pos-title">
            <h2 id="pos-title">If every valid quote goes through</h2>
            <p className="small" style={{ margin: '4px 0 12px', color: 'var(--ink-2)' }}>Change to each currency position</p>
            {!Object.keys(effect).length && <p className="empty">No valid quotes right now.</p>}
            {Object.entries(effect).map(([ccy, v]) => {
              const eq = usdEq(ccy, v);
              return (
                <div key={ccy} className="row-between" style={{ padding: '8px 0', borderTop: '1px solid var(--line-soft)' }}>
                  <span className="strong">{ccy}</span>
                  <span>
                    <span className="strong">{v >= 0 ? '+' : '−'}{fmtWhole(Math.abs(v))}</span>
                    {eq != null && ccy !== 'USD' && <span className="tiny muted"> (USD {v >= 0 ? '+' : '−'}{fmtAmount(Math.round(Math.abs(eq)))})</span>}
                  </span>
                </div>
              );
            })}
            <p className="tiny muted" style={{ marginTop: 12 }}>Limits: USD 1M per currency at end of day, USD 1.5M during the day. The current position will show here once the core system sends it.</p>
          </section>
        </div>
      </div>
    </>
  );
}
