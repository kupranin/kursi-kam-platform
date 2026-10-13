import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { useLive } from '../lib/useLive';
import { DAY_COLUMNS, DESK_DAY_SINCE_FIELDS, onDeskToday } from '../lib/deskDay';
import { fmtAmount, fmtDateTime, fmtDay, fmtRate, fmtTime, fmtWhole, longToday, minutesSince, parseRate, rateUnit, sideAmount, tbilisiDayStart, todayTbilisi } from '../lib/format';
import { isMissingRead } from '../lib/missingRead';
import { loadMarketRateData } from '../lib/marketBoard';
import type { CurrentBoard } from '../lib/rateGrid';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { dealLeftOpen, hideEarlierDeals, isPendingLoss, lossReasonLabel, treasuryReason } from '../lib/requestStatus';
import { bankList, type LossReason, type QueueRow, type QuoteToday, type ReferenceRate } from '../lib/types';
import ClientBlocked, { useClientBlocked } from '../components/ClientBlocked';
import DeleteRequestButton from '../components/DeleteRequestButton';
import LossApproval from '../components/LossApproval';
import LoadingLine from '../components/LoadingLine';
import RatePeople from '../components/RatePeople';
import { applyRatePeople, loadRatePeople, ratePeopleFor } from '../lib/ratePeople';
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
        <label htmlFor={'quoted-rate-' + requestId}>{t('ხაზინის კურსი', 'Treasury rate')}</label>
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
  quoted_by_name?: string | null;
  written_by_name?: string | null;
}

const EMPTY_MARKET_BOARD: CurrentBoard = { pairs: [], rows: [], updatedAt: null };

interface DeskDayRow {
  id: number;
  kam_name: string | null;
  client_id: string;
  client_name: string | null;
  sells_currency: string | null;
  gets_currency: string | null;
  amount: number | null;
  gets_amount: number | null;
  client_rate: number | null;
  rate: number | null;
  approved_rate: number | null;
  given_rate: number | null;
  quote_status: string | null;
  quote_state: string | null;
  decline_reason: string | null;
  client_reply: string | null;
  client_decline_reason: string | null;
  better_decision: string | null;
  requested_at: string;
  request_date: string;
  asked_at: string | null;
  quoted_at: string | null;
  client_replied_at: string | null;
  rate_valid_until: string | null;
  rate_written_at: string | null;
  outcome: string | null;
  went_through: boolean | null;
  loss_open: boolean | null;
  loss_reason: string | null;
  loss_reason_at: string | null;
  loss_reason_note: string | null;
  loss_approved_at: string | null;
  loss_approval_comment: string | null;
  loss_approver_name: string | null;
  payment_confirmed_at: string | null;
  bank: string | null;
  note: string | null;
  quoted_by_name?: string | null;
  written_by_name?: string | null;
}

function deskSeenAt(row: DeskDayRow): string {
  return [row.loss_reason_at, row.rate_written_at, row.client_replied_at, row.quoted_at, row.asked_at, row.requested_at]
    .filter((iso): iso is string => !!iso)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? row.requested_at;
}

