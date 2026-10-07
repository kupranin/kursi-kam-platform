import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { useLive, useTick } from '../lib/useLive';
import { ago, describeDeal, fmtDay, fmtRate, fmtTime, fmtWhole, longToday, minutesSince, monthOptions, parseAmount, sideAmount, todayTbilisi } from '../lib/format';
import type { RequestRow, Rules } from '../lib/types';
import ClientField, { type ClientInfo } from '../components/ClientField';
import CurrencyPicker from '../components/CurrencyPicker';
import { IconCheck, IconClock, IconPlus } from '../components/Icons';

const PAGE_SIZE = 100;

function readAmount(text: string): { ok: boolean; value: number | null } {
  if (!text.trim()) return { ok: true, value: null };
  const n = parseAmount(text);
  return n > 0 ? { ok: true, value: n } : { ok: false, value: null };
}

function readRate(text: string): { ok: boolean; value: number | null } {
  const clean = text.trim().replace(',', '.');
  if (!clean) return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(clean)) return { ok: false, value: null };
  const n = Number(clean);
  return n > 0 ? { ok: true, value: n } : { ok: false, value: null };
}

function nextMonth(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number);
  if (m === 12) return `${y + 1}-01-01`;
  return `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

const DECLINE_KA: Record<string, string> = {
  'Amount too large': 'თანხა ძალიან დიდია',
  'Market moving too fast': 'ბაზარი ძალიან სწრაფად იცვლება',
  'Need more details': 'მეტი დეტალია საჭირო',
};

function declineLabel(reason: string | null | undefined): string {
  if (!reason) return '';
  return DECLINE_KA[reason] ?? reason;
}

function historyStatus(r: RequestRow): { label: string; cls: string } {
  if (r.went_through || r.outcome === 'went_through') return { label: 'გავიდა', cls: 'pill-ok' };
  if (r.outcome === 'did_not_go_through') return { label: 'არ გავიდა', cls: 'pill-alert' };
  return { label: 'ჯერ ღიაა', cls: 'pill-wait' };
}

function clientReplyRate(r: RequestRow): number | null {
  if (r.client_reply === 'better' && r.given_rate != null) return r.given_rate;
  if (r.client_reply === 'approved' && r.approved_rate != null) return r.approved_rate;
  return r.rate;
}

function clientReplyNote(r: RequestRow): string | null {
  if (r.client_reply === 'approved' && r.approved_rate != null) {
    return `კლიენტმა დაამტკიცა ${fmtRate(r.approved_rate)}. გაეგზავნა სახაზინოს და მენეჯერებს.`;
  }
  if (r.client_reply === 'better') {
    if (r.better_decision === 'accepted' && r.given_rate != null) return `სახაზინომ დაადასტურა ${fmtRate(r.given_rate)}.`;
    if (r.better_decision === 'corrected' && r.given_rate != null) return `გასწორებული კურსი: ${fmtRate(r.given_rate)}.`;
    if (r.wanted_rate != null) return `სახაზინოს ელოდება. კლიენტს სურს ${fmtRate(r.wanted_rate)}.`;
  }
  if (r.client_reply === 'declined' && r.client_decline_reason) {
    return `კლიენტმა უარი თქვა: ${r.client_decline_reason}`;
  }
  return null;
}

export default function Requests() {
  const { profile } = useAuth();
  const toast = useToast();
  useTick(15000);
  const role = profile!.role;
  const isKam = role === 'kam';
  const seeAll = role === 'admin' || role === 'manager';

  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [rules, setRules] = useState<Rules | null>(null);

  const [raw, setRaw] = useState('');
  const [info, setInfo] = useState<ClientInfo | null>(null);
  const [sells, setSells] = useState('USD');
  const [gets, setGets] = useState('GEL');
  const [sellsAmount, setSellsAmount] = useState('');
  const [getsAmount, setGetsAmount] = useState('');
  const [clientRate, setClientRate] = useState('');
  const [note, setNote] = useState('');
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const [history, setHistory] = useState<RequestRow[]>([]);
  const [histCount, setHistCount] = useState<number | null>(null);
  const [histLoaded, setHistLoaded] = useState(false);
  const [histError, setHistError] = useState('');
  const [month, setMonth] = useState('all');
  const [kamFilter, setKamFilter] = useState('all');
  const [kams, setKams] = useState<{ id: string; full_name: string; email: string }[]>([]);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [reply, setReply] = useState<{ id: number; kind: 'approved' | 'better' | 'declined' } | null>(null);
  const [replyRate, setReplyRate] = useState('');
  const [replyReason, setReplyReason] = useState('');
  const [replyTried, setReplyTried] = useState(false);
  const [replyBusy, setReplyBusy] = useState(false);
  const [approvedRows, setApprovedRows] = useState<RequestRow[]>([]);
  const [approvedLoaded, setApprovedLoaded] = useState(false);
  const [approvedError, setApprovedError] = useState('');
  const histReq = useRef(0);
  const months = monthOptions(12).map((m) => ({ value: m.value, label: m.label.replace(', so far', '') }));

  const today = todayTbilisi();

  const load = useCallback(async () => {
    if (!isKam) { setLoaded(true); return; }
    const { data, error } = await supabase
      .from('request_outcomes')
      .select('*')
      .eq('kam_id', profile!.id)
      .or(`request_date.eq.${today},quote_status.eq.asking`)
      .order('asked_at', { ascending: false });
    if (!error) setRows((data ?? []) as RequestRow[]);
    setLoaded(true);
  }, [profile, today, isKam]);

  const loadHistory = useCallback(async () => {
    const ticket = ++histReq.current;
    let q = supabase
      .from('request_outcomes')
      .select('*', { count: 'exact' })
      .order('request_date', { ascending: false })
      .order('requested_at', { ascending: false })
      .range(0, shown - 1);
    // A KAM's history is before today, plus imported rows from today that are not
    // already in "Went through today". Admin and manager see every deal, including today.
    if (isKam) {
      q = q.or(`request_date.lt.${today},and(source.eq.import,went_through.eq.false)`);
      q = q.eq('kam_id', profile!.id);
    } else if (kamFilter !== 'all') {
      q = q.eq('kam_id', kamFilter);
    }
    if (month !== 'all') q = q.gte('request_date', month).lt('request_date', nextMonth(month));
    const { data, error, count } = await q;
    if (ticket !== histReq.current) return;
    if (error) setHistError(error.message);
    else {
      setHistory((data ?? []) as RequestRow[]);
      setHistCount(count ?? 0);
      setHistError('');
    }
    setHistLoaded(true);
  }, [profile, today, isKam, kamFilter, month, shown]);

  const loadApproved = useCallback(async () => {
    if (!seeAll) { setApprovedLoaded(true); return; }
    const { data, error } = await supabase
      .from('request_outcomes')
      .select('*')
      .eq('client_reply', 'approved')
      .gte('request_date', todayTbilisi(-7))
      .order('client_replied_at', { ascending: false })
      .limit(40);
    if (error) setApprovedError('სია ჯერ არ იტვირთება.');
    else {
      setApprovedRows((data ?? []) as RequestRow[]);
      setApprovedError('');
    }
    setApprovedLoaded(true);
  }, [seeAll]);

  useEffect(() => {
    load();
    loadHistory();
    loadApproved();
    if (isKam) supabase.from('rules').select('*').single().then(({ data }) => setRules(data as Rules));
  }, [load, loadHistory, loadApproved, isKam]);
  useLive(['requests'], () => { load(); loadHistory(); loadApproved(); }, 20000);

  useEffect(() => {
    if (!seeAll) return;
    supabase.from('profiles').select('id, full_name, email').eq('role', 'kam').order('full_name')
      .then(({ data }) => setKams((data ?? []) as { id: string; full_name: string; email: string }[]));
  }, [seeAll]);

  const needsName = Boolean(info?.valid && !info?.name);
  const sellsSide = readAmount(sellsAmount);
  const getsSide = readAmount(getsAmount);
  const rateSide = readRate(clientRate);
  const hasAmount = (sellsSide.value != null) || (getsSide.value != null);
  const bothBlank = sellsSide.ok && getsSide.ok && !hasAmount;
  const currenciesOk = Boolean(sells && gets && sells !== gets);
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
    if (!info?.valid || !hasAmount || !sellsSide.ok || !getsSide.ok || !rateSide.ok || !currenciesOk || (needsName && !nameOk)) return;
    setBusy(true);
    try {
      await rpc('log_request', {
        p_client_id: info.id,
        p_sells_currency: sells,
        p_gets_currency: gets,
        p_amount: sellsSide.value,
        p_gets_amount: getsSide.value,
        p_client_rate: rateSide.value,
        p_note: note.trim() || null,
        p_client_name: needsName ? name.trim() : null,
      });
      toast('გაეგზავნა სახაზინოს. კურსი ქვემოთ გამოჩნდება, როგორც კი უპასუხებენ.');
      setRaw(''); setInfo(null); setSellsAmount(''); setGetsAmount(''); setClientRate(''); setNote(''); setName(''); setTried(false);
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(false);
  }

  async function askAgain(r: RequestRow) {
    try {
      await rpc('ask_again', { p_request_id: r.id, p_note: null });
      toast('ხელახლა გაეგზავნა სახაზინოს.');
      load();
    } catch (err) { toast((err as Error).message, 'error'); }
  }

  async function remove(r: RequestRow) {
    if (!window.confirm('წავშალოთ ეს მოთხოვნა? ეს მხოლოდ შეცდომის გასასწორებლად გამოიყენეთ.')) return;
    try {
      await rpc('delete_request', { p_request_id: r.id });
      toast('მოთხოვნა წაიშალა.');
      load();
    } catch (err) { toast((err as Error).message, 'error'); }
  }

  function openReply(id: number, kind: 'approved' | 'better' | 'declined') {
    setReply((cur) => (cur?.id === id && cur.kind === kind ? null : { id, kind }));
    setReplyRate('');
    setReplyReason('');
    setReplyTried(false);
  }

  async function saveReply(r: RequestRow) {
    if (!reply || reply.id !== r.id) return;
    setReplyTried(true);
    const parsed = readRate(replyRate);
    const reason = replyReason.trim();
    if (reply.kind === 'declined') {
      if (reason.length < 2) return;
    } else if (!parsed.ok || parsed.value == null) {
      return;
    }
    setReplyBusy(true);
    try {
      if (reply.kind === 'declined') {
        await rpc('kam_client_reply', { p_request_id: r.id, p_reply: 'declined', p_reason: reason });
        toast('მიზეზი შენახულია.');
      } else {
        await rpc('kam_client_reply', { p_request_id: r.id, p_reply: reply.kind, p_rate: parsed.value });
        toast(reply.kind === 'approved' ? 'გაეგზავნა სახაზინოს და მენეჯერებს.' : 'გაეგზავნა სახაზინოს.');
      }
      setReply(null);
      setReplyRate('');
      setReplyReason('');
      setReplyTried(false);
      load();
      loadApproved();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setReplyBusy(false);
  }

  async function copy(r: RequestRow) {
    const text = `${r.client_name ?? r.client_id}: ყიდის ${sideAmount(r.sells_currency, r.amount)}, იღებს ${sideAmount(r.gets_currency, r.gets_amount)} კურსით ${fmtRate(clientReplyRate(r))}, მოქმედებს ${fmtTime(r.rate_valid_until)}-მდე`;
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked: the label still confirms */ }
    setCopied(r.id);
    window.setTimeout(() => setCopied(null), 3000);
  }

  // a quoted rate whose time has passed is expired, even before the next reload
  const stateOf = (r: RequestRow) =>
    r.quote_state === 'quoted' && r.rate_valid_until && new Date(r.rate_valid_until) < new Date() ? 'expired' : r.quote_state;

  const open = rows.filter((r) => !r.went_through && r.source !== 'import');
  const done = rows.filter((r) => r.went_through && r.request_date === today);
  const todayCount = rows.filter((r) => r.request_date === today).length;
  const deleteMinutes = rules?.request_delete_minutes ?? 15;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>მოთხოვნები</h1>
          <p>{isKam ? longToday() : 'ყველა გარიგება, იმ KAM-ის ქვეშ, ვინც აწარმოა'}</p>
        </div>
        {isKam && <div className="stats">
          <div className="stat"><div className="label">დღეს</div><div className="value">{todayCount}</div></div>
          <div className="stat"><div className="label">ღია</div><div className="value" style={{ color: 'var(--aubergine)' }}>{open.length}</div></div>
          <div className="stat"><div className="label">გავიდა</div><div className="value ok-text">{done.length}</div></div>
        </div>}
      </div>

      {isKam && <section className="card" aria-labelledby="new-title">
        <h2 id="new-title" style={{ marginBottom: 16 }}>ახალი მოთხოვნა</h2>
        <form onSubmit={submit} noValidate>
          <div className="form-row">
            <div style={{ flex: '1 1 230px', minWidth: 210 }}>
              <ClientField value={raw} onChange={setRaw} onInfo={onInfo} tried={tried} />
            </div>
            {needsName && (
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label htmlFor="cname">კლიენტის სახელი</label>
                <input id="cname" className={'input attention' + (tried && !nameOk ? ' invalid' : '')} autoComplete="off" placeholder="კომპანიის ან პირის სრული სახელი" value={name} onChange={(e) => setName(e.target.value)} />
                <span className={'hint' + (tried && !nameOk ? ' error' : '')}>{tried && !nameOk ? 'ჩაწერეთ კლიენტის სახელი' : 'ახალი კლიენტისთვის აუცილებელია. შემდეგ ჯერზე შეინახება.'}</span>
              </div>
            )}
          </div>
          <div className="form-row" style={{ marginTop: 16 }}>
            <div className="deal-side">
              <CurrencyPicker label="კლიენტი ყიდის" value={sells} onChange={pickSells} />
              <div className="field" style={{ flex: '1 1 140px', minWidth: 130 }}>
                <label htmlFor="sells-amount">თანხა</label>
                <input id="sells-amount" className={'input' + (tried && !sellsSide.ok ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={sellsAmount} onChange={(e) => setSellsAmount(e.target.value)} />
                {tried && !sellsSide.ok && <span className="hint error">ჩაწერეთ სწორი თანხა, ან დატოვეთ ეს მხარე ცარიელი</span>}
              </div>
            </div>
            <div className="deal-side">
              <CurrencyPicker label="კლიენტი იღებს" value={gets} onChange={setGets} disabledValue={sells} />
              <div className="field" style={{ flex: '1 1 140px', minWidth: 130 }}>
                <label htmlFor="gets-amount">თანხა</label>
                <input id="gets-amount" className={'input' + (tried && !getsSide.ok ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={getsAmount} onChange={(e) => setGetsAmount(e.target.value)} />
                {tried && !getsSide.ok && <span className="hint error">ჩაწერეთ სწორი თანხა, ან დატოვეთ ეს მხარე ცარიელი</span>}
              </div>
            </div>
          </div>
          <p className={'hint' + (tried && (!currenciesOk || bothBlank) ? ' error' : '')} style={{ margin: '8px 0 0' }}>
            {tried && !currenciesOk
              ? 'აირჩიეთ ორი განსხვავებული ვალუტა'
              : tried && bothBlank
                ? 'ჩაწერეთ თანხა ერთ მხარეს'
                : 'შეავსეთ ერთი თანხა. მეორე დატოვეთ ცარიელი, თუ არ გაქვთ.'}
          </p>
          <div className="form-row" style={{ marginTop: 16 }}>
            <div className="field" style={{ flex: '1 1 200px', minWidth: 180 }}>
              <label htmlFor="client-rate">კურსი, რომელსაც კლიენტი ითხოვს <span className="muted" style={{ fontWeight: 400 }}>(არასავალდებულო)</span></label>
              <input id="client-rate" className={'input' + (tried && !rateSide.ok ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={clientRate} onChange={(e) => setClientRate(e.target.value)} />
              <span className={'hint' + (tried && !rateSide.ok ? ' error' : '')}>{tried && !rateSide.ok ? 'ჩაწერეთ კურსი, რომელსაც კლიენტი ითხოვს, ან დატოვეთ ცარიელი' : 'დატოვეთ ცარიელი, თუ კლიენტს კურსი არ უთხოვია'}</span>
            </div>
            <div className="field" style={{ flex: '2 1 240px', minWidth: 200 }}>
              <label htmlFor="treasury-comment">კომენტარი სახაზინოსთვის <span className="muted" style={{ fontWeight: 400 }}>(არასავალდებულო)</span></label>
              <input id="treasury-comment" className="input" autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div style={{ paddingTop: 27 }}>
              <button type="submit" className="btn btn-primary" style={{ minHeight: 48 }} disabled={busy}><IconPlus />{busy ? 'იგზავნება…' : 'კურსის თხოვნა სახაზინოს'}</button>
            </div>
          </div>
        </form>
      </section>}

      {isKam && <section className="card flush" aria-labelledby="open-title">
        <div className="card-head">
          <h2 id="open-title" style={{ fontSize: 22 }}>ღია მოთხოვნები</h2>
          <span className="small muted">სახაზინოს კურსი აქ ჩნდება. მოთხოვნა თავისით იხურება, როცა კლიენტის ტრანზაქცია მოდის.</span>
        </div>
        {loaded && !open.length && <p className="empty">ღია მოთხოვნა არ არის. მოთხოვნა აქ ჩნდება, როგორც კი სახაზინოს გაუგზავნით.</p>}
        {open.map((r) => {
          const st = stateOf(r);
          const fresh = st === 'asking' && r.source === 'app' && minutesSince(r.requested_at) < deleteMinutes;
          const answer = clientReplyNote(r);
          const canAnswer = st === 'quoted' && !r.client_reply;
          const replyOpen = canAnswer && reply?.id === r.id ? reply.kind : null;
          const parsedReply = readRate(replyRate);
          const replyRateOk = parsedReply.ok && parsedReply.value != null;
          const replyReasonOk = replyReason.trim().length >= 2;
          const canAskAgain = (st === 'expired' || st === 'declined')
            && r.client_reply !== 'approved'
            && !(r.client_reply === 'better' && !r.better_decision);
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
                <div>{describeDeal(r.sells_currency, r.amount, r.gets_currency, r.gets_amount)}</div>
                {r.client_rate != null && <div className="tiny muted">კურსი, რომელსაც კლიენტი ითხოვს: {fmtRate(r.client_rate)}</div>}
                {r.note && <div className="tiny muted">კომენტარი: {r.note}</div>}
                {answer
                  ? <div className="tiny muted">{answer}</div>
                  : (
                    <div className="tiny muted">
                      {st === 'asking' && 'იკითხა ' + fmtTime(r.asked_at) + '-ზე'}
                      {st === 'quoted' && 'კლიენტს უთხარით კურსი და ჩაწერეთ პასუხი.'}
                      {st === 'expired' && 'ხელახლა იკითხეთ, თუ კლიენტს კვლავ სურს კონვერტაცია'}
                      {st === 'declined' && 'დაამატეთ დეტალები და ხელახლა იკითხეთ'}
                    </div>
                  )}
              </div>
              {st === 'asking' && <span className="pill pill-wait"><IconClock />სახაზინოს ელოდება</span>}
              {st === 'quoted' && <span className="pill pill-warn">კურსი {fmtRate(r.rate)}, მოქმედებს {fmtTime(r.rate_valid_until)}-მდე</span>}
              {st === 'expired' && <span className="pill pill-wait">კურსი {fmtRate(r.rate)}, ვადა გაუვიდა {fmtTime(r.rate_valid_until)}-ზე</span>}
              {st === 'declined' && <span className="pill pill-alert">სახაზინო: {declineLabel(r.decline_reason)}</span>}
              <div className="actions">
                {st === 'quoted' && r.client_reply !== 'declined' && <button type="button" className="btn btn-primary" onClick={() => copy(r)}>{copied === r.id ? 'დაკოპირდა' : 'კოპირება კლიენტისთვის'}</button>}
                {canAnswer && (
                  <>
                    <button type="button" className="btn btn-primary" aria-pressed={replyOpen === 'approved'} onClick={() => openReply(r.id, 'approved')}>კლიენტმა დაამტკიცა</button>
                    <button type="button" className="btn" aria-pressed={replyOpen === 'better'} onClick={() => openReply(r.id, 'better')}>კლიენტს უკეთესი კურსი სურს</button>
                    <button type="button" className="btn btn-quiet" aria-pressed={replyOpen === 'declined'} onClick={() => openReply(r.id, 'declined')}>კლიენტმა უარი თქვა</button>
                  </>
                )}
                {canAskAgain && <button type="button" className="btn" onClick={() => askAgain(r)}>ხელახლა კითხვა</button>}
                {fresh && <button type="button" className="link danger" onClick={() => remove(r)}>წაშლა</button>}
              </div>
              {replyOpen && (
                <form onSubmit={(e) => { e.preventDefault(); saveReply(r); }} noValidate style={{ flex: '1 1 100%', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
                  {replyOpen !== 'declined' ? (
                    <div className="field" style={{ flex: '1 1 200px', maxWidth: 280 }}>
                      <label htmlFor={'reply-rate-' + r.id}>ჩაწერეთ კურსი</label>
                      <input id={'reply-rate-' + r.id} className={'input' + (replyTried && !replyRateOk ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={replyRate} onChange={(e) => setReplyRate(e.target.value)} />
                      <span className={'hint' + (replyTried && !replyRateOk ? ' error' : '')}>
                        {replyTried && !replyRateOk ? 'ჩაწერეთ კურსი' : replyOpen === 'approved' ? 'მოთხოვნა მიდის სახაზინოსთან და მენეჯერებთან.' : 'მოთხოვნა მიდის მხოლოდ სახაზინოსთან.'}
                      </span>
                    </div>
                  ) : (
                    <div className="field" style={{ flex: '1 1 280px' }}>
                      <label htmlFor={'reply-reason-' + r.id}>მიზეზი</label>
                      <input id={'reply-reason-' + r.id} className={'input' + (replyTried && !replyReasonOk ? ' invalid' : '')} autoComplete="off" value={replyReason} onChange={(e) => setReplyReason(e.target.value)} />
                      <span className={'hint' + (replyTried && !replyReasonOk ? ' error' : '')}>
                        {replyTried && !replyReasonOk ? 'ჩაწერეთ მიზეზი' : 'სახაზინო დაინახავს მიზეზს.'}
                      </span>
                    </div>
                  )}
                  <button type="submit" className="btn btn-primary" disabled={replyBusy}>{replyBusy ? 'იგზავნება…' : replyOpen === 'declined' ? 'შენახვა' : 'გაგზავნა'}</button>
                  <button type="button" className="link" onClick={() => setReply(null)}>უკან</button>
                </form>
              )}
            </div>
          );
        })}
      </section>}

      {isKam && <section className="card flush" aria-labelledby="done-title">
        <div className="card-head"><h2 id="done-title" style={{ fontSize: 18 }}>დღეს გავიდა</h2></div>
        {loaded && !done.length && <p className="empty">დღეს ჯერ არაფერია.</p>}
        {done.map((r) => (
          <div key={r.id} className="list-row" style={{ paddingTop: 12, paddingBottom: 12 }}>
            <span className="when muted">{fmtTime(r.requested_at)}</span>
            <span className="who strong">{r.client_name ?? r.client_id}</span>
            <span className="what">{describeDeal(r.sells_currency, r.amount, r.gets_currency, r.gets_amount)}{r.rate ? ' კურსით ' + fmtRate(r.rate) : ''}</span>
            <span className="pill pill-ok" style={{ marginLeft: 'auto' }}><IconCheck />გავიდა</span>
          </div>
        ))}
      </section>}

      {seeAll && <section className="card flush" aria-labelledby="approved-title">
        <div className="card-head">
          <div>
            <h2 id="approved-title" style={{ fontSize: 22 }}>კლიენტმა დაამტკიცა</h2>
            <p className="small muted">ბოლო 7 დღის დადასტურებები. სახაზინოც და მენეჯერებიც ხედავენ.</p>
          </div>
        </div>
        {approvedError && <p className="empty">{approvedError}</p>}
        {approvedLoaded && !approvedError && !approvedRows.length && <p className="empty">ჯერ არაფერია.</p>}
        {approvedRows.map((r) => (
          <div key={r.id} className="list-row">
            <div className="when">
              <div className="strong">{fmtDay(r.request_date)}</div>
              <div className="tiny muted">{fmtTime(r.client_replied_at ?? r.requested_at)}</div>
            </div>
            <div className="who">
              <div className="name">{r.client_name ?? r.client_id}</div>
              <div className="tiny muted">ID {r.client_id}</div>
              <div className="small">{r.kam_name ?? 'KAM არ არის'}</div>
            </div>
            <div className="what">
              <div>{describeDeal(r.sells_currency, r.amount, r.gets_currency, r.gets_amount)}</div>
              <div>კლიენტმა დაამტკიცა {fmtRate(r.approved_rate)}</div>
              {r.rate != null && <div className="tiny muted">სახაზინოს კურსი: {fmtRate(r.rate)}</div>}
            </div>
          </div>
        ))}
      </section>}

      <section className="card flush" aria-labelledby="history-title">
        <div className="card-head">
          <div>
            <h2 id="history-title" style={{ fontSize: 22 }}>{isKam ? 'წინა მოთხოვნები' : 'ყველა მოთხოვნა'}</h2>
            <p className="small muted">
              {isKam
                ? 'თქვენი გარიგებები დღევანდელამდე, შეთანხმების ფაილის ჩათვლით. დასრულებული გარიგება აქ რჩება, როგორც გავიდა.'
                : 'დღევანდელი და ყველა ძველი გარიგება, იმ KAM-ის ქვეშ, ვინც გააკეთა. აირჩიეთ ერთი ადამიანი ან ერთი თვე, ან დატოვეთ ორივე „ყველა“-ზე.'}
              {histLoaded && histCount != null ? ` ${fmtWhole(histCount)} ამ ხედში.` : ''}
            </p>
          </div>
          <div className="row">
            {seeAll && (
              <label className="field" style={{ flex: '0 1 280px' }}>
                <span className="sr-only">KAM</span>
                <select className="select" style={{ width: 'auto' }} value={kamFilter} onChange={(e) => { setKamFilter(e.target.value); setShown(PAGE_SIZE); setHistory([]); setHistCount(null); setHistError(''); setHistLoaded(false); }}>
                  <option value="all">ყველა KAM</option>
                  {kams.map((k) => <option key={k.id} value={k.id}>{k.full_name}</option>)}
                </select>
              </label>
            )}
            <label className="field" style={{ flex: '0 1 220px' }}>
              <span className="sr-only">თვე</span>
              <select className="select" style={{ width: 'auto' }} value={month} onChange={(e) => { setMonth(e.target.value); setShown(PAGE_SIZE); setHistory([]); setHistCount(null); setHistError(''); setHistLoaded(false); }}>
                <option value="all">ყველა თვე</option>
                {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
          </div>
        </div>
        {histError && <p className="alert-box" role="alert">{histError}</p>}
        {!histLoaded && <p className="empty">იტვირთება…</p>}
        {histLoaded && !histError && !history.length && (
          <p className="empty">
            {month === 'all' && kamFilter === 'all'
              ? 'წინა მოთხოვნა ჯერ არ არის. აქ გამოჩნდება, როცა შეთანხმების ფაილი ჩაიტვირთება.'
              : 'ამ არჩევანზე არაფერია.'}
          </p>
        )}
        {histLoaded && history.map((r) => {
          const st = historyStatus(r);
          return (
            <div key={r.id} className="list-row">
              <div className="when">
                <div className="strong">{fmtDay(r.request_date)}</div>
                <div className="tiny muted">{fmtTime(r.requested_at)}</div>
              </div>
              <div className="who">
                <div className="name">{r.client_name ?? r.client_id}</div>
                <div className="tiny muted">ID {r.client_id}</div>
                {seeAll && <div className="small">{r.kam_name ?? 'KAM არ არის'}</div>}
              </div>
              <div className="what">
                <div>{describeDeal(r.sells_currency, r.amount, r.gets_currency, r.gets_amount)}{r.rate ? ' კურსით ' + fmtRate(r.rate) : ''}</div>
                {r.client_rate != null && <div className="tiny muted">კურსი, რომელსაც კლიენტი ითხოვს: {fmtRate(r.client_rate)}</div>}
                {r.note && <div className="tiny muted">კომენტარი: {r.note}</div>}
                {r.loss_reason_note && <div className="tiny muted">სხვა მიზეზი: {r.loss_reason_note}</div>}
                {clientReplyNote(r) && <div className="tiny muted">{clientReplyNote(r)}</div>}
              </div>
              <span className={'pill ' + st.cls} style={{ marginLeft: 'auto' }}>
                {st.cls === 'pill-ok' && <IconCheck />}{st.label}
              </span>
            </div>
          );
        })}
        {histLoaded && history.length < (histCount ?? 0) && (
          <p className="empty">
            <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE_SIZE)}>მეტის ჩვენება</button>
            <span className="small muted" style={{ marginLeft: 12 }}>{fmtWhole(history.length)} {fmtWhole(histCount)}-დან</span>
          </p>
        )}
      </section>
    </>
  );
}
