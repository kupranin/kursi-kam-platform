import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { useLive, useTick } from '../lib/useLive';
import { fmtAmount, fmtDay, fmtRate, fmtTime, fmtWhole, longToday, minutesSince, parseRate, rateUnit, sideAmount, todayTbilisi } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { treasuryReason } from '../lib/requestStatus';
import { bankList, type QueueRow, type QuoteToday, type ReferenceRate } from '../lib/types';
import { chatHandoff } from '../lib/copyText';
import PairBoard from '../components/PairBoard';
import ClientHistory from '../components/ClientHistory';
import CopyLine from '../components/CopyLine';
import { IconClock } from '../components/Icons';

const DECLINE_REASONS: { value: string; label: string }[] = [
  { value: 'Amount too large', label: 'თანხა ძალიან დიდია' },
  { value: 'Market moving too fast', label: 'ბაზარი ძალიან სწრაფად იცვლება' },
  { value: 'Need more details', label: 'მეტი დეტალია საჭირო' },
];

function declineLabel(reason: string, lang: 'ka' | 'en'): string {
  return treasuryReason(reason, lang) || DECLINE_REASONS.find((r) => r.value === reason)?.label || reason;
}

/** Same TBC / BOG / Liberty buttons as the request form. Pressed ones are the deal. */
function DeskBanks({ codes, label }: { codes: string[] | undefined; label: string }) {
  const picked = bankList(codes);
  if (!picked.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div className="tiny muted" style={{ marginBottom: 6 }}>{label}</div>
      <div className="seg static" role="group" aria-label={label}>
        {picked.map((code) => (
          <button key={code} type="button" aria-pressed="true" tabIndex={-1}>
            {code}
          </button>
        ))}
      </div>
    </div>
  );
}
const FAR_PCT = 3;

function QuotedRateEditor({ requestId, rate, onChanged }: { requestId: number; rate: number | null; onChanged: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [text, setText] = useState(rate != null ? fmtRate(rate) : '');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const parsed = parseRate(text);
  const rateOk = parsed.ok && parsed.value != null;

  useEffect(() => {
    setText(rate != null ? fmtRate(rate) : '');
    setTried(false);
  }, [requestId, rate]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!rateOk || parsed.value == null) return;
    setBusy(true);
    try {
      await rpc('treasury_set_rate', { p_request_id: requestId, p_rate: parsed.value });
      toast(t('კურსი შეიცვალა.', 'Rate updated.'));
      onChanged();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(false);
  }

  async function clear() {
    if (!window.confirm(t(
      'წავშალოთ ეს კურსი? მოთხოვნა დარჩება. თუ კურსი გაწერილი იყო, გაწერის ნიშანიც მოიხსნება.',
      'Remove this rate? The request stays. If the rate was written, that mark is cleared too.',
    ))) return;
    setBusy(true);
    try {
      await rpc('treasury_set_rate', { p_request_id: requestId, p_rate: null });
      toast(t('კურსი მოიხსნა.', 'Rate removed.'));
      onChanged();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(false);
  }

  return (
    <form onSubmit={save} noValidate className="form-row" style={{ marginTop: 12 }}>
      <div className="field" style={{ flex: '0 1 190px' }}>
        <label htmlFor={'quoted-rate-' + requestId}>{t('სახაზინოს კურსი', 'Treasury rate')}</label>
        <input
          id={'quoted-rate-' + requestId}
          className={'input' + (tried && !rateOk ? ' invalid' : '')}
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(e) => { setText(e.target.value.replace(/,/g, '.')); setTried(false); }}
        />
        {tried && !rateOk && <span className="hint error">{t('ჩაწერეთ კურსი', 'Enter the rate')}</span>}
      </div>
      <div className="row" style={{ paddingTop: 27, gap: 12 }}>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('ინახება…', 'Saving…') : t('კურსის შენახვა', 'Save rate')}</button>
        <button type="button" className="link danger" disabled={busy} onClick={clear}>{t('კურსის წაშლა', 'Remove rate')}</button>
      </div>
    </form>
  );
}

interface CardState { rate: string; valid: number; declining: boolean; confirmFar: boolean; tried: boolean }

interface OtherReason {
  id: number;
  client_name: string | null;
  client_id: string;
  kam_name: string | null;
  sells_currency: string | null;
  gets_currency: string | null;
  amount: number | null;
  gets_amount: number | null;
  rate: number | null;
  client_rate: number | null;
  note: string | null;
  loss_reason_note: string;
  request_date: string;
}

interface ClientReply {
  request_id: number;
  kam_name: string;
  client_id: string;
  client_name: string | null;
  sells_currency: string;
  gets_currency: string;
  amount: number | null;
  gets_amount: number | null;
  rate: number | null;
  client_reply: 'approved' | 'better' | 'declined';
  approved_rate: number | null;
  wanted_rate: number | null;
  better_decision: 'accepted' | 'corrected' | null;
  given_rate: number | null;
  client_decline_reason: string | null;
  client_replied_at: string | null;
  note: string | null;
}