function deskSeenMs(row: DeskDayRow): number {
  const ms = new Date(deskSeenAt(row)).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function deskRate(row: DeskDayRow): number | null {
  if (row.approved_rate != null && (row.rate_written_at || row.client_reply === 'approved')) return row.approved_rate;
  if (row.given_rate != null) return row.given_rate;
  return row.rate;
}

function lossDetail(row: DeskDayRow, reasons: LossReason[], lang: 'ka' | 'en'): string {
  const fromTable = reasons.find((r) => r.code === row.loss_reason);
  const label = fromTable
    ? ((lang === 'en' ? fromTable.label_en : fromTable.label_ka).trim() || fromTable.label_en || fromTable.label_ka)
    : lossReasonLabel(row.loss_reason, lang);
  const note = row.loss_reason_note?.trim() ?? '';
  if (label && note) return `${label} — ${note}`;
  if (label || note) return label || note;
  if (row.client_reply === 'declined' && row.client_decline_reason) return row.client_decline_reason;
  if (row.decline_reason) return treasuryReason(row.decline_reason, lang);
  return '';
}

/** A KAM loss (დაიკარგა) stays a loss even while the quote is still on the row. */
function isDeskLoss(row: DeskDayRow): boolean {
  if (row.rate_written_at || row.payment_confirmed_at || row.went_through) return false;
  return isPendingLoss(row) || !!row.loss_approved_at;
}

function dayStatus(
  row: DeskDayRow,
  t: (ka: string, en: string, vars?: Record<string, string | number>) => string,
  lang: 'ka' | 'en',
  reasons: LossReason[],
): { label: string; cls: string; detail: string } {
  if (row.rate_written_at) {
    return {
      label: t('კურსი {rate}, გაწერილია {time}-ზე', 'Rate {rate}, written at {time}', {
        rate: fmtRate(row.approved_rate ?? row.rate),
        time: fmtTime(row.rate_written_at),
      }),
      cls: 'pill-ok',
      detail: '',
    };
  }
  if (isDeskLoss(row)) {
    const approved = !!row.loss_approved_at;
    return {
      label: approved ? t('დანაკარგი დადასტურებულია', 'Loss approved') : t('დაიკარგა', 'Lost'),
      cls: approved ? 'pill-wait' : 'pill-alert',
      detail: lossDetail(row, reasons, lang),
    };
  }
  if (row.quote_status === 'declined' || row.quote_state === 'declined') {
    return { label: t('ხაზინამ უარი თქვა', 'Declined by treasury'), cls: 'pill-alert', detail: treasuryReason(row.decline_reason, lang) };
  }
  if (row.client_reply === 'declined') {
    return { label: t('კლიენტმა უარი თქვა', 'Declined by client'), cls: 'pill-alert', detail: row.client_decline_reason ?? '' };
  }
  if (row.client_reply === 'approved') return { label: t('კურსი გასაწერია', 'Rate to write'), cls: 'pill-warn', detail: '' };
  if (row.client_reply === 'better' && !row.better_decision) return { label: t('უკეთესი კურსი', 'Better rate'), cls: 'pill-warn', detail: '' };
  if (row.quote_status === 'asking' || row.quote_state === 'asking') return { label: t('კურსს ელოდება', 'Waiting for a rate'), cls: 'pill-wait', detail: '' };
  if ((row.quote_status === 'quoted' || row.quote_state === 'quoted' || row.quote_state === 'expired') && row.rate != null) {
    const expired = row.quote_state === 'expired'
      || (!!row.rate_valid_until && new Date(row.rate_valid_until).getTime() < Date.now());
    if (expired) {
      return {
        label: t('კურსი {rate}, ვადა გაუვიდა {time}-ზე', 'Rate {rate}, expired at {time}', {
          rate: fmtRate(row.rate),
          time: fmtTime(row.rate_valid_until),
        }),
        cls: 'pill-wait',
        detail: '',
      };
    }
    return {
      label: t('კურსი {rate}, მოქმედებს {time}-მდე', 'Rate {rate}, valid until {time}', {
        rate: fmtRate(row.rate),
        time: fmtTime(row.rate_valid_until),
      }),
      cls: 'pill-warn',
      detail: '',
    };
  }
  if (row.loss_open || row.outcome === 'did_not_go_through') return { label: t('არ გავიდა', 'Did not go through'), cls: 'pill-alert', detail: '' };
  if (row.went_through || row.outcome === 'went_through') return { label: t('გავიდა', 'Went through'), cls: 'pill-ok', detail: '' };
  return { label: t('ღიაა', 'Open'), cls: 'pill-wait', detail: '' };
}

/** One quiet report per failure streak. A later success arms it again. */
let deskDayFailureLogged = false;
/** At most one slice batch at a time. A second refresh waits, it does not start another. */
let deskDaySliceFlight: { key: string; promise: Promise<DeskDayRow[]> } | null = null;

function deskDaySliceKey(today: string, alsoIds: number[]): string {
  return today + '\n' + [...alsoIds].sort((a, b) => a - b).join(',');
}

/**
 * Today's app requests, plus anything the old slices included.
 * One call when desk_day_rows exists. Until setup 33 is pasted, the slices stay.
 * If the function exists and this call fails, this refresh uses the slices once.
 * The screen still drops a row that is not onDeskToday.
 */
async function loadDeskDay(today: string, alsoIds: number[]): Promise<DeskDayRow[]> {
  const start = tbilisiDayStart(today);
  const { data, error } = await supabase.rpc('desk_day_rows', {
    p_today: today,
    p_start: start,
    p_also_ids: alsoIds,
  });
  if (!error) {
    deskDayFailureLogged = false;
    return (Array.isArray(data) ? data : []) as DeskDayRow[];
  }
  if (!isMissingRead(error) && !deskDayFailureLogged) {
    deskDayFailureLogged = true;
    console.error('desk_day_rows failed; using the day slices for this refresh', error.message);
  }
  return loadDeskDaySlicesCoalesced(today, alsoIds);
}

async function loadDeskDaySlicesCoalesced(today: string, alsoIds: number[]): Promise<DeskDayRow[]> {
  const key = deskDaySliceKey(today, alsoIds);
  while (deskDaySliceFlight && deskDaySliceFlight.key !== key) {
    await deskDaySliceFlight.promise.catch(() => undefined);
  }
  if (deskDaySliceFlight?.key === key) return deskDaySliceFlight.promise;
  const promise = loadDeskDaySlices(today, alsoIds).finally(() => {
    if (deskDaySliceFlight?.promise === promise) deskDaySliceFlight = null;
  });
  deskDaySliceFlight = { key, promise };
  return promise;
}

/** The seven day slices plus explicit ids. One failed slice does not drop the rest. */
async function loadDeskDaySlices(today: string, alsoIds: number[]): Promise<DeskDayRow[]> {
  const start = tbilisiDayStart(today);
  const day = () => supabase.from('request_outcomes').select(DAY_COLUMNS).eq('source', 'app').limit(1000);
  const queries = [
    day().eq('request_date', today),
    ...DESK_DAY_SINCE_FIELDS.map((field) => day().gte(field, start)),
  ];
  if (alsoIds.length) queries.push(supabase.from('request_outcomes').select(DAY_COLUMNS).in('id', alsoIds).limit(1000));
  const slices = await Promise.all(queries);
  const merged = new Map<number, DeskDayRow>();
  let ok = false;
  for (const slice of slices) {
    if (slice.error || !slice.data) continue;
    ok = true;
    for (const row of slice.data as DeskDayRow[]) merged.set(row.id, row);
  }
  if (!ok) {
    const err = slices.find((slice) => slice.error)?.error;
    throw new Error(err?.message || 'day list');
  }
  return [...merged.values()];
}

/** Written, paid, or lost rows. A failed lookup leaves the list as it was. */
async function closedIds(ids: number[]): Promise<Set<number>> {
  const closed = new Set<number>();
  if (!ids.length) return closed;
  const full = await supabase.from('request_outcomes')
    .select('id, rate_written_at, payment_confirmed_at, went_through, loss_open, loss_reason, loss_approved_at, outcome')
    .in('id', ids);
  const marks = full.error
    ? await supabase.from('requests').select('id, rate_written_at').in('id', ids)
    : full;
  if (marks.error || !marks.data) return closed;
  for (const row of marks.data as {
    id: number;
    rate_written_at?: string | null;
    payment_confirmed_at?: string | null;
    went_through?: boolean | null;
    loss_open?: boolean | null;
    loss_reason?: string | null;
    loss_approved_at?: string | null;
    outcome?: string | null;
  }[]) {
    if (dealLeftOpen(row)) closed.add(row.id);
  }
  return closed;
}

/** Fields the waiting card actually draws. `waiting_seconds` changes on every read and is not shown. */
const QUEUE_SHOWN: (keyof QueueRow)[] = [
  'request_id', 'asked_at', 'kam_name', 'client_id', 'client_name', 'is_new_client',
  'sells_currency', 'gets_currency', 'amount', 'gets_amount', 'client_rate', 'note',
  'loss_reason_note', 'last_rate', 'last_rate_at', 'standard_rate', 'nbg_rate', 'last_given_today',
];

function queueNorm(value: unknown): string {
  if (value == null) return '\u0000';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') {
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      const n = Number(value);
      if (Number.isFinite(n)) return String(n);
    }
    return value;
  }
  return String(value);
}

