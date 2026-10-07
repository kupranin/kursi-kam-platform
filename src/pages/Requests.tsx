import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useToast } from '../lib/toast';
import { useLive, useTick } from '../lib/useLive';
import { chatHandoff, clientOffer, rateBooked } from '../lib/copyText';
import { ago, describeDeal, fmtDay, fmtRate, fmtTime, fmtWhole, longToday, minutesSince, monthOptions, parseAmount, todayTbilisi } from '../lib/format';
import { treasuryReason } from '../lib/requestStatus';
import type { RequestRow, Rules } from '../lib/types';
import ClientField, { type ClientInfo } from '../components/ClientField';
import CopyLine from '../components/CopyLine';
import CurrencyPicker from '../components/CurrencyPicker';
import { IconCheck, IconClock, IconPlus } from '../components/Icons';

const PAGE_SIZE = 100;

async function attachWritten(rows: RequestRow[]): Promise<RequestRow[]> {
  const ids = rows.filter((r) => r.client_reply === 'approved' && r.approved_rate != null).map((r) => r.id);
  if (!ids.length) return rows;
  const { data, error } = await supabase.from('requests').select('id, rate_written_at').in('id', ids);
  if (error || !data) return rows;
  const written = new Map((data as { id: number; rate_written_at: string | null }[]).map((row) => [row.id, row.rate_written_at]));
  return rows.map((r) => (written.has(r.id) ? { ...r, rate_written_at: written.get(r.id) ?? null } : r));
}

function bookedLine(r: RequestRow): string | null {
  if (r.client_reply !== 'approved' || r.approved_rate == null || !r.rate_written_at) return null;
  return rateBooked(r.approved_rate);
}

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

function historyStatus(r: RequestRow, went: string, missed: string, open: string): { label: string; cls: string } {
  if (r.went_through || r.outcome === 'went_through') return { label: went, cls: 'pill-ok' };
  if (r.outcome === 'did_not_go_through') return { label: missed, cls: 'pill-alert' };
  return { label: open, cls: 'pill-wait' };
}

function clientReplyNote(r: RequestRow, t: (ka: string, en: string, vars?: Record<string, string | number>) => string): string | null {
  if (r.client_reply === 'approved' && r.approved_rate != null) {
    return t('კლიენტმა დაამტკიცა {rate}. გაეგზავნა სახაზინოს და მენეჯერებს.', 'Client approved {rate}. Sent to treasury and managers.', { rate: fmtRate(r.approved_rate) });
  }
  if (r.client_reply === 'better') {
    if (r.better_decision === 'accepted' && r.given_rate != null) return t('სახაზინომ დაადასტურა {rate}.', 'Treasury accepted {rate}.', { rate: fmtRate(r.given_rate) });
    if (r.better_decision === 'corrected' && r.given_rate != null) return t('გასწორებული კურსი: {rate}.', 'Corrected rate: {rate}.', { rate: fmtRate(r.given_rate) });
    if (r.wanted_rate != null) return t('სახაზინოს ელოდება. კლიენტს სურს {rate}.', 'Waiting on treasury. The client wants {rate}.', { rate: fmtRate(r.wanted_rate) });
  }
  if (r.client_reply === 'declined' && r.client_decline_reason) {
    return t('კლიენტმა უარი თქვა: {reason}', 'Client declined: {reason}', { reason: r.client_decline_reason });
  }
  return null;
}

