import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { useLive, useTick } from '../lib/useLive';
import { ago, describeDeal, fmtAmount, fmtRate, fmtTime, longToday, minutesSince, parseAmount, todayTbilisi } from '../lib/format';
import type { RequestRow, Rules } from '../lib/types';
import ClientField, { type ClientInfo } from '../components/ClientField';
import CurrencyPicker from '../components/CurrencyPicker';
import { IconCheck, IconClock, IconPlus } from '../components/Icons';

export default function Requests() {
  const { profile } = useAuth();
  const toast = useToast();
  useTick(15000);

  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [rules, setRules] = useState<Rules | null>(null);

  const [raw, setRaw] = useState('');
  const [info, setInfo] = useState<ClientInfo | null>(null);
  const [sells, setSells] = useState('USD');
  const [gets, setGets] = useState('GEL');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);

  const today = todayTbilisi();

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('request_outcomes')
      .select('*')
      .eq('kam_id', profile!.id)
      .or(`request_date.eq.${today},quote_status.eq.asking`)
      .order('asked_at', { ascending: false });
    if (!error) setRows((data ?? []) as RequestRow[]);
    setLoaded(true);
  }, [profile, today]);

  useEffect(() => {
    load();
    supabase.from('rules').select('*').single().then(({ data }) => setRules(data as Rules));
  }, [load]);
  useLive(['requests'], load, 20000);

  const needsName = Boolean(info?.valid && !info?.name);
  const amountNum = parseAmount(amount);
  const amountOk = amountNum > 0;
  const nameOk = name.trim().length >= 2;

  function onInfo(next: ClientInfo | null) {
    setInfo(next);
    if (next?.picked && next.lastSells && next.lastGets) {
      setSells(next.lastSells);
      setGets(next.lastGets);
    }
  }

  function pickSells(c: string) {
    setSells(c);
    if (gets === c) setGets(c === 'GEL' ? 'USD' : 'GEL');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!info?.valid || !amountOk || (needsName && !nameOk)) return;
    setBusy(true);
    try {
      await rpc('log_request', {
        p_client_id: info.id,
        p_sells_currency: sells,
        p_gets_currency: gets,
        p_amount: amountNum,
        p_note: note.trim() || null,
        p_client_name: needsName ? name.trim() : null,
      });
      toast('Sent to treasury. The rate appears below as soon as they answer.');
      setRaw(''); setInfo(null); setAmount(''); setNote(''); setName(''); setTried(false);
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(false);
  }

  async function askAgain(r: RequestRow) {
    try {
      await rpc('ask_again', { p_request_id: r.id, p_note: null });
      toast('Asked treasury again.');
      load();
    } catch (err) { toast((err as Error).message, 'error'); }
  }

  async function remove(r: RequestRow) {
    if (!window.confirm('Delete this request? Use this only to fix a mistake.')) return;
    try {
      await rpc('delete_request', { p_request_id: r.id });
      toast('Request deleted.');
      load();
    } catch (err) { toast((err as Error).message, 'error'); }
  }

  async function copy(r: RequestRow) {
    const text = `${r.client_name ?? r.client_id}: ${r.sells_currency} ${fmtAmount(r.amount)} to ${r.gets_currency} at ${fmtRate(r.rate)}, valid until ${fmtTime(r.rate_valid_until)}`;
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked: the label still confirms */ }
    setCopied(r.id);
    window.setTimeout(() => setCopied(null), 3000);
  }

  // a quoted rate whose time has passed is expired, even before the next reload
  const stateOf = (r: RequestRow) =>
    r.quote_state === 'quoted' && r.rate_valid_until && new Date(r.rate_valid_until) < new Date() ? 'expired' : r.quote_state;

  const open = rows.filter((r) => !r.went_through);
  const done = rows.filter((r) => r.went_through && r.request_date === today);
  const todayCount = rows.filter((r) => r.request_date === today).length;
  const deleteMinutes = rules?.request_delete_minutes ?? 15;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Requests</h1>
          <p>{longToday()}</p>
        </div>
        <div className="stats">
          <div className="stat"><div className="label">Today</div><div className="value">{todayCount}</div></div>
          <div className="stat"><div className="label">Open</div><div className="value" style={{ color: 'var(--aubergine)' }}>{open.length}</div></div>
          <div className="stat"><div className="label">Went through</div><div className="value ok-text">{done.length}</div></div>
        </div>
      </div>

      <section className="card" aria-labelledby="new-title">
        <h2 id="new-title" style={{ marginBottom: 16 }}>New request</h2>
        <form onSubmit={submit} noValidate>
          <div className="form-row">
            <div style={{ flex: '1 1 230px', minWidth: 210 }}>
              <ClientField value={raw} onChange={setRaw} onInfo={onInfo} tried={tried} />
            </div>
            {needsName && (
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label htmlFor="cname">Client name</label>
                <input id="cname" className={'input attention' + (tried && !nameOk ? ' invalid' : '')} autoComplete="off" placeholder="Company or person's full name" value={name} onChange={(e) => setName(e.target.value)} />
                <span className={'hint' + (tried && !nameOk ? ' error' : '')}>{tried && !nameOk ? "Enter the client's name" : 'Required for a new client. Saved for next time.'}</span>
              </div>
            )}
            <CurrencyPicker label="Client sells" value={sells} onChange={pickSells} />
            <div className="field" style={{ flex: '1 1 140px', minWidth: 130 }}>
              <label htmlFor="amount">Amount</label>
              <input id="amount" className={'input' + (tried && !amountOk ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
              {tried && !amountOk && <span className="hint error">Enter the amount</span>}
            </div>
            <CurrencyPicker label="Client gets" value={gets} onChange={setGets} disabledValue={sells} />
            <div className="field" style={{ flex: '2 1 220px', minWidth: 200 }}>
              <label htmlFor="note">Note for treasury <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
              <input id="note" className="input" autoComplete="off" placeholder="e.g. client's bank offers 2.6900" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div style={{ paddingTop: 27 }}>
              <button type="submit" className="btn btn-primary" style={{ minHeight: 48 }} disabled={busy}><IconPlus />{busy ? 'Sending…' : 'Ask treasury for a rate'}</button>
            </div>
          </div>
        </form>
      </section>

      <section className="card flush" aria-labelledby="open-title">
        <div className="card-head">
          <h2 id="open-title" style={{ fontSize: 22 }}>Open requests</h2>
          <span className="small muted">Treasury's rate appears here. Each request closes by itself when the client's transaction arrives.</span>
        </div>
        {loaded && !open.length && <p className="empty">No open requests. A request appears here as soon as you send it to treasury.</p>}
        {open.map((r) => {
          const st = stateOf(r);
          const fresh = st === 'asking' && r.source === 'app' && minutesSince(r.requested_at) < deleteMinutes;
          return (
            <div key={r.id} className={'list-row' + (st === 'quoted' ? ' highlight' : '')}>
              <div className="when">
                <div className="strong">{fmtTime(r.requested_at)}</div>
                <div className="tiny muted">{ago(r.asked_at)}</div>
              </div>
              <div className="who">
                <div className="name">{r.client_name ?? r.client_id}</div>
                <div className="tiny muted">ID {r.client_id}</div>
              </div>
              <div className="what">
                <div>{describeDeal(r.sells_currency, r.amount, r.gets_currency)}</div>
                <div className="tiny muted">
                  {st === 'asking' && (r.note ? 'Note: ' + r.note : 'Asked at ' + fmtTime(r.asked_at))}
                  {st === 'quoted' && 'Tell the client, then wait for their transaction'}
                  {st === 'expired' && 'Ask again if the client still wants to convert'}
                  {st === 'declined' && 'Add details and ask again'}
                </div>
              </div>
              {st === 'asking' && <span className="pill pill-wait"><IconClock />Waiting for treasury</span>}
              {st === 'quoted' && <span className="pill pill-warn">Rate {fmtRate(r.rate)}, valid until {fmtTime(r.rate_valid_until)}</span>}
              {st === 'expired' && <span className="pill pill-wait">Rate {fmtRate(r.rate)} expired at {fmtTime(r.rate_valid_until)}</span>}
              {st === 'declined' && <span className="pill pill-alert">Treasury: {r.decline_reason}</span>}
              <div className="actions">
                {st === 'quoted' && <button type="button" className="btn btn-primary" onClick={() => copy(r)}>{copied === r.id ? 'Copied' : 'Copy for client'}</button>}
                {(st === 'expired' || st === 'declined') && <button type="button" className="btn" onClick={() => askAgain(r)}>Ask again</button>}
                {fresh && <button type="button" className="link danger" onClick={() => remove(r)}>Delete</button>}
              </div>
            </div>
          );
        })}
      </section>

      <section className="card flush" aria-labelledby="done-title">
        <div className="card-head"><h2 id="done-title" style={{ fontSize: 18 }}>Went through today</h2></div>
        {loaded && !done.length && <p className="empty">Nothing yet today.</p>}
        {done.map((r) => (
          <div key={r.id} className="list-row" style={{ paddingTop: 12, paddingBottom: 12 }}>
            <span className="when muted">{fmtTime(r.requested_at)}</span>
            <span className="who strong">{r.client_name ?? r.client_id}</span>
            <span className="what">{describeDeal(r.sells_currency, r.amount, r.gets_currency)}{r.rate ? ' at ' + fmtRate(r.rate) : ''}</span>
            <span className="pill pill-ok" style={{ marginLeft: 'auto' }}><IconCheck />Went through</span>
          </div>
        ))}
      </section>
    </>
  );
}