function queueSignature(rows: QueueRow[]): string {
  return rows.map((row) => QUEUE_SHOWN.map((key) => queueNorm(row[key])).join('\u001f')).join('\u001e');
}

function replaceIfChanged<T>(prev: T, next: T): T {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

/**
 * The waiting clock. It ticks on its own so the rest of the desk
 * (rate box, today table, market board) does not re-render every 10 seconds.
 * Georgian wording stays exactly as it was on the card.
 */
function WaitingSince({ askedAt, seenAt, kamName, isNewClient }: {
  askedAt: string;
  seenAt: number;
  kamName: string;
  isNewClient: boolean;
}) {
  const mark = useRef<HTMLSpanElement>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 10000);
    return () => window.clearInterval(id);
  }, []);
  const mins = minutesSince(askedAt);
  const late = mins >= 2;
  const isNew = seenAt > 0 && Date.now() - seenAt < 60000;
  // Runs after every paint of this clock, including when the card re-renders
  // and React resets the article class to "req-card".
  useLayoutEffect(() => {
    const article = mark.current?.closest('article');
    if (!article) return;
    article.classList.toggle('new', isNew);
    article.classList.toggle('late', !isNew && late);
  });
  const label = mins < 1 ? 'ახლახან' : 'ელოდება ' + mins + ' წთ';
  return (
    <div className="row small" style={{ gap: '8px 14px' }}>
      <span ref={mark} className={'pill ' + (late ? 'pill-alert' : 'pill-wait')}><IconClock />{label}</span>
      <span style={{ color: 'var(--ink-2)' }}>{kamName}-ისგან</span>
      {isNew && <span className="pill pill-gold">ახალი</span>}
      {isNewClient && <span className="pill pill-dark">ახალი კლიენტი</span>}
    </div>
  );
}