export default function Requests() {
  const { profile } = useAuth();
  const { t, lang } = useI18n();
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
  const months = monthOptions(12).map((m) => ({ value: m.value, label: m.label.replace(/, so far$|, ჯერჯერობით$/, '') }));

  const today = todayTbilisi();

  const load = useCallback(async () => {
    if (!isKam) { setLoaded(true); return; }
    const { data, error } = await supabase
      .from('request_outcomes')
      .select('*')
      .eq('kam_id', profile!.id)
      .or(`request_date.eq.${today},quote_status.eq.asking`)
      .order('asked_at', { ascending: false });
    if (!error) setRows(await attachWritten((data ?? []) as RequestRow[]));
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
      const written = await attachWritten((data ?? []) as RequestRow[]);
      if (ticket !== histReq.current) return;
      setHistory(written);
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
    if (error) setApprovedError(t('სია ჯერ არ იტვირთება.', 'This list is not loading yet.'));
    else {
      setApprovedRows(await attachWritten((data ?? []) as RequestRow[]));
      setApprovedError('');
    }
    setApprovedLoaded(true);
  }, [seeAll, t]);

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
      toast(t('გაეგზავნა სახაზინოს. კურსი ქვემოთ გამოჩნდება, როგორც კი უპასუხებენ.', 'Sent to treasury. The rate appears below as soon as they answer.'));
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
      toast(t('ხელახლა გაეგზავნა სახაზინოს.', 'Sent to treasury again.'));
      load();
    } catch (err) { toast((err as Error).message, 'error'); }
  }

  async function remove(r: RequestRow) {
    if (!window.confirm(t('წავშალოთ ეს მოთხოვნა? ეს მხოლოდ შეცდომის გასასწორებლად გამოიყენეთ.', 'Delete this request? Use this only to fix a mistake.'))) return;
    try {
      await rpc('delete_request', { p_request_id: r.id });
      toast(t('მოთხოვნა წაიშალა.', 'Request deleted.'));
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
      await rpc('kam_client_reply', {
        p_request_id: r.id,
        p_reply: reply.kind,
        p_rate: reply.kind === 'declined' ? null : parsed.value,
        p_reason: reply.kind === 'declined' ? reason : null,
      });
      toast(reply.kind === 'approved'
        ? t('გაეგზავნა სახაზინოს და მენეჯერებს.', 'Sent to treasury and managers.')
        : reply.kind === 'better'
          ? t('გაეგზავნა სახაზინოს.', 'Sent to treasury.')
          : t('მიზეზი შენახულია.', 'Reason saved.'));
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
          <h1>{t('მოთხოვნები', 'Requests')}</h1>
          <p>{isKam ? longToday() : t('ყველა გარიგება, იმ KAM-ის ქვეშ, ვინც აწარმოა', 'Every deal, under the KAM who ran it')}</p>
        </div>
        {isKam && <div className="stats">
          <div className="stat"><div className="label">{t('დღეს', 'Today')}</div><div className="value">{todayCount}</div></div>
          <div className="stat"><div className="label">{t('ღია', 'Open')}</div><div className="value" style={{ color: 'var(--aubergine)' }}>{open.length}</div></div>
          <div className="stat"><div className="label">{t('გავიდა', 'Went through')}</div><div className="value ok-text">{done.length}</div></div>
        </div>}
      </div>

      {isKam && <section className="card" aria-labelledby="new-title">
        <h2 id="new-title" style={{ marginBottom: 16 }}>{t('ახალი მოთხოვნა', 'New request')}</h2>
        <form onSubmit={submit} noValidate>
          <div className="form-row">
            <div style={{ flex: '1 1 230px', minWidth: 210 }}>
              <ClientField value={raw} onChange={setRaw} onInfo={onInfo} tried={tried} />
            </div>
            {needsName && (
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label htmlFor="cname">{t('კლიენტის სახელი', 'Client name')}</label>
                <input id="cname" className={'input attention' + (tried && !nameOk ? ' invalid' : '')} autoComplete="off" placeholder={t('კომპანიის ან პირის სრული სახელი', 'Full name of the company or person')} value={name} onChange={(e) => setName(e.target.value)} />
                <span className={'hint' + (tried && !nameOk ? ' error' : '')}>{tried && !nameOk ? t('ჩაწერეთ კლიენტის სახელი', 'Enter the client name') : t('ახალი კლიენტისთვის აუცილებელია. შემდეგ ჯერზე შეინახება.', 'Required for a new client. It is saved for next time.')}</span>
              </div>
            )}
          </div>
          <div className="form-row" style={{ marginTop: 16 }}>
            <div className="deal-side">
              <CurrencyPicker label={t('კლიენტი ყიდის', 'Client sells')} value={sells} onChange={pickSells} />
              <div className="field" style={{ flex: '1 1 140px', minWidth: 130 }}>
                <label htmlFor="sells-amount">{t('თანხა', 'Amount')}</label>
                <input id="sells-amount" className={'input' + (tried && !sellsSide.ok ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={sellsAmount} onChange={(e) => setSellsAmount(e.target.value)} />
                {tried && !sellsSide.ok && <span className="hint error">{t('ჩაწერეთ სწორი თანხა, ან დატოვეთ ეს მხარე ცარიელი', 'Enter a valid amount, or leave this side blank')}</span>}
              </div>
            </div>
            <div className="deal-side">
              <CurrencyPicker label={t('კლიენტი იღებს', 'Client gets')} value={gets} onChange={setGets} disabledValue={sells} />
              <div className="field" style={{ flex: '1 1 140px', minWidth: 130 }}>
                <label htmlFor="gets-amount">{t('თანხა', 'Amount')}</label>
                <input id="gets-amount" className={'input' + (tried && !getsSide.ok ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={getsAmount} onChange={(e) => setGetsAmount(e.target.value)} />
                {tried && !getsSide.ok && <span className="hint error">{t('ჩაწერეთ სწორი თანხა, ან დატოვეთ ეს მხარე ცარიელი', 'Enter a valid amount, or leave this side blank')}</span>}
              </div>
            </div>
          </div>
          <p className={'hint' + (tried && (!currenciesOk || bothBlank) ? ' error' : '')} style={{ margin: '8px 0 0' }}>
            {tried && !currenciesOk
              ? t('აირჩიეთ ორი განსხვავებული ვალუტა', 'Choose two different currencies')
              : tried && bothBlank
                ? t('ჩაწერეთ თანხა ერთ მხარეს', 'Enter an amount on one side')
                : t('შეავსეთ ერთი თანხა. მეორე დატოვეთ ცარიელი, თუ არ გაქვთ.', 'Fill in one amount. Leave the other blank if you do not have it.')}
          </p>
          <div className="form-row" style={{ marginTop: 16 }}>
            <div className="field" style={{ flex: '1 1 200px', minWidth: 180 }}>
              <label htmlFor="client-rate">{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')} <span className="muted" style={{ fontWeight: 400 }}>({t('არასავალდებულო', 'optional')})</span></label>
              <input id="client-rate" className={'input' + (tried && !rateSide.ok ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={clientRate} onChange={(e) => setClientRate(e.target.value)} />
              <span className={'hint' + (tried && !rateSide.ok ? ' error' : '')}>{tried && !rateSide.ok ? t('ჩაწერეთ კურსი, რომელსაც კლიენტი ითხოვს, ან დატოვეთ ცარიელი', 'Enter the rate the client wants, or leave it blank') : t('დატოვეთ ცარიელი, თუ კლიენტს კურსი არ უთხოვია', 'Leave blank if the client did not ask for a rate')}</span>
            </div>
            <div className="field" style={{ flex: '2 1 240px', minWidth: 200 }}>
              <label htmlFor="treasury-comment">{t('კომენტარი სახაზინოსთვის', 'Comment for treasury')} <span className="muted" style={{ fontWeight: 400 }}>({t('არასავალდებულო', 'optional')})</span></label>
              <input id="treasury-comment" className="input" autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div style={{ paddingTop: 27 }}>
              <button type="submit" className="btn btn-primary" style={{ minHeight: 48 }} disabled={busy}><IconPlus />{busy ? t('იგზავნება…', 'Sending…') : t('კურსის თხოვნა სახაზინოს', 'Ask treasury for a rate')}</button>
            </div>
          </div>
        </form>
      </section>}

      {isKam && <section className="card flush" aria-labelledby="open-title">
        <div className="card-head">
          <h2 id="open-title" style={{ fontSize: 22 }}>{t('ღია მოთხოვნები', 'Open requests')}</h2>
          <span className="small muted">{t('სახაზინოს კურსი აქ ჩნდება. მოთხოვნა თავისით იხურება, როცა კლიენტის ტრანზაქცია მოდის.', 'Treasury’s rate appears here. The request closes itself when the client’s transaction arrives.')}</span>
        </div>
        {loaded && !open.length && <p className="empty">{t('ღია მოთხოვნა არ არის. მოთხოვნა აქ ჩნდება, როგორც კი სახაზინოს გაუგზავნით.', 'No open requests. A request appears here as soon as you send it to treasury.')}</p>}
        {open.map((r) => {
          const st = stateOf(r);
          const fresh = st === 'asking' && r.source === 'app' && minutesSince(r.requested_at) < deleteMinutes;
          const answer = clientReplyNote(r, t);
          const chatText = r.client_reply === 'approved' && r.approved_rate != null ? chatHandoff(r.client_id, r.approved_rate) : null;
          const transferText = bookedLine(r);
          const offerText = !chatText && r.rate != null && (st === 'quoted' || st === 'expired') ? clientOffer(r.rate, r.rate_valid_until) : null;
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
                {r.client_rate != null && <div className="tiny muted">{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')}: {fmtRate(r.client_rate)}</div>}
                {r.note && <div className="tiny muted">{t('კომენტარი', 'Comment')}: {r.note}</div>}
                {answer
                  ? <div className="tiny muted">{answer}</div>
                  : (
                    <div className="tiny muted">
                      {st === 'asking' && t('იკითხა {time}-ზე', 'Asked at {time}', { time: fmtTime(r.asked_at) })}
                      {st === 'quoted' && t('კლიენტს უთხარით კურსი და ჩაწერეთ პასუხი.', 'Tell the client the rate and record the answer.')}
                      {st === 'expired' && t('ხელახლა იკითხეთ, თუ კლიენტს კვლავ სურს კონვერტაცია', 'Ask again if the client still wants to convert')}
                      {st === 'declined' && (r.decline_reason ? t('სახაზინომ უარი თქვა: {reason}', 'Treasury declined: {reason}', { reason: treasuryReason(r.decline_reason, lang) }) : t('დაამატეთ დეტალები და ხელახლა იკითხეთ', 'Add details and ask again'))}
                    </div>
                  )}
              </div>
              {st === 'asking' && <span className="pill pill-wait"><IconClock />{t('სახაზინოს ელოდება', 'Waiting on treasury')}</span>}
              {st === 'quoted' && <span className="pill pill-warn">{t('კურსი {rate}, მოქმედებს {time}-მდე', 'Rate {rate}, valid until {time}', { rate: fmtRate(r.rate), time: fmtTime(r.rate_valid_until) })}</span>}
              {st === 'expired' && <span className="pill pill-wait">{t('კურსი {rate}, ვადა გაუვიდა {time}-ზე', 'Rate {rate}, expired at {time}', { rate: fmtRate(r.rate), time: fmtTime(r.rate_valid_until) })}</span>}
              {st === 'declined' && <span className="pill pill-alert">{t('სახაზინო', 'Treasury')}: {treasuryReason(r.decline_reason, lang)}</span>}
              <div className="actions">
                {canAnswer && (
                  <>
                    <button type="button" className="btn btn-primary" aria-pressed={replyOpen === 'approved'} onClick={() => openReply(r.id, 'approved')}>{t('კლიენტმა დაამტკიცა', 'Client approved')}</button>
                    <button type="button" className="btn" aria-pressed={replyOpen === 'better'} onClick={() => openReply(r.id, 'better')}>{t('კლიენტს უკეთესი კურსი სურს', 'Client wants a better rate')}</button>
                    <button type="button" className="btn btn-quiet" aria-pressed={replyOpen === 'declined'} onClick={() => openReply(r.id, 'declined')}>{t('კლიენტმა უარი თქვა', 'Client declined')}</button>
                  </>
                )}
                {canAskAgain && <button type="button" className="btn" onClick={() => askAgain(r)}>{t('ხელახლა კითხვა', 'Ask again')}</button>}
                {fresh && <button type="button" className="link danger" onClick={() => remove(r)}>{t('წაშლა', 'Delete')}</button>}
              </div>
              {chatText && <CopyLine label={t('ტექსტი ჩატისთვის', 'Text for chat')} text={chatText} />}
              {transferText && <CopyLine label={t('ტექსტი ჩარიცხვისთვის', 'Text for the transfer')} text={transferText} />}
              {offerText && <CopyLine label={t('ტექსტი კლიენტისთვის', 'Text for the client')} text={offerText} />}
              {replyOpen && (
                <form onSubmit={(e) => { e.preventDefault(); saveReply(r); }} noValidate style={{ flex: '1 1 100%', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
                  {replyOpen !== 'declined' ? (
                    <div className="field" style={{ flex: '1 1 200px', maxWidth: 280 }}>
                      <label htmlFor={'reply-rate-' + r.id}>{t('ჩაწერეთ კურსი', 'Enter the rate')}</label>
                      <input id={'reply-rate-' + r.id} className={'input' + (replyTried && !replyRateOk ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={replyRate} onChange={(e) => setReplyRate(e.target.value)} />
                      <span className={'hint' + (replyTried && !replyRateOk ? ' error' : '')}>
                        {replyTried && !replyRateOk ? t('ჩაწერეთ კურსი', 'Enter the rate') : replyOpen === 'approved' ? t('მოთხოვნა მიდის სახაზინოსთან და მენეჯერებთან.', 'This goes to treasury and to managers.') : t('მოთხოვნა მიდის მხოლოდ სახაზინოსთან. სახაზინოს პასუხის შემდეგ იგივე სამი პასუხი ისევ გამოჩნდება.', 'This goes only to treasury. After treasury answers, the same three replies appear again.')}
                      </span>
                    </div>
                  ) : (
                    <div className="field" style={{ flex: '1 1 280px' }}>
                      <label htmlFor={'reply-reason-' + r.id}>{t('მიზეზი', 'Reason')}</label>
                      <input id={'reply-reason-' + r.id} className={'input' + (replyTried && !replyReasonOk ? ' invalid' : '')} autoComplete="off" value={replyReason} onChange={(e) => setReplyReason(e.target.value)} />
                      <span className={'hint' + (replyTried && !replyReasonOk ? ' error' : '')}>
                        {replyTried && !replyReasonOk ? t('ჩაწერეთ მიზეზი', 'Enter a reason') : t('სახაზინო დაინახავს მიზეზს.', 'Treasury will see the reason.')}
                      </span>
                    </div>
                  )}
                  <button type="submit" className="btn btn-primary" disabled={replyBusy}>{replyBusy ? t('იგზავნება…', 'Sending…') : replyOpen === 'declined' ? t('შენახვა', 'Save') : t('გაგზავნა', 'Send')}</button>
                  <button type="button" className="link" onClick={() => setReply(null)}>{t('უკან', 'Back')}</button>
                </form>
              )}
            </div>
          );
        })}
      </section>}

      {isKam && <section className="card flush" aria-labelledby="done-title">
        <div className="card-head"><h2 id="done-title" style={{ fontSize: 18 }}>{t('დღეს გავიდა', 'Went through today')}</h2></div>
        {loaded && !done.length && <p className="empty">{t('დღეს ჯერ არაფერია.', 'Nothing yet today.')}</p>}
        {done.map((r) => {
          const transferText = bookedLine(r);
          return (
          <div key={r.id} className="list-row" style={{ paddingTop: 12, paddingBottom: 12 }}>
            <span className="when muted">{fmtTime(r.requested_at)}</span>
            <span className="who strong">{r.client_name ?? r.client_id}</span>
            <span className="what">{describeDeal(r.sells_currency, r.amount, r.gets_currency, r.gets_amount)}{r.rate ? ' ' + t('კურსით', 'at') + ' ' + fmtRate(r.rate) : ''}</span>
            <span className="pill pill-ok" style={{ marginLeft: 'auto' }}><IconCheck />{t('გავიდა', 'Went through')}</span>
            {transferText && <CopyLine label={t('ტექსტი ჩარიცხვისთვის', 'Text for the transfer')} text={transferText} />}
          </div>
          );
        })}
      </section>}

      {seeAll && <section className="card flush" aria-labelledby="approved-title">
        <div className="card-head">
          <div>
            <h2 id="approved-title" style={{ fontSize: 22 }}>{t('კლიენტმა დაამტკიცა', 'Client approved')}</h2>
            <p className="small muted">{t('ბოლო 7 დღის დადასტურებები. სახაზინოც და მენეჯერებიც ხედავენ.', 'Approvals from the last 7 days. Treasury and managers both see them.')}</p>
          </div>
        </div>
        {approvedError && <p className="empty">{approvedError}</p>}
        {approvedLoaded && !approvedError && !approvedRows.length && <p className="empty">{t('ჯერ არაფერია.', 'Nothing yet.')}</p>}
        {approvedRows.map((r) => (
          <div key={r.id} className="list-row">
            <div className="when">
              <div className="strong">{fmtDay(r.request_date)}</div>
              <div className="tiny muted">{fmtTime(r.client_replied_at ?? r.requested_at)}</div>
            </div>
            <div className="who">
              <div className="name">{r.client_name ?? r.client_id}</div>
              <div className="tiny muted">ID {r.client_id}</div>
              <div className="small">{r.kam_name ?? t('KAM არ არის', 'No KAM')}</div>
            </div>
            <div className="what">
              <div>{describeDeal(r.sells_currency, r.amount, r.gets_currency, r.gets_amount)}</div>
              <div>{t('კლიენტმა დაამტკიცა', 'Client approved')} {fmtRate(r.approved_rate)}</div>
              {r.rate != null && <div className="tiny muted">{t('სახაზინოს კურსი', 'Treasury rate')}: {fmtRate(r.rate)}</div>}
            </div>
          </div>
        ))}
      </section>}

      <section className="card flush" aria-labelledby="history-title">
        <div className="card-head">
          <div>
            <h2 id="history-title" style={{ fontSize: 22 }}>{isKam ? t('წინა მოთხოვნები', 'Earlier requests') : t('ყველა მოთხოვნა', 'All requests')}</h2>
            <p className="small muted">
              {isKam
                ? t('თქვენი გარიგებები დღევანდელამდე, შეთანხმების ფაილის ჩათვლით. დასრულებული გარიგება აქ რჩება, როგორც გავიდა.', 'Your deals before today, including the agreement file. A finished deal stays here as went through.')
                : t('დღევანდელი და ყველა ძველი გარიგება, იმ KAM-ის ქვეშ, ვინც გააკეთა. აირჩიეთ ერთი ადამიანი ან ერთი თვე, ან დატოვეთ ორივე „ყველა“-ზე.', 'Today and every older deal, under the KAM who did it. Pick one person or one month, or leave both on All.')}
              {histLoaded && histCount != null ? ' ' + t('{n} ამ ხედში.', '{n} in this view.', { n: fmtWhole(histCount) }) : ''}
            </p>
          </div>
          <div className="row">
            {seeAll && (
              <label className="field" style={{ flex: '0 1 280px' }}>
                <span className="sr-only">KAM</span>
                <select className="select" style={{ width: 'auto' }} value={kamFilter} onChange={(e) => { setKamFilter(e.target.value); setShown(PAGE_SIZE); setHistory([]); setHistCount(null); setHistError(''); setHistLoaded(false); }}>
                  <option value="all">{t('ყველა KAM', 'All KAMs')}</option>
                  {kams.map((k) => <option key={k.id} value={k.id}>{k.full_name}</option>)}
                </select>
              </label>
            )}
            <label className="field" style={{ flex: '0 1 220px' }}>
              <span className="sr-only">{t('თვე', 'Month')}</span>
              <select className="select" style={{ width: 'auto' }} value={month} onChange={(e) => { setMonth(e.target.value); setShown(PAGE_SIZE); setHistory([]); setHistCount(null); setHistError(''); setHistLoaded(false); }}>
                <option value="all">{t('ყველა თვე', 'All months')}</option>
                {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
          </div>
        </div>
        {histError && <p className="alert-box" role="alert">{histError}</p>}
        {!histLoaded && <p className="empty">{t('იტვირთება…', 'Loading…')}</p>}
        {histLoaded && !histError && !history.length && (
          <p className="empty">
            {month === 'all' && kamFilter === 'all'
              ? t('წინა მოთხოვნა ჯერ არ არის. აქ გამოჩნდება, როცა შეთანხმების ფაილი ჩაიტვირთება.', 'No earlier requests yet. They appear here when the agreement file is loaded.')
              : t('ამ არჩევანზე არაფერია.', 'Nothing for this choice.')}
          </p>
        )}
        {histLoaded && history.map((r) => {
          const st = historyStatus(r, t('გავიდა', 'Went through'), t('არ გავიდა', 'Did not go through'), t('ჯერ ღიაა', 'Still open'));
          const chatText = isKam && r.client_reply === 'approved' && r.approved_rate != null ? chatHandoff(r.client_id, r.approved_rate) : null;
          const transferText = isKam ? bookedLine(r) : null;
          return (
            <div key={r.id} className="list-row">
              <div className="when">
                <div className="strong">{fmtDay(r.request_date)}</div>
                <div className="tiny muted">{fmtTime(r.requested_at)}</div>
              </div>
              <div className="who">
                <div className="name">{r.client_name ?? r.client_id}</div>
                <div className="tiny muted">ID {r.client_id}</div>
                {seeAll && <div className="small">{r.kam_name ?? t('KAM არ არის', 'No KAM')}</div>}
              </div>
              <div className="what">
                <div>{describeDeal(r.sells_currency, r.amount, r.gets_currency, r.gets_amount)}{r.rate ? ' ' + t('კურსით', 'at') + ' ' + fmtRate(r.rate) : ''}</div>
                {r.client_rate != null && <div className="tiny muted">{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')}: {fmtRate(r.client_rate)}</div>}
                {r.note && <div className="tiny muted">{t('კომენტარი', 'Comment')}: {r.note}</div>}
                {r.loss_reason_note && <div className="tiny muted">{t('სხვა მიზეზი', 'Other reason')}: {r.loss_reason_note}</div>}
                {clientReplyNote(r, t) && <div className="tiny muted">{clientReplyNote(r, t)}</div>}
                {chatText && <CopyLine label={t('ტექსტი ჩატისთვის', 'Text for chat')} text={chatText} />}
                {transferText && <CopyLine label={t('ტექსტი ჩარიცხვისთვის', 'Text for the transfer')} text={transferText} />}
              </div>
              <span className={'pill ' + st.cls} style={{ marginLeft: 'auto' }}>
                {st.cls === 'pill-ok' && <IconCheck />}{st.label}
              </span>
            </div>
          );
        })}
        {histLoaded && history.length < (histCount ?? 0) && (
          <p className="empty">
            <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE_SIZE)}>{t('მეტის ჩვენება', 'Show more')}</button>
            <span className="small muted" style={{ marginLeft: 12 }}>{t('{shown} {total}-დან', '{shown} of {total}', { shown: fmtWhole(history.length), total: fmtWhole(histCount) })}</span>
          </p>
        )}
      </section>
    </>
  );
}