export default function RateDesk() {
  const toast = useToast();
  const { t, lang } = useI18n();
  useTick(10000);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [quotes, setQuotes] = useState<QuoteToday[]>([]);
  const [otherReasons, setOtherReasons] = useState<OtherReason[]>([]);
  const [replies, setReplies] = useState<ClientReply[]>([]);
  const [repliesNote, setRepliesNote] = useState('');
  const [fixRate, setFixRate] = useState<Record<number, string>>({});
  const [fixTried, setFixTried] = useState<number | null>(null);
  const [betterDeclineId, setBetterDeclineId] = useState<number | null>(null);
  const [betterDeclineReason, setBetterDeclineReason] = useState('');
  const [betterDeclineTried, setBetterDeclineTried] = useState(false);
  const [rates, setRates] = useState<ReferenceRate[]>([]);
  const [defaultValid, setDefaultValid] = useState(15);
  const [cards, setCards] = useState<Record<number, CardState>>({});
  const [extraAgreed, setExtraAgreed] = useState<ClientReply[]>([]);
  const [booked, setBooked] = useState<Record<number, true>>({});
  const [banks, setBanks] = useState<Record<number, string[]>>({});
  const [clientIds, setClientIds] = useState<Record<number, string>>({});
  const [writingId, setWritingId] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const firstSeen = useRef<Map<number, number>>(new Map());
  const initial = useRef(true);
  // Latest digits in the rate box, updated as they are typed. Send uses this,
  // so a later click (such as 30 minutes) cannot put an older rate back.
  const draftRate = useRef<Record<number, string>>({});

  const load = useCallback(async () => {
    try {
      const [q, quoted] = await Promise.all([
        rpc<QueueRow[]>('treasury_queue'),
        rpc<QuoteToday[]>('treasury_quotes_today'),
      ]);
      const now = Date.now();
      for (const r of q ?? []) {
        if (!firstSeen.current.has(r.request_id)) firstSeen.current.set(r.request_id, initial.current ? 0 : now);
      }
      if (!initial.current && (q ?? []).some((r) => firstSeen.current.get(r.request_id) === now)) {
        const fresh = (q ?? []).filter((r) => firstSeen.current.get(r.request_id) === now);
        toast(fresh.length === 1
          ? t('ახალი მოთხოვნა {name}-ისგან: {client}', 'New request from {name}: {client}', { name: fresh[0].kam_name, client: fresh[0].client_name ?? fresh[0].client_id })
          : t('{n} ახალი მოთხოვნა', '{n} new requests', { n: fresh.length }));
      }
      initial.current = false;
      setQueue(q ?? []);
      setQuotes(quoted ?? []);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    try {
      const { data, error } = await supabase.from('request_outcomes')
        .select('id, client_name, client_id, kam_name, sells_currency, gets_currency, amount, gets_amount, rate, client_rate, note, loss_reason_note, request_date')
        .not('loss_reason_note', 'is', null)
        .gte('request_date', todayTbilisi(-7))
        .order('request_date', { ascending: false })
        .limit(30);
      if (error) setOtherReasons([]);
      else setOtherReasons(((data ?? []) as OtherReason[]).filter((row) => row.loss_reason_note.trim()));
    } catch {
      setOtherReasons([]);
    }
    try {
      const list = await rpc<ClientReply[]>('treasury_client_replies');
      setReplies(list);
      setRepliesNote('');
      const { data: older } = await supabase
        .from('request_outcomes')
        .select('id, kam_name, client_id, client_name, sells_currency, gets_currency, amount, gets_amount, rate, approved_rate, client_reply, note')
        .eq('source', 'app')
        .eq('client_reply', 'approved')
        .gte('request_date', todayTbilisi(-14))
        .order('requested_at', { ascending: false })
        .limit(40);
      const extras: ClientReply[] = ((older ?? []) as {
        id: number; kam_name: string | null; client_id: string; client_name: string | null;
        sells_currency: string | null; gets_currency: string | null; amount: number | null; gets_amount: number | null;
        rate: number | null; approved_rate: number | null; note: string | null;
      }[])
        .filter((row) => row.approved_rate != null && !list.some((r) => r.request_id === row.id))
        .map((row) => ({
          request_id: row.id,
          kam_name: row.kam_name ?? '',
          client_id: row.client_id,
          client_name: row.client_name,
          sells_currency: row.sells_currency ?? '',
          gets_currency: row.gets_currency ?? '',
          amount: row.amount,
          gets_amount: row.gets_amount,
          rate: row.rate,
          client_reply: 'approved',
          approved_rate: row.approved_rate,
          wanted_rate: null,
          better_decision: null,
          given_rate: null,
          client_decline_reason: null,
          client_replied_at: null,
          note: row.note,
        }));
      setExtraAgreed(extras);
      const ids = [
        ...list.filter((r) => r.client_reply === 'approved').map((r) => r.request_id),
        ...extras.map((r) => r.request_id),
      ];
      if (ids.length) {
        const { data: marks } = await supabase.from('requests').select('id, rate_written_at').in('id', ids);
        const next: Record<number, true> = {};
        for (const row of (marks ?? []) as { id: number; rate_written_at: string | null }[]) {
          if (row.rate_written_at) next[row.id] = true;
        }
        setBooked(next);
      } else {
        setBooked({});
      }
    } catch {
      setReplies([]);
      setExtraAgreed([]);
      setRepliesNote(t('სია ჯერ არ იტვირთება.', 'This list is not loading yet.'));
    }
    setLoaded(true);
  }, [toast, t]);

  useEffect(() => {
    load();
    rpc<ReferenceRate[]>('treasury_rates').then(setRates).catch(() => setRates([]));
    supabase.from('rules').select('default_quote_minutes').single().then(({ data }) => {
      if (data?.default_quote_minutes) setDefaultValid(data.default_quote_minutes);
    });
  }, [load]);
  useLive(['requests'], load, 15000);

  useEffect(() => {
    const ids = Array.from(new Set([
      ...queue.map((r) => r.request_id),
      ...replies.map((r) => r.request_id),
      ...extraAgreed.map((r) => r.request_id),
      ...quotes.map((q) => q.request_id),
      ...otherReasons.map((r) => r.id),
    ]));
    if (!ids.length) { setBanks({}); setClientIds({}); return; }
    let live = true;
    (async () => {
      const withSet = await supabase.from('requests').select('id, client_id, bank, banks').in('id', ids);
      const res = withSet.error
        ? await supabase.from('requests').select('id, client_id, bank').in('id', ids)
        : withSet;
      if (!live || res.error || !res.data) return;
      const next: Record<number, string[]> = {};
      const clients: Record<number, string> = {};
      for (const row of res.data as { id: number; client_id?: string | null; bank: string | null; banks?: string[] | string | null }[]) {
        if (row.client_id) clients[row.id] = row.client_id;
        const fromSet = bankList(row.banks);
        const picked = fromSet.length ? fromSet : bankList(row.bank);
        if (picked.length) next[row.id] = picked;
      }
      setBanks(next);
      setClientIds(clients);
    })();
    return () => { live = false; };
  }, [queue, replies, extraAgreed, quotes, otherReasons]);

  const blankCard = (valid: number): CardState => ({ rate: '', valid, declining: false, confirmFar: false, tried: false });
  const card = (id: number): CardState => cards[id] ?? blankCard(defaultValid);
  // Merge into the card already stored, not into a copy from the last render.
  // A click on "30 წთ" must not restore a rate that was just typed over.
  const patch = (id: number, p: Partial<CardState>) => setCards((c) => {
    const prev = c[id] ?? blankCard(defaultValid);
    return { ...c, [id]: { ...prev, ...p } };
  });
  const rememberRate = (id: number, rate: string) => { draftRate.current[id] = rate; };

  async function send(r: QueueRow) {
    const c = card(r.request_id);
    const parsed = parseRate(draftRate.current[r.request_id] ?? c.rate);
    if (!parsed.text || parsed.value == null) { patch(r.request_id, { tried: true }); return; }
    const rate = parsed.value;
    if (r.standard_rate && Math.abs(rate - r.standard_rate) / r.standard_rate * 100 > FAR_PCT && !c.confirmFar) {
      patch(r.request_id, { confirmFar: true });
      return;
    }
    try {
      const until = await rpc<string>('treasury_quote', { p_request_id: r.request_id, p_rate: parsed.value, p_valid_minutes: c.valid });
      toast(t('კურსი {rate} გაეგზავნა {name}-ს, მოქმედებს {time}-მდე', 'Rate {rate} sent to {name}, valid until {time}', { rate: fmtRate(rate), name: r.kam_name.split(' ')[0], time: fmtTime(until) }));
      delete draftRate.current[r.request_id];
      setCards((all) => { const n = { ...all }; delete n[r.request_id]; return n; });
      load();
    } catch (err) { toast((err as Error).message, 'error'); load(); }
  }

  async function acceptBetter(r: ClientReply) {
    try {
      await rpc('treasury_answer_better', { p_request_id: r.request_id, p_decision: 'accepted', p_rate: null, p_reason: null });
      toast(t('კურსი დაუბრუნდა KAM-ს.', 'The rate went back to the KAM.'));
      load();
    } catch (err) { toast((err as Error).message, 'error'); load(); }
  }

  async function correctBetter(r: ClientReply) {
    const parsed = parseRate(fixRate[r.request_id] ?? '');
    if (!parsed.text || parsed.value == null) { setFixTried(r.request_id); return; }
    try {
      await rpc('treasury_answer_better', { p_request_id: r.request_id, p_decision: 'corrected', p_rate: parsed.value, p_reason: null });
      toast(t('გასწორებული კურსი დაუბრუნდა KAM-ს.', 'The corrected rate went back to the KAM.'));
      setFixRate((m) => { const n = { ...m }; delete n[r.request_id]; return n; });
      setFixTried(null);
      load();
    } catch (err) { toast((err as Error).message, 'error'); load(); }
  }

  async function declineBetter(r: ClientReply) {
    const reason = betterDeclineReason.trim();
    setBetterDeclineTried(true);
    if (reason.length < 2 || reason.length > 200) return;
    try {
      await rpc('treasury_answer_better', { p_request_id: r.request_id, p_decision: 'declined', p_rate: null, p_reason: reason });
      toast(t('უარი შენახულია. KAM დაინახავს მიზეზს.', 'Decline saved. The KAM will see the reason.'));
      setBetterDeclineId(null);
      setBetterDeclineReason('');
      setBetterDeclineTried(false);
      load();
    } catch (err) { toast((err as Error).message, 'error'); load(); }
  }

  async function markWritten(r: ClientReply) {
    setWritingId(r.request_id);
    try {
      await rpc('treasury_mark_rate_written', { p_request_id: r.request_id });
      setBooked((m) => ({ ...m, [r.request_id]: true }));
      toast(t('KAM-ს ეცნობა, რომ კურსი გაწერილია.', 'The KAM is notified that the rate is written.'));
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setWritingId(null);
  }

  async function decline(r: QueueRow, reason: string) {
    try {
      await rpc('treasury_decline', { p_request_id: r.request_id, p_reason: reason });
      toast(t('დაუბრუნდა {name}-ს: {reason}', 'Sent back to {name}: {reason}', { name: r.kam_name.split(' ')[0], reason: declineLabel(reason, lang) }));
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
    const rate = Number(q.rate);
    const sellAmt = q.amount != null ? Number(q.amount) : null;
    const getAmt = q.gets_amount != null ? Number(q.gets_amount) : null;
    if (sellAmt != null && q.sells_currency !== 'GEL') effect[q.sells_currency] = (effect[q.sells_currency] ?? 0) + sellAmt;
    if (q.gets_currency !== 'GEL') {
      const paid = getAmt != null
        ? getAmt
        : sellAmt != null && rate > 0
          ? (q.sells_currency === 'GEL' ? sellAmt / rate : sellAmt * rate)
          : null;
      if (paid != null) effect[q.gets_currency] = (effect[q.gets_currency] ?? 0) - paid;
    }
  }
  const usdEq = (ccy: string, v: number) => (nbgMap[ccy] && nbgMap.USD ? (v * nbgMap[ccy]) / nbgMap.USD : null);

  const validCount = quotes.filter((q) => q.quote_state === 'quoted' && !q.went_through).length;
  const waitingBetter = replies.filter((r) => r.client_reply === 'better' && !r.better_decision);
  const answeredBetter = replies.filter((r) => r.client_reply === 'better' && r.better_decision);
  const approvedReplies = [
    ...replies.filter((r) => r.client_reply === 'approved'),
    ...extraAgreed.filter((r) => !replies.some((x) => x.request_id === r.request_id)),
  ];
  const declinedReplies = replies.filter((r) => r.client_reply === 'declined');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('კურსის მაგიდა', 'Rate desk')}</h1>
          <p>{longToday()}</p>
        </div>
        <div className="stats">
          <div className="stat"><div className="label">{t('კურსს ელოდება', 'Waiting for a rate')}</div><div className="value" style={{ color: 'var(--aubergine)' }}>{queue.length}</div></div>
          <div className="stat"><div className="label">{t('მოქმედი კურსები', 'Live rates')}</div><div className="value">{validCount}</div></div>
          <div className="stat"><div className="label">{t('დღეს გაცემული', 'Given today')}</div><div className="value">{quotes.length}</div></div>
          <div className="stat"><div className="label">{t('უკეთესი კურსი', 'Better rate')}</div><div className="value">{waitingBetter.length}</div></div>
        </div>
      </div>

      <div className="cols">
        <div className="col-main">
          <section aria-labelledby="queue-title">
            <div className="row-between" style={{ marginBottom: 12 }}>
              <h2 id="queue-title" style={{ fontSize: 22 }}>{t('კურსს ელოდება', 'Waiting for a rate')}</h2>
              <span className="small muted">{t('ჯერ ძველი. ჩაწერეთ კურსი და დააჭირეთ Enter-ს, რომ KAM-ს გაეგზავნოს.', 'Oldest first. Type a rate and press Enter to send it to the KAM.')}</span>
            </div>
            {loaded && !queue.length && <div className="card"><p className="empty">{t('არაფერი ელოდება. KAM-ების ახალი მოთხოვნები აქ ჩნდება.', 'Nothing is waiting. New requests from KAMs appear here.')}</p></div>}
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
                  r.standard_rate != null && { label: 'ჩვენი სტანდარტი', value: r.standard_rate },
                  r.nbg_rate != null && { label: 'NBG', value: r.nbg_rate },
                  r.last_given_today != null && { label: 'დღეს ბოლოს გაცემული', value: r.last_given_today },
                  r.last_rate != null && { label: 'ბოლო ამ კლიენტზე', value: r.last_rate },
                ].filter(Boolean) as { label: string; value: number }[];
                return (
                  <article key={r.request_id} className={'req-card' + (isNew ? ' new' : late ? ' late' : '')}>
                    <div className="row small" style={{ gap: '8px 14px', marginBottom: 10 }}>
                      <span className={'pill ' + (late ? 'pill-alert' : 'pill-wait')}><IconClock />{minutesSince(r.asked_at) < 1 ? 'ახლახან' : 'ელოდება ' + minutesSince(r.asked_at) + ' წთ'}</span>
                      <span style={{ color: 'var(--ink-2)' }}>{r.kam_name}-ისგან</span>
                      {isNew && <span className="pill pill-gold">ახალი</span>}
                      {r.is_new_client && <span className="pill pill-dark">ახალი კლიენტი</span>}
                    </div>
                    <div className="row-between">
                      <div>
                        <div className="deal-facts">
                          <div>
                            <div className="tiny muted">კლიენტი ყიდის</div>
                            <div style={{ fontSize: 20, fontWeight: 600 }}>{sideAmount(r.sells_currency, r.amount)}</div>
                          </div>
                          <div>
                            <div className="tiny muted">კლიენტი იღებს</div>
                            <div style={{ fontSize: 20, fontWeight: 600 }}>{sideAmount(r.gets_currency, r.gets_amount)}</div>
                          </div>
                        </div>
                        <div className="small muted" style={{ marginTop: 6 }}>{r.client_name ?? 'სახელი არ არის'}, ID {r.client_id}</div>
                        <DeskBanks codes={banks[r.request_id]} label={t('ბანკი', 'Bank')} />
                      </div>
                      {r.last_rate != null && <div className="small" style={{ color: 'var(--ink-2)' }}>ბოლო კურსი ამ კლიენტზე {fmtRate(r.last_rate)}{r.last_rate_at ? ', ' + fmtDay(r.last_rate_at.slice(0, 10)) : ''}</div>}
                    </div>
                    {r.client_rate != null && <p className="note-box">კურსი, რომელსაც კლიენტი ითხოვს: {fmtRate(r.client_rate)}</p>}
                    {r.note && <p className="note-box">კომენტარი სახაზინოსთვის: {r.note}</p>}
                    {r.loss_reason_note && <p className="note-box">სხვა მიზეზი: {r.loss_reason_note}</p>}

                    {!c.declining && (
                      <>
                        {refs.length > 0 && (
                          <div className="row" style={{ marginTop: 16, gap: 8 }}>
                            <span className="small strong" style={{ marginRight: 4 }}>კურსები ამ გარიგებაზე</span>
                            {refs.map((x) => (
                              <button key={x.label} type="button" className="ref-chip" title="საწყისად გამოყენება" onClick={() => { const rate = fmtRate(x.value); rememberRate(r.request_id, rate); patch(r.request_id, { rate, confirmFar: false, tried: false }); }}>
                                <span>{x.label}</span><span>{fmtRate(x.value)}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        <PairBoard sells={r.sells_currency} gets={r.gets_currency} />
                        <div className="form-row" style={{ marginTop: 12 }}>
                          <div className="field" style={{ flex: '0 1 190px' }}>
                            <label htmlFor={'rate-' + r.request_id}>{t('კურსი', 'Rate')}</label>
                            <input
                              id={'rate-' + r.request_id}
                              className={'input big' + (c.tried && !rateOk ? ' invalid' : '')}
                              inputMode="decimal"
                              autoComplete="off"
                              value={c.rate}
                              onChange={(e) => { const rate = e.target.value.replace(/,/g, '.'); rememberRate(r.request_id, rate); patch(r.request_id, { rate, confirmFar: false }); }}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(r); } }}
                            />
                            <span className={'hint' + (c.tried && !rateOk ? ' error' : '')}>{c.tried && !rateOk ? 'ჯერ ჩაწერეთ კურსი' : rateUnit(r.sells_currency, r.gets_currency)}</span>
                          </div>
                          <div className="field">
                            <span className="label" id={'valid-' + r.request_id}>მოქმედებს</span>
                            <div className="seg dark" role="group" aria-labelledby={'valid-' + r.request_id}>
                              {[5, 15, 30].map((m) => (
                                <button key={m} type="button" aria-pressed={c.valid === m} onClick={() => patch(r.request_id, { valid: m })}>{m} წთ</button>
                              ))}
                            </div>
                          </div>
                          <div className="row" style={{ flex: '1 1 auto', justifyContent: 'flex-end', paddingTop: 27 }}>
                            <button type="button" className="btn btn-quiet" style={{ minHeight: 52 }} onClick={() => patch(r.request_id, { declining: true })}>{t('კურსს ვერ ვიძლევი', 'I cannot give a rate')}</button>
                            <button type="button" className="btn btn-primary btn-big" onClick={() => send(r)}>{dev > FAR_PCT && c.confirmFar ? t('მაინც გაგზავნა', 'Send anyway') : t('კურსის გაგზავნა', 'Send rate')}</button>
                          </div>
                        </div>
                        {dev > FAR_PCT && c.confirmFar && (
                          <p className="alert-box" role="alert">შეამოწმეთ კურსი: {c.rate} სტანდარტულ კურსს {fmtRate(r.standard_rate)} {dev.toFixed(1)}%-ით შორდება. თუ სწორია, დააჭირეთ „მაინც გაგზავნა“.</p>
                        )}
                      </>
                    )}
                    {c.declining && (
                      <div style={{ marginTop: 16 }}>
                        <div className="small strong" style={{ marginBottom: 8 }}>უთხარით {r.kam_name.split(' ')[0]}-ს, რატომ</div>
                        <div className="chips">
                          {DECLINE_REASONS.map((reason) => (
                            <button key={reason.value} type="button" className="chip" onClick={() => decline(r, reason.value)}>{lang === 'en' ? reason.value : reason.label}</button>
                          ))}
                          <button type="button" className="link" onClick={() => patch(r.request_id, { declining: false })}>უკან</button>
                        </div>
                      </div>
                    )}
                    <ClientHistory clientId={r.client_id} excludeId={r.request_id} />
                  </article>
                );
              })}
            </div>
          </section>

          <section aria-labelledby="better-title">
            <div className="row-between" style={{ margin: '28px 0 12px' }}>
              <h2 id="better-title" style={{ fontSize: 22 }}>{t('კლიენტს უკეთესი კურსი სურს', 'Client wants a better rate')}</h2>
              <span className="small muted">დადასტურება ან გასწორებული კურსი ბრუნდება KAM-თან. უარი აჩერებს მოთხოვნას.</span>
            </div>
            {repliesNote && <div className="card"><p className="empty">{repliesNote}</p></div>}
            {loaded && !repliesNote && !waitingBetter.length && !answeredBetter.length && <div className="card"><p className="empty">არაფერი ელოდება.</p></div>}
            <div className="stack-sm">
              {waitingBetter.map((r) => {
                const raw = fixRate[r.request_id] ?? '';
                const rateOk = raw.trim() !== '' && Number(raw.trim().replace(',', '.')) > 0;
                return (
                  <article key={r.request_id} className="req-card">
                    <div className="row small" style={{ gap: '8px 14px', marginBottom: 10 }}>
                      <span style={{ color: 'var(--ink-2)' }}>{r.kam_name}</span>
                    </div>
                    <div className="deal-facts">
                      <div>
                        <div className="tiny muted">კლიენტი ყიდის</div>
                        <div style={{ fontSize: 20, fontWeight: 600 }}>{sideAmount(r.sells_currency, r.amount)}</div>
                      </div>
                      <div>
                        <div className="tiny muted">კლიენტი იღებს</div>
                        <div style={{ fontSize: 20, fontWeight: 600 }}>{sideAmount(r.gets_currency, r.gets_amount)}</div>
                      </div>
                    </div>
                    <div className="small" style={{ marginTop: 6 }}>{r.client_name ?? t('სახელი არ არის', 'No name')}</div>
                    <div className="tiny muted">ID {r.client_id}</div>
                    <DeskBanks codes={banks[r.request_id]} label={t('ბანკი', 'Bank')} />
                    <p className="note-box">{t('სახაზინოს კურსი', 'Treasury rate')}: {fmtRate(r.rate)}. {t('კლიენტს სურს', 'The client wants')} {fmtRate(r.wanted_rate)}.</p>
                    {r.note && <p className="note-box">{t('კომენტარი', 'Comment')}: {r.note}</p>}
                    {r.rate != null && <QuotedRateEditor requestId={r.request_id} rate={r.rate} onChanged={load} />}
                    <PairBoard sells={r.sells_currency} gets={r.gets_currency} />
                    <div className="form-row" style={{ marginTop: 12 }}>
                      <div style={{ paddingTop: 27 }}>
                        <button type="button" className="btn btn-primary btn-big" onClick={() => acceptBetter(r)}>{t('დადასტურება', 'Accept')}</button>
                      </div>
                      <div className="field" style={{ flex: '0 1 190px' }}>
                        <label htmlFor={'fix-' + r.request_id}>{t('გასწორებული კურსი', 'Corrected rate')}</label>
                        <input
                          id={'fix-' + r.request_id}
                          className={'input big' + (fixTried === r.request_id && !rateOk ? ' invalid' : '')}
                          inputMode="decimal"
                          autoComplete="off"
                          value={raw}
                          onChange={(e) => { setFixRate((m) => ({ ...m, [r.request_id]: e.target.value.replace(/,/g, '.') })); setFixTried(null); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); correctBetter(r); } }}
                        />
                        {fixTried === r.request_id && !rateOk && <span className="hint error">ჩაწერეთ გასწორებული კურსი</span>}
                      </div>
                      <div style={{ paddingTop: 27 }}>
                        <button type="button" className="btn btn-big" onClick={() => correctBetter(r)}>{t('გაგზავნა', 'Send')}</button>
                      </div>
                      <div style={{ paddingTop: 27 }}>
                        <button
                          type="button"
                          className="btn btn-quiet btn-big"
                          aria-pressed={betterDeclineId === r.request_id}
                          onClick={() => {
                            setBetterDeclineId((id) => (id === r.request_id ? null : r.request_id));
                            setBetterDeclineReason('');
                            setBetterDeclineTried(false);
                          }}
                        >{t('უარი', 'Decline')}</button>
                      </div>
                    </div>
                    {betterDeclineId === r.request_id && (
                      <form onSubmit={(e) => { e.preventDefault(); declineBetter(r); }} noValidate style={{ marginTop: 12 }}>
                        <div className="field" style={{ maxWidth: 420 }}>
                          <label htmlFor={'better-no-' + r.request_id}>მიზეზი</label>
                          <input
                            id={'better-no-' + r.request_id}
                            className={'input' + (betterDeclineTried && (betterDeclineReason.trim().length < 2) ? ' invalid' : '')}
                            autoComplete="off"
                            maxLength={200}
                            value={betterDeclineReason}
                            onChange={(e) => setBetterDeclineReason(e.target.value)}
                          />
                          <span className={'hint' + (betterDeclineTried && betterDeclineReason.trim().length < 2 ? ' error' : '')}>
                            {betterDeclineTried && betterDeclineReason.trim().length < 2 ? 'ჩაწერეთ მიზეზი' : 'KAM დაინახავს მიზეზს. ეს აჩერებს მოთხოვნას.'}
                          </span>
                        </div>
                        <div className="row" style={{ marginTop: 8 }}>
                          <button type="submit" className="btn btn-primary">შენახვა</button>
                          <button type="button" className="link" onClick={() => { setBetterDeclineId(null); setBetterDeclineTried(false); }}>უკან</button>
                        </div>
                        </form>
                    )}
                    <ClientHistory clientId={r.client_id} excludeId={r.request_id} />
                  </article>
                );
              })}
            </div>
            {answeredBetter.map((r) => (
              <div key={r.request_id} className="list-row">
                <div className="who">
                  <div className="name">{r.client_name ?? r.client_id}</div>
                  <div className="tiny muted">ID {r.client_id}</div>
                  <div className="tiny muted">{r.kam_name}</div>
                  <DeskBanks codes={banks[r.request_id]} label={t('ბანკი', 'Bank')} />
                </div>
                <div className="what">
                  <div>{t('კლიენტი ყიდის', 'Client sells')} {sideAmount(r.sells_currency, r.amount)}</div>
                  <div>{t('კლიენტი იღებს', 'Client gets')} {sideAmount(r.gets_currency, r.gets_amount)}</div>
                  {r.note && <div className="tiny muted">{t('კომენტარი', 'Comment')}: {r.note}</div>}
                  <div className="tiny muted">{r.better_decision === 'accepted' ? t('სახაზინომ დაადასტურა {rate}.', 'Treasury accepted {rate}.', { rate: fmtRate(r.given_rate) }) : t('გასწორებული კურსი: {rate}.', 'Corrected rate: {rate}.', { rate: fmtRate(r.given_rate) })}</div>
                  {(r.rate != null || r.given_rate != null) && <QuotedRateEditor requestId={r.request_id} rate={r.rate ?? r.given_rate} onChanged={load} />}
                </div>
                <ClientHistory clientId={r.client_id} excludeId={r.request_id} />
              </div>
            ))}
          </section>

          <section className="card flush" aria-labelledby="approved-desk-title" style={{ marginTop: 22 }}>
            <div className="card-head">
              <h2 id="approved-desk-title" style={{ fontSize: 22 }}>{t('კლიენტმა დაამტკიცა', 'Client approved')}</h2>
              <span className="small muted">{t('კურსის ძირითად სისტემაში ჩაწერის შემდეგ დააჭირეთ „კურსი გაწერილია“. KAM-ს ეცნობება.', 'After you enter the rate in the core system, press “Rate is written”. The KAM is notified.')}</span>
            </div>
            {loaded && !repliesNote && !approvedReplies.length && <p className="empty">დღეს არ არის.</p>}
            {approvedReplies.map((r) => (
              <div key={r.request_id} className="list-row">
                <div className="who">
                  <div className="name">{r.client_name ?? r.client_id}</div>
                  <div className="tiny muted">ID {r.client_id}</div>
                  <div className="tiny muted">{r.kam_name}</div>
                  <DeskBanks codes={banks[r.request_id]} label={t('ბანკი', 'Bank')} />
                </div>
                <div className="what">
                  <div>{t('კლიენტი ყიდის', 'Client sells')} {sideAmount(r.sells_currency, r.amount)}</div>
                  <div>{t('კლიენტი იღებს', 'Client gets')} {sideAmount(r.gets_currency, r.gets_amount)}</div>
                  {r.note && <div className="tiny muted">{t('კომენტარი', 'Comment')}: {r.note}</div>}
                  <div>{t('კლიენტმა დაამტკიცა', 'Client approved')} {fmtRate(r.approved_rate)}</div>
                  {r.rate != null && <div className="tiny muted">{t('სახაზინოს კურსი', 'Treasury rate')}: {fmtRate(r.rate)}</div>}
                  {(r.rate != null || booked[r.request_id]) && <QuotedRateEditor requestId={r.request_id} rate={r.rate} onChanged={load} />}
                </div>
                <div className="actions">
                  {booked[r.request_id]
                    ? <span className="pill pill-ok">{t('კურსი გაწერილია', 'Rate is written')}</span>
                    : (
                      <button type="button" className="btn btn-primary" disabled={writingId === r.request_id} onClick={() => markWritten(r)}>
                        {writingId === r.request_id ? t('ინახება…', 'Saving…') : t('კურსი გაწერილია', 'Rate is written')}
                      </button>
                    )}
                </div>
                <CopyLine label={t('კლიენტის ID', 'Client ID')} text={r.client_id} />
                {r.approved_rate != null && <CopyLine label={t('ტექსტი ჩატისთვის', 'Text for chat')} text={chatHandoff(r.client_id, r.approved_rate)} />}
                <ClientHistory clientId={r.client_id} excludeId={r.request_id} />
              </div>
            ))}
          </section>

          <section className="card flush" aria-labelledby="declined-desk-title">
            <div className="card-head">
              <h2 id="declined-desk-title" style={{ fontSize: 22 }}>კლიენტმა უარი თქვა</h2>
            </div>
            {loaded && !repliesNote && !declinedReplies.length && <p className="empty">დღეს უარი არ არის.</p>}
            {declinedReplies.map((r) => (
              <div key={r.request_id} className="list-row">
                <div className="who">
                  <div className="name">{r.client_name ?? r.client_id}</div>
                  <div className="tiny muted">ID {r.client_id}</div>
                  <div className="tiny muted">{r.kam_name}</div>
                  <DeskBanks codes={banks[r.request_id]} label={t('ბანკი', 'Bank')} />
                </div>
                <div className="what">
                  <div>{t('კლიენტი ყიდის', 'Client sells')} {sideAmount(r.sells_currency, r.amount)}</div>
                  <div>{t('კლიენტი იღებს', 'Client gets')} {sideAmount(r.gets_currency, r.gets_amount)}</div>
                  {r.note && <div className="tiny muted">{t('კომენტარი', 'Comment')}: {r.note}</div>}
                  {r.rate != null && <div className="tiny muted">{t('სახაზინოს კურსი', 'Treasury rate')}: {fmtRate(r.rate)}</div>}
                  <div className="tiny muted">{t('მიზეზი', 'Reason')}: {r.client_decline_reason}</div>
                  {r.rate != null && <QuotedRateEditor requestId={r.request_id} rate={r.rate} onChanged={load} />}
                </div>
                <ClientHistory clientId={r.client_id} excludeId={r.request_id} />
              </div>
            ))}
          </section>

          <section className="card flush" aria-labelledby="quotes-title">
            <div className="card-head">
              <h2 id="quotes-title">დღევანდელი კურსები</h2>
              <span className="small muted">კურსზე „გავიდა“ ჩნდება, როცა კურსი გაწერილია ან კლიენტის ტრანზაქცია მოდის</span>
            </div>
            {loaded && !quotes.length && <p className="empty">დღეს კურსი ჯერ არ გაცემულა.</p>}
            {quotes.map((q) => {
              const valid = q.quote_state === 'quoted' && new Date(q.valid_until) > new Date();
              return (
                <div key={q.request_id} className="list-row">
                  <div className="who">
                    <div className="name">{q.client_name}</div>
                    {clientIds[q.request_id] && <div className="tiny muted">ID {clientIds[q.request_id]}</div>}
                    <div className="tiny muted">{q.kam_name}</div>
                    <DeskBanks codes={banks[q.request_id]} label={t('ბანკი', 'Bank')} />
                  </div>
                  <div className="what">
                    <div>{t('კლიენტი ყიდის', 'Client sells')} {sideAmount(q.sells_currency, q.amount)}</div>
                    <div>{t('კლიენტი იღებს', 'Client gets')} {sideAmount(q.gets_currency, q.gets_amount)}</div>
                    {q.client_rate != null && <div className="tiny muted">{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')}: {fmtRate(q.client_rate)}</div>}
                    {q.note && <div className="tiny muted">{t('კომენტარი სახაზინოსთვის', 'Comment for treasury')}: {q.note}</div>}
                    {q.loss_reason_note && <div className="tiny muted">{t('სხვა მიზეზი', 'Other reason')}: {q.loss_reason_note}</div>}
                    <div className="tiny muted">{t('სახაზინოს კურსი', 'Treasury rate')}: {fmtRate(q.rate)}</div>
                    <QuotedRateEditor requestId={q.request_id} rate={q.rate} onChanged={load} />
                  </div>
                  <div>
                    {q.went_through ? <span className="pill pill-ok">{t('გავიდა', 'Went through')}</span>
                      : valid ? <span className="pill pill-ok">{t('მოქმედებს {time}-მდე', 'Valid until {time}', { time: fmtTime(q.valid_until) })}</span>
                      : <span className="pill pill-wait">{t('ვადა გაუვიდა {time}-ზე', 'Expired at {time}', { time: fmtTime(q.valid_until) })}</span>}
                  </div>
                  {clientIds[q.request_id] && <ClientHistory clientId={clientIds[q.request_id]} excludeId={q.request_id} />}
                </div>
              );
            })}
          </section>

          <section className="card flush" aria-labelledby="other-reasons-title">
            <div className="card-head">
              <h2 id="other-reasons-title">სხვა მიზეზები</h2>
              <span className="small muted">რა ჩაწერა KAM-მა „სხვა“-ს გვერდით, როცა გარიგება არ გავიდა, ბოლო 7 დღე</span>
            </div>
            {loaded && !otherReasons.length && <p className="empty">ბოლო 7 დღეში არ არის.</p>}
            {otherReasons.map((r) => (
              <div key={r.id} className="list-row">
                <div className="when">
                  <div className="strong">{fmtDay(r.request_date)}</div>
                  <div className="tiny muted">{r.kam_name}</div>
                </div>
                <div className="who">
                  <div className="name">{r.client_name ?? r.client_id}</div>
                  <div className="tiny muted">ID {r.client_id}</div>
                  <DeskBanks codes={banks[r.id]} label={t('ბანკი', 'Bank')} />
                </div>
                <div className="what">
                  <div>{t('კლიენტი ყიდის', 'Client sells')} {sideAmount(r.sells_currency, r.amount)}</div>
                  <div>{t('კლიენტი იღებს', 'Client gets')} {sideAmount(r.gets_currency, r.gets_amount)}</div>
                  {r.client_rate != null && <div className="tiny muted">{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')}: {fmtRate(r.client_rate)}</div>}
                  {r.note && <div className="tiny muted">{t('კომენტარი', 'Comment')}: {r.note}</div>}
                  {r.rate != null && <div className="tiny muted">{t('სახაზინოს კურსი', 'Treasury rate')}: {fmtRate(r.rate)}</div>}
                  <div className="tiny muted">{t('სხვა მიზეზი', 'Other reason')}: {r.loss_reason_note}</div>
                  {r.rate != null && <QuotedRateEditor requestId={r.id} rate={r.rate} onChanged={load} />}
                </div>
                <ClientHistory clientId={r.client_id} excludeId={r.id} />
              </div>
            ))}
          </section>
        </div>

        <div className="col-side">
          <section className="card flush" aria-labelledby="rates-title">
            <div className="card-head" style={{ display: 'block' }}>
              <h2 id="rates-title">კურსები ახლა</h2>
              <p className="small" style={{ color: 'var(--ink-2)' }}>GEL 1 ერთეულზე. ვყიდულობთ, როცა კლიენტი ყიდის.</p>
            </div>
            {!rates.length && <p className="empty">კურსი ჯერ არ არის ჩატვირთული. ისინი კურსის წყაროებიდან მოდის (იხილეთ დაყენების გზამკვლევი).</p>}
            {gelRows.length > 0 && (
              <table className="table">
                <thead><tr><th>ვალუტა</th><th className="num">NBG</th><th className="num">ვყიდულობთ</th><th className="num">ვყიდით</th></tr></thead>
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
                კროსი, ჩვენი სტანდარტი: {crossRows.map((c) => `${c.currency}-დან ${c.quote_currency}-ზე ${fmtRate(c.buy)}`).join(', ')}
              </p>
            )}
            {rates.length > 0 && (
              <p className="tiny muted" style={{ margin: '8px 24px 12px' }}>
                {stdAsOf && 'სტანდარტული კურსები ' + fmtTime(stdAsOf) + '-ისთვის. '}{nbgAsOf && 'NBG-ის ოფიციალური კურსი ' + fmtDay(nbgAsOf.slice(0, 10)) + '-ისთვის.'}
              </p>
            )}
          </section>

          <section className="card" aria-labelledby="given-title">
            <h2 id="given-title">დღეს გაცემული განსაკუთრებული კურსები</h2>
            <p className="small" style={{ margin: '4px 0 10px', color: 'var(--ink-2)' }}>გარიგების მიმართულებით, ვადაგასულების ჩათვლით</p>
            {!groups.size && <p className="empty">ჯერ არ არის.</p>}
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
                  <div className="row-between"><span className="strong" style={{ fontWeight: 500 }}>კლიენტი ყიდის {a}-ს, იღებს {b}-ს</span><span className="strong">{fmtRate(values[0])}</span></div>
                  <div className="tiny muted">
                    {values.length} კურსი
                    {values.length > 1 && `, ${fmtRate(Math.min(...values))}-დან ${fmtRate(Math.max(...values))}-მდე`}
                    {std != null && `. ჩვენი სტანდარტი ${fmtRate(std)}.`}
                  </div>
                </div>
              );
            })}
          </section>

          <section className="card" aria-labelledby="pos-title">
            <h2 id="pos-title">თუ ყველა მოქმედი კურსი გავა</h2>
            <p className="small" style={{ margin: '4px 0 12px', color: 'var(--ink-2)' }}>ცვლილება თითო ვალუტის პოზიციაზე</p>
            {!Object.keys(effect).length && <p className="empty">მოქმედი კურსი ახლა არ არის.</p>}
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
            <p className="tiny muted" style={{ marginTop: 12 }}>ლიმიტები: დღის ბოლოს თითო ვალუტაზე USD 1 მლნ, დღის განმავლობაში USD 1.5 მლნ. მიმდინარე პოზიცია აქ გამოჩნდება, როცა ძირითადი სისტემა გამოგზავნის.</p>
          </section>
        </div>
      </div>
    </>
  );
}