/** Same pairs, buy and sell as the Rates board. Per 1 unit, including ruble. */
function DeskMarketRates({ board }: { board: CurrentBoard }) {
  const { t } = useI18n();
  return (
    <>
      {board.pairs.map((pair, index) => {
        const lines = board.rows
          .map((row) => ({ key: row.key, label: row.label, quote: row.quotes[index] }))
          .filter((line) => line.quote && (line.quote.buy != null || line.quote.sell != null));
        if (!lines.length) return null;
        return (
          <div key={pair}>
            <p className="small strong" style={{ margin: '12px 24px 0' }}>{pair}</p>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('წყარო', 'Source')}</th>
                  <th className="num">{t('ყიდვა', 'Buy')}</th>
                  <th className="num">{t('გაყიდვა', 'Sell')}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.key}>
                    <th scope="row">{line.label}</th>
                    <td className="num strong">{fmtRate(line.quote.buy)}</td>
                    <td className="num strong">{fmtRate(line.quote.sell)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {board.updatedAt && (
        <p className="tiny muted" style={{ margin: '8px 24px 12px' }}>
          {t('განახლდა {when}.', 'Updated {when}.', { when: fmtDateTime(board.updatedAt) })}
        </p>
      )}
    </>
  );
}

export default function RateDesk() {
  const toast = useToast();
  const { t, lang } = useI18n();
  const { role, realRole } = useViewAs();
  const seeDay = role === 'treasury' || role === 'admin';
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [quotes, setQuotes] = useState<QuoteToday[]>([]);
  const [replies, setReplies] = useState<ClientReply[]>([]);
  const [repliesNote, setRepliesNote] = useState('');
  const [fixRate, setFixRate] = useState<Record<number, string>>({});
  const [fixTried, setFixTried] = useState<number | null>(null);
  const [betterDeclineId, setBetterDeclineId] = useState<number | null>(null);
  const [betterDeclineReason, setBetterDeclineReason] = useState('');
  const [betterDeclineTried, setBetterDeclineTried] = useState(false);
  const [rates, setRates] = useState<ReferenceRate[]>([]);
  const [marketBoard, setMarketBoard] = useState<CurrentBoard>(EMPTY_MARKET_BOARD);
  const [marketLoaded, setMarketLoaded] = useState(false);
  const [defaultValid, setDefaultValid] = useState(15);
  const [cards, setCards] = useState<Record<number, CardState>>({});
  const [extraAgreed, setExtraAgreed] = useState<ClientReply[]>([]);
  const [banks, setBanks] = useState<Record<number, string[]>>({});
  const [hidePast, setHidePast] = useState<Record<number, true>>({});
  const [writingId, setWritingId] = useState<number | null>(null);
  const [dayRows, setDayRows] = useState<DeskDayRow[]>([]);
  const [lossReasons, setLossReasons] = useState<LossReason[]>([]);
  const [dayNote, setDayNote] = useState('');
  const [loaded, setLoaded] = useState(false);
  // Bumped by the slow desk reload so banks and earlier-deal marks refresh
  // even when the waiting-list cards themselves did not change.
  const [sidesTick, setSidesTick] = useState(0);
  const firstSeen = useRef<Map<number, number>>(new Map());
  const initial = useRef(true);
  // A slower refresh must not paint an older waiting list over a newer one.
  const queueGen = useRef(0);
  const rawSigRef = useRef<string | null>(null);
  const openSigRef = useRef<string | null>(null);
  const queueAgain = useRef<'light' | 'full' | null>(null);
  const queueFlight = useRef<Promise<void> | null>(null);
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const tRef = useRef(t);
  tRef.current = t;
  // Latest digits in the rate box, updated as they are typed. Send uses this,
  // so a later click (such as 30 minutes) cannot put an older rate back.
  const draftRate = useRef<Record<number, string>>({});

  const refreshQueue = useCallback((mode: 'light' | 'full' = 'light') => {
    queueAgain.current = queueAgain.current === 'full' || mode === 'full' ? 'full' : 'light';
    if (queueFlight.current) return queueFlight.current;
    const run = async () => {
      while (queueAgain.current) {
        const next = queueAgain.current;
        queueAgain.current = null;
        const gen = ++queueGen.current;
        try {
          const q = await rpc<QueueRow[]>('treasury_queue');
          if (gen !== queueGen.current) continue;
          const queueRows = q ?? [];
          const rawSig = queueSignature(queueRows);
          // The 3-second check stops here when the cards would look the same.
          // That skips setQueue, so the bank and outcomes effect does not run.
          if (next === 'light' && rawSig === rawSigRef.current) continue;
          const closed = await closedIds(queueRows.map((r) => r.request_id));
          if (gen !== queueGen.current) continue;
          const open = queueRows.filter((r) => !closed.has(r.request_id));
          rawSigRef.current = rawSig;
          const openSig = queueSignature(open);
          if (openSig === openSigRef.current) {
            initial.current = false;
            continue;
          }
          const now = Date.now();
          for (const r of open) {
            if (!firstSeen.current.has(r.request_id)) firstSeen.current.set(r.request_id, initial.current ? 0 : now);
          }
          if (!initial.current && open.some((r) => firstSeen.current.get(r.request_id) === now)) {
            const fresh = open.filter((r) => firstSeen.current.get(r.request_id) === now);
            const say = tRef.current;
            toastRef.current(fresh.length === 1
              ? say('ახალი მოთხოვნა {name}-ისგან: {client}', 'New request from {name}: {client}', { name: fresh[0].kam_name, client: fresh[0].client_name ?? fresh[0].client_id })
              : say('{n} ახალი მოთხოვნა', '{n} new requests', { n: fresh.length }));
          }
          initial.current = false;
          openSigRef.current = openSig;
          setQueue(open);
        } catch (err) {
          if (gen === queueGen.current) toastRef.current((err as Error).message, 'error');
        }
      }
    };
    const flight = run().finally(() => {
      queueFlight.current = null;
      if (queueAgain.current) void refreshQueue(queueAgain.current);
    });
    queueFlight.current = flight;
    return flight;
  }, []);

  const load = useCallback(async () => {
    void refreshQueue('full');
    let quotedTodayIds: number[] = [];
    try {
      const quoted = await rpc<QuoteToday[]>('treasury_quotes_today');
      const quoteRows = quoted ?? [];
      quotedTodayIds = quoteRows.map((r) => r.request_id);
      const closed = await closedIds(quoteRows.map((r) => r.request_id));
      const openQuotes = quoteRows.filter((r) => !closed.has(r.request_id));
      const quotePeople = await loadRatePeople(openQuotes.map((r) => r.request_id));
      const nextQuotes = openQuotes.map((r) => ({ ...r, ...ratePeopleFor(quotePeople, r.request_id) }));
      setQuotes((prev) => replaceIfChanged(prev, nextQuotes));
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    try {
      const list = await rpc<ClientReply[]>('treasury_client_replies');
      setRepliesNote('');
      const olderCols = 'id, kam_name, client_id, client_name, sells_currency, gets_currency, amount, gets_amount, rate, approved_rate, client_reply, note';
      const olderActive = await supabase
        .from('request_active')
        .select(olderCols)
        .eq('source', 'app')
        .eq('client_reply', 'approved')
        .gte('request_date', todayTbilisi(-14))
        .order('requested_at', { ascending: false })
        .limit(40);
      const olderRes = olderActive.error && isMissingRead(olderActive.error)
        ? await supabase
          .from('request_outcomes')
          .select(olderCols)
          .eq('source', 'app')
          .eq('client_reply', 'approved')
          .gte('request_date', todayTbilisi(-14))
          .order('requested_at', { ascending: false })
          .limit(40)
        : olderActive;
      const older = olderRes.data;
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
      const ids = [...list.map((r) => r.request_id), ...extras.map((r) => r.request_id)];
      const closed = await closedIds(ids);
      const people = await loadRatePeople(ids);
      const stamp = (row: ClientReply): ClientReply => ({ ...row, ...ratePeopleFor(people, row.request_id) });
      const stillHere = (row: ClientReply) => !closed.has(row.request_id) && row.client_reply !== 'declined';
      const nextReplies = list.filter(stillHere).map(stamp);
      const nextExtra = extras.filter((row) => !closed.has(row.request_id)).map(stamp);
      setReplies((prev) => replaceIfChanged(prev, nextReplies));
      setExtraAgreed((prev) => replaceIfChanged(prev, nextExtra));
    } catch {
      setReplies([]);
      setExtraAgreed([]);
      setRepliesNote(t('სია ჯერ არ იტვირთება.', 'This list is not loading yet.'));
    }
    if (seeDay) {
      try {
        // Treasury and admin already read every app request. A KAM's row
        // policy still returns only their own deals, and this list is not
        // on the KAM desk. quotedTodayIds keeps a rate treasury gave today
        // even after it leaves the waiting queue and stays on the KAM card.
        const raw = await loadDeskDay(todayTbilisi(), quotedTodayIds);
        const reasonRes = await supabase.from('loss_reasons').select('code, label_en, label_ka, sort_order, active').eq('active', true).order('sort_order');
        if (!reasonRes.error && reasonRes.data) {
          const nextReasons = reasonRes.data as LossReason[];
          setLossReasons((prev) => replaceIfChanged(prev, nextReasons));
        }
        const nextDay = applyRatePeople(raw, await loadRatePeople(raw.map((row) => row.id)));
        setDayRows((prev) => replaceIfChanged(prev, nextDay));
        setDayNote('');
      } catch {
        setDayRows([]);
        setDayNote(t('სია ჯერ არ იტვირთება.', 'This list is not loading yet.'));
      }
    } else {
      setDayRows((prev) => (prev.length === 0 ? prev : []));
      setDayNote('');
    }
    setSidesTick((n) => n + 1);
    setLoaded(true);
  }, [toast, t, seeDay, refreshQueue]);

  useEffect(() => {
    load();
    rpc<ReferenceRate[]>('treasury_rates').then(setRates).catch(() => setRates([]));
    supabase.from('rules').select('default_quote_minutes').single().then(({ data }) => {
      if (data?.default_quote_minutes) setDefaultValid(data.default_quote_minutes);
    });
  }, [load]);
  useEffect(() => {
    let live = true;
    const run = () => {
      loadMarketRateData()
        .then((view) => { if (live) setMarketBoard(view.board); })
        .catch(() => { /* keep the last board; the empty line stays only when there are no rows */ })
        .finally(() => { if (live) setMarketLoaded(true); });
    };
    run();
    const timer = window.setInterval(run, 5 * 60 * 1000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);
  // Quotes, replies, and today. Realtime bursts collapse inside useLive.
  // The 3-second waiting-list check does not call this.
  useLive(['requests'], () => { void load(); }, 15000);
  // The waiting list is the handoff. treasury_queue only, every 3 seconds.
  // Unchanged cards do not set state and do not read banks or outcomes.
  useEffect(() => {
    const timer = window.setInterval(() => { void refreshQueue('light'); }, 3000);
    return () => window.clearInterval(timer);
  }, [refreshQueue]);

  useEffect(() => {
    const ids = Array.from(new Set([
      ...queue.map((r) => r.request_id),
      ...replies.map((r) => r.request_id),
      ...extraAgreed.map((r) => r.request_id),
    ]));
    if (!ids.length) {
      setBanks((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      setHidePast((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    let live = true;
    (async () => {
      const withSet = await supabase.from('requests').select('id, bank, banks').in('id', ids);
      const res = withSet.error
        ? await supabase.from('requests').select('id, bank').in('id', ids)
        : withSet;
      if (!live || res.error || !res.data) return;
      const next: Record<number, string[]> = {};
      for (const row of res.data as { id: number; bank: string | null; banks?: string[] | string | null }[]) {
        const fromSet = bankList(row.banks);
        const picked = fromSet.length ? fromSet : bankList(row.bank);
        if (picked.length) next[row.id] = picked;
      }
      setBanks((prev) => replaceIfChanged(prev, next));
    })();
    (async () => {
      const full = await supabase.from('request_outcomes')
        .select('id, went_through, rate_written_at, payment_confirmed_at, loss_open, loss_reason, loss_approved_at, outcome, quote_status, client_reply')
        .in('id', ids);
      const res = full.error
        ? await supabase.from('request_outcomes')
          .select('id, went_through, rate_written_at, outcome, quote_status, client_reply')
          .in('id', ids)
        : full;
      if (!live || res.error || !res.data) return;
      const next: Record<number, true> = {};
      for (const row of res.data as {
        id: number;
        went_through?: boolean | null;
        rate_written_at?: string | null;
        payment_confirmed_at?: string | null;
        loss_open?: boolean | null;
        loss_reason?: string | null;
        loss_approved_at?: string | null;
        outcome?: string | null;
        quote_status?: string | null;
        client_reply?: string | null;
      }[]) {
        if (hideEarlierDeals(row)) next[row.id] = true;
      }
      setHidePast((prev) => replaceIfChanged(prev, next));
    })();
    return () => { live = false; };
  }, [queue, replies, extraAgreed, sidesTick]);

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
      toast(t('KAM-ს ეცნობა, რომ კურსი გაწერილია.', 'The KAM is notified that the rate is written.'));
      load();
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
  const approvedReplies = [
    ...replies.filter((r) => r.client_reply === 'approved'),
    ...extraAgreed.filter((r) => !replies.some((x) => x.request_id === r.request_id)),
  ];
  const adminDelete = (id: number) => realRole === 'admin'
    ? <DeleteRequestButton requestId={id} onDeleted={load} />
    : null;
  const today = todayTbilisi();
  const dayDeals = seeDay
    ? dayRows.filter((row) => onDeskToday(row, today)).sort((a, b) => deskSeenMs(b) - deskSeenMs(a))
    : [];
  const { blocked, toggle } = useClientBlocked(approvedReplies.map((row) => row.client_id));
  const canSwitchBlocked = realRole === 'treasury' || realRole === 'admin';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('კურსის მაგიდა', 'Rate desk')}</h1>
          <p>{longToday()}</p>
        </div>
        <div className="stats">
          <div className="stat"><div className="label">{t('კურსს ელოდება', 'Waiting for a rate')}</div><div className="value" style={{ color: 'var(--aubergine)' }}>{queue.length}</div></div>
          <div className="stat"><div className="label">{t('კურსი გასაწერია', 'Rate to write')}</div><div className="value" style={{ color: 'var(--aubergine)' }}>{approvedReplies.length}</div></div>
          <div className="stat"><div className="label">{t('მოქმედი კურსები', 'Live rates')}</div><div className="value">{validCount}</div></div>
          <div className="stat"><div className="label">{t('უკეთესი კურსი', 'Better rate')}</div><div className="value">{waitingBetter.length}</div></div>
          {seeDay && <div className="stat"><div className="label">{t('დღევანდელი', 'Today')}</div><div className="value">{dayDeals.length}</div></div>}
        </div>
      </div>

      <div className="cols">
        <div className="col-main">
          <section aria-labelledby="queue-title">
            <div className="row-between" style={{ marginBottom: 12 }}>
              <h2 id="queue-title" style={{ fontSize: 22 }}>{t('კურსს ელოდება', 'Waiting for a rate')}</h2>
              <span className="small muted">{t('ჯერ ძველი. ჩაწერეთ კურსი და დააჭირეთ Enter-ს, რომ KAM-ს გაეგზავნოს.', 'Oldest first. Type a rate and press Enter to send it to the KAM.')}</span>
            </div>
            {!loaded && <LoadingLine />}
            {loaded && !queue.length && <div className="card"><p className="empty">{t('არაფერი ელოდება. KAM-ების ახალი მოთხოვნები აქ ჩნდება.', 'Nothing is waiting. New requests from KAMs appear here.')}</p></div>}
            <div className="stack-sm">
              {queue.map((r) => {
                const c = card(r.request_id);
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
                  <article key={r.request_id} className="req-card">
                    <div className="row-between" style={{ gap: 12, marginBottom: 10 }}>
                      <WaitingSince
                        askedAt={r.asked_at}
                        seenAt={firstSeen.current.get(r.request_id) ?? 0}
                        kamName={r.kam_name}
                        isNewClient={r.is_new_client}
                      />
                      {adminDelete(r.request_id)}
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
                    {r.note && <p className="note-box">კომენტარი ხაზინისთვის: {r.note}</p>}
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
                    {!hidePast[r.request_id] && <ClientHistory clientId={r.client_id} excludeId={r.request_id} />}
                  </article>
                );
              })}
            </div>
          </section>

          {seeDay && (
            <section className="card flush desk-day" aria-labelledby="day-desk-title">
              <div className="card-head" style={{ display: 'block' }}>
                <div className="row-between" style={{ gap: 12 }}>
                  <h2 id="day-desk-title" style={{ fontSize: 22 }}>{t('დღევანდელი გარიგებები', "Today's deals")}</h2>
                  {loaded && !dayNote && <span className="strong" style={{ fontSize: 22 }}>{dayDeals.length}</span>}
                </div>
                <p className="small" style={{ color: 'var(--ink-2)', marginTop: 6 }}>{t(
                  'ყველა გარიგება, რომელიც დღეს კურსის მაგიდაზე იყო: გაცემული კურსი, რომელიც KAM-ის ღია მოთხოვნაზეა დარჩენილი, გაწერილი, უარყოფილი და დაკარგული. შუაღამეს, თბილისის დროით, სია ახალ დღეზე გადადის. ძველი გარიგებები ისტორიაში რჩება.',
                  'Every deal that was on the rate desk today: a rate already given that is still on the KAM open list, a written rate, a rejected one, and a lost one. At midnight, Tbilisi time, the list moves on to the new day. Older deals stay in History.',
                )}</p>
              </div>
              {!loaded && !dayNote && <LoadingLine />}
              {dayNote && <p className="empty">{dayNote}</p>}
              {loaded && !dayNote && !dayDeals.length && <p className="empty">{t('დღეს ჯერ არაფერი ყოფილა კურსის მაგიდაზე.', 'Nothing has been on the rate desk today.')}</p>}
              {loaded && !dayNote && dayDeals.length > 0 && (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('დრო', 'Time')}</th>
                        <th>{t('კლიენტი', 'Client')}</th>
                        <th>KAM</th>
                        <th>{t('თანხები', 'Amounts')}</th>
                        <th className="num">{t('კურსი', 'Rate')}</th>
                        <th>{t('სტატუსი', 'Status')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dayDeals.map((row) => {
                        const st = dayStatus(row, t, lang, lossReasons);
                        const rate = deskRate(row);
                        const seen = deskSeenAt(row);
                        const awaitingLoss = isPendingLoss(row);
                        return (
                          <Fragment key={row.id}>
                          <tr>
                            <td className="nowrap">{fmtDateTime(seen)}</td>
                            <td>
                              <div className="strong">{row.client_name ?? row.client_id}</div>
                              <div className="tiny muted">ID {row.client_id}</div>
                              {row.bank && <div className="tiny muted">{row.bank}</div>}
                            </td>
                            <td>{row.kam_name}</td>
                            <td>
                              <div>{t('ყიდის', 'Sells')} {sideAmount(row.sells_currency, row.amount)}</div>
                              <div>{t('იღებს', 'Gets')} {sideAmount(row.gets_currency, row.gets_amount)}</div>
                              {row.note && <div className="tiny muted" style={{ overflowWrap: 'anywhere' }}>{t('კომენტარი', 'Comment')}: {row.note}</div>}
                            </td>
                            <td className="num strong">
                              {rate != null ? fmtRate(rate) : ''}
                              {row.rate != null && rate != null && Number(row.rate) !== Number(rate) && (
                                <div className="tiny muted">{t('ხაზინის კურსი', 'Treasury rate')}: {fmtRate(row.rate)}</div>
                              )}
                              {row.client_rate != null && (
                                <div className="tiny muted">{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')}: {fmtRate(row.client_rate)}</div>
                              )}
                              <RatePeople quoted={row.quoted_by_name} written={row.written_by_name} />
                            </td>
                            <td>
                              <span className={'pill ' + st.cls}>{st.label}</span>
                              {st.detail && <div className="tiny muted">{st.detail}</div>}
                            </td>
                          </tr>
                          {awaitingLoss && (
                            <tr>
                              <td colSpan={6} style={{ minWidth: 0 }}>
                                <LossApproval row={row} onDone={load} />
                              </td>
                            </tr>
                          )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          <section aria-labelledby="better-title">
            <div className="row-between" style={{ margin: '28px 0 12px' }}>
              <h2 id="better-title" style={{ fontSize: 22 }}>{t('კლიენტს უკეთესი კურსი სურს', 'Client wants a better rate')}</h2>
              <span className="small muted">დადასტურება ან გასწორებული კურსი ბრუნდება KAM-თან. უარი აჩერებს მოთხოვნას.</span>
            </div>
            {repliesNote && <div className="card"><p className="empty">{repliesNote}</p></div>}
            {!loaded && !repliesNote && <LoadingLine />}
            {loaded && !repliesNote && !waitingBetter.length && <div className="card"><p className="empty">არაფერი ელოდება.</p></div>}
            <div className="stack-sm">
              {waitingBetter.map((r) => {
                const raw = fixRate[r.request_id] ?? '';
                const rateOk = raw.trim() !== '' && Number(raw.trim().replace(',', '.')) > 0;
                return (
                  <article key={r.request_id} className="req-card">
                    <div className="row-between" style={{ gap: 12, marginBottom: 10 }}>
                      <span className="small" style={{ color: 'var(--ink-2)' }}>{r.kam_name}</span>
                      {adminDelete(r.request_id)}
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
                    <p className="note-box">{t('ხაზინის კურსი', 'Treasury rate')}: {fmtRate(r.rate)}. {t('კლიენტს სურს', 'The client wants')} {fmtRate(r.wanted_rate)}.</p>
                    <RatePeople quoted={r.quoted_by_name} written={r.written_by_name} />
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
                    {!hidePast[r.request_id] && <ClientHistory clientId={r.client_id} excludeId={r.request_id} />}
                  </article>
                );
              })}
            </div>
          </section>

          <section className="card flush" aria-labelledby="write-desk-title" style={{ marginTop: 22 }}>
            <div className="card-head">
              <h2 id="write-desk-title" style={{ fontSize: 22 }}>{t('კურსი გასაწერია', 'Rate to write')}</h2>
              <span className="small muted">{t('კლიენტმა დაამტკიცა და კურსი ძირითად სისტემაში ჯერ არ არის ჩაწერილი. ჩაწერის შემდეგ დააჭირეთ „კურსი გაწერილია“. გაწერილი კურსი ისტორიაში გადადის.', 'The client approved, and the rate is not in the core system yet. After you enter it, press “Rate is written”. A written rate moves to History.')}</span>
            </div>
            {!loaded && !repliesNote && <LoadingLine />}
            {loaded && !repliesNote && !approvedReplies.length && <p className="empty">{t('კურსი გასაწერი არ არის.', 'Nothing is waiting to be written.')}</p>}
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
                  <div>{t('გასაწერი კურსი', 'Rate to write')} {fmtRate(r.approved_rate)}</div>
                  <RatePeople quoted={r.quoted_by_name} written={r.written_by_name} />
                  {r.rate != null && <div className="tiny muted">{t('ხაზინის კურსი', 'Treasury rate')}: {fmtRate(r.rate)}</div>}
                  {r.rate != null && <QuotedRateEditor requestId={r.request_id} rate={r.rate} onChanged={load} />}
                </div>
                <div className="actions">
                  <button type="button" className="btn btn-primary" disabled={writingId === r.request_id} onClick={() => markWritten(r)}>
                    {writingId === r.request_id ? t('ინახება…', 'Saving…') : t('კურსი გაწერილია', 'Rate is written')}
                  </button>
                  {canSwitchBlocked && (
                    <ClientBlocked clientId={r.client_id} blocked={blocked.has(r.client_id)} onToggle={toggle} />
                  )}
                  {adminDelete(r.request_id)}
                </div>
                <CopyLine label={t('კლიენტის ID', 'Client ID')} text={r.client_id} />
                {r.approved_rate != null && <CopyLine label={t('ტექსტი ჩატისთვის', 'Text for chat')} text={chatHandoff(r.client_id, r.approved_rate)} />}
                {!hidePast[r.request_id] && <ClientHistory clientId={r.client_id} excludeId={r.request_id} />}
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
            {!marketLoaded && <LoadingLine />}
            {marketLoaded && !rates.length && !marketBoard.rows.length && <p className="empty">კურსი ჯერ არ არის ჩატვირთული. ისინი კურსის წყაროებიდან მოდის (იხილეთ დაყენების გზამკვლევი).</p>}
            {marketBoard.rows.length > 0 && <DeskMarketRates board={marketBoard} />}
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
            {!loaded && <LoadingLine />}
            {loaded && !groups.size && <p className="empty">ჯერ არ არის.</p>}
            {loaded && Array.from(groups.entries()).map(([k, list]) => {
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
                  {list.map((item) => (
                    <RatePeople key={item.request_id} quoted={item.quoted_by_name} written={item.written_by_name} />
                  ))}
                </div>
              );
            })}
          </section>

          <section className="card" aria-labelledby="pos-title">
            <h2 id="pos-title">თუ ყველა მოქმედი კურსი გავა</h2>
            <p className="small" style={{ margin: '4px 0 12px', color: 'var(--ink-2)' }}>ცვლილება თითო ვალუტის პოზიციაზე</p>
            {!loaded && <LoadingLine />}
            {loaded && !Object.keys(effect).length && <p className="empty">მოქმედი კურსი ახლა არ არის.</p>}
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
