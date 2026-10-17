import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ACTIVE_COLUMNS, applyMatchedSuccess, decorateActiveRow, splitKamRequests, type ActiveSource } from '../lib/activeRequest';
import { isMissingRead } from '../lib/missingRead';
import { EMPTY_SPECIAL_DRAFT, saveClientSpecialRate, type SpecialTermsDraft } from '../lib/specialRates';
import { appendDeferredOpen, deferredOpenIds, isRateWriteDeferred, useDeferWriteReady } from '../lib/deferWrite';
import DeferWriteBar from '../components/DeferWriteBar';
import WrittenRateNote from '../components/WrittenRateNote';
import { supabase, rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { useToast } from '../lib/toast';
import { useLive, useTick } from '../lib/useLive';
import { chatHandoff, clientOffer, rateBooked } from '../lib/copyText';
import { ago, describeDeal, fmtDay, fmtRate, fmtTime, fmtWhole, longToday, monthOptions, parseAmount, tbilisiDay, todayTbilisi } from '../lib/format';
import { applyRatePeople, loadRatePeople } from '../lib/ratePeople';
import { withClientContext } from '../lib/requestContext';
import { hideEarlierDeals, isOpenRequest, isPendingLoss, isWrittenHistory, lossReasonLabel, treasuryReason } from '../lib/requestStatus';
import { BANKS, CURRENCIES, bankList, formatBanks, type RequestRow } from '../lib/types';
import ClientField, { type ClientInfo } from '../components/ClientField';
import ClientSpecialTerms from '../components/ClientSpecialTerms';
import DynamicActiveNegotiatedRates from '../components/DynamicActiveNegotiatedRates';
import ClientHistory from '../components/ClientHistory';
import CopyLine from '../components/CopyLine';
import CurrencyPicker from '../components/CurrencyPicker';
import DeleteRequestButton, { canDeleteRequest } from '../components/DeleteRequestButton';
import LoadingLine from '../components/LoadingLine';
import RatePeople from '../components/RatePeople';
import LossApproval from '../components/LossApproval';
import RequestOutcomeButtons, { canMarkRequestOutcome } from '../components/RequestOutcomeButtons';
import CorrectStatusButton from '../components/CorrectStatusButton';
import RequestKamLine from '../components/RequestKamLine';
import RequestSearch from '../components/RequestSearch';
import { loadKamWorkspaceExtras } from '../components/mobile/kamLoad';
import { groupKamRows } from '../lib/kamWorkspace';
import { IconCheck, IconClock, IconPlus } from '../components/Icons';

const PAGE_SIZE = 100;

/** One quiet report per failure streak. A later success arms it again. */
let matchedFailureLogged = false;

/** Ids request_outcomes already marks went_through. Null means this refresh could not tell. */
async function matchedSuccessIds(ids: number[]): Promise<Set<number> | null> {
  if (!ids.length) return new Set();
  const listed = await supabase.rpc('request_went_through_ids', { p_ids: ids });
  if (!listed.error) {
    matchedFailureLogged = false;
    const data = Array.isArray(listed.data) ? listed.data : [];
    return new Set(data.map((row: { id: number }) => Number(row.id)));
  }
  if (isMissingRead(listed.error)) {
    const narrow = await supabase.from('request_outcomes').select('id').in('id', ids).eq('went_through', true);
    if (!narrow.error) return new Set((narrow.data ?? []).map((row) => row.id));
  }
  if (!matchedFailureLogged) {
    matchedFailureLogged = true;
    console.error('request_went_through_ids failed; keeping the last reconciled list', listed.error.message);
  }
  return null;
}

async function withPeople(rows: RequestRow[]): Promise<RequestRow[]> {
  return applyRatePeople(rows, await loadRatePeople(rows.map((row) => row.id)));
}

function bookedLine(r: RequestRow): string | null {
  if (r.client_reply !== 'approved' || r.approved_rate == null || !r.rate_written_at) return null;
  return rateBooked(r.client_id, r.approved_rate);
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

function historyStatus(r: RequestRow, won: string, lost: string, open: string): { label: string; cls: string } {
  if (r.display_class === 'won') return { label: won, cls: 'pill-ok' };
  if (r.display_class === 'lost') return { label: lost, cls: 'pill-alert' };
  if (r.display_class === 'open') return { label: open, cls: 'pill-wait' };
  if (r.went_through || r.outcome === 'went_through' || r.rate_written_at || r.payment_confirmed_at) return { label: won, cls: 'pill-ok' };
  if (r.outcome === 'did_not_go_through' && r.source === 'import') return { label: lost, cls: 'pill-alert' };
  if (isPendingLoss(r) || r.client_reply === 'declined' || r.quote_status === 'declined' || r.loss_reason) return { label: lost, cls: 'pill-alert' };
  return { label: open, cls: 'pill-wait' };
}

function clientReplyNote(r: RequestRow, t: (ka: string, en: string, vars?: Record<string, string | number>) => string): string | null {
  if (r.client_reply === 'approved' && r.approved_rate != null) {
    if (isRateWriteDeferred(r)) {
      return t('კლიენტმა დაამტკიცა {rate}. გაწერას ელოდება. ხაზინის რიგში ჯერ არ არის.', 'Client approved {rate}. Waiting to write the rate. Not on the treasury queue yet.', { rate: fmtRate(r.approved_rate) });
    }
    return t('კლიენტმა დაამტკიცა {rate}. გაეგზავნა ხაზინას და მენეჯერებს.', 'Client approved {rate}. Sent to treasury and managers.', { rate: fmtRate(r.approved_rate) });
  }
  if (r.client_reply === 'better') {
    if (r.better_decision === 'accepted' && r.given_rate != null) return t('ხაზინამ დაადასტურა {rate}.', 'Treasury accepted {rate}.', { rate: fmtRate(r.given_rate) });
    if (r.better_decision === 'corrected' && r.given_rate != null) return t('გასწორებული კურსი: {rate}.', 'Corrected rate: {rate}.', { rate: fmtRate(r.given_rate) });
    if (r.wanted_rate != null) return t('ხაზინას ელოდება. კლიენტს სურს {rate}.', 'Waiting on treasury. The client wants {rate}.', { rate: fmtRate(r.wanted_rate) });
  }
  if (r.client_reply === 'declined' && r.client_decline_reason) {
    return t('კლიენტმა უარი თქვა: {reason}', 'Client declined: {reason}', { reason: r.client_decline_reason });
  }
  return null;
}

export default function Requests() {
  const { profile } = useAuth();
  const { role, realRole } = useViewAs();
  const { t, lang } = useI18n();
  const toast = useToast();
  useTick(15000);
  const isKam = role === 'kam';
  const seeAll = role === 'admin' || role === 'manager';

  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [info, setInfo] = useState<ClientInfo | null>(null);
  const [clientForm, setClientForm] = useState(0);
  const [sells, setSells] = useState('USD');
  const [gets, setGets] = useState('GEL');
  const [sellsAmount, setSellsAmount] = useState('');
  const [getsAmount, setGetsAmount] = useState('');
  const [clientRate, setClientRate] = useState('');
  const [banks, setBanks] = useState<string[]>([]);
  const [banksFromClient, setBanksFromClient] = useState(false);
  const [note, setNote] = useState('');
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
  const replyLock = useRef(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editClientId, setEditClientId] = useState('');
  const [editName, setEditName] = useState('');
  const [editSells, setEditSells] = useState('USD');
  const [editGets, setEditGets] = useState('GEL');
  const [editSellsAmt, setEditSellsAmt] = useState('');
  const [editGetsAmt, setEditGetsAmt] = useState('');
  const [editRate, setEditRate] = useState('');
  const [editBanks, setEditBanks] = useState<string[]>([]);
  const [editNote, setEditNote] = useState('');
  const [editTried, setEditTried] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [approvedRows, setApprovedRows] = useState<RequestRow[]>([]);
  const [approvedLoaded, setApprovedLoaded] = useState(false);
  const [approvedError, setApprovedError] = useState('');
  const [doneRows, setDoneRows] = useState<RequestRow[]>([]);
  const [activityRows, setActivityRows] = useState<RequestRow[]>([]);
  const [followRows, setFollowRows] = useState<RequestRow[]>([]);
  const histReq = useRef(0);
  const appliedClient = useRef<string | null>(null);
  const bankClient = useRef<string | null>(null);
  const bankClientKnown = useRef(false);
  const banksTouched = useRef(false);
  const specialRef = useRef<SpecialTermsDraft>(EMPTY_SPECIAL_DRAFT);
  const deferGate = useDeferWriteReady();
  const months = monthOptions(12).map((m) => ({ value: m.value, label: m.label.replace(/, so far$|, ჯერჯერობით$/, '') }));

  const today = todayTbilisi();

  const load = useCallback(async () => {
    if (!isKam || !profile) { setLoaded(true); return; }
    const extras = loadKamWorkspaceExtras(profile.id, today);
    const paintExtras = async () => {
      try {
        const next = await extras;
        setActivityRows((prev) => (JSON.stringify(prev) === JSON.stringify(next.activity) ? prev : next.activity));
        setFollowRows((prev) => (JSON.stringify(prev) === JSON.stringify(next.followUp) ? prev : next.followUp));
      } catch {
        /* the open list still paints */
      }
    };
    const active = await supabase
      .from('request_active')
      .select(ACTIVE_COLUMNS)
      .eq('kam_id', profile.id)
      .or(`request_date.eq.${today},quote_status.eq.asking`)
      .order('asked_at', { ascending: false });
    if (active.error && isMissingRead(active.error)) {
      const { data, error } = await supabase
        .from('request_outcomes')
        .select('*')
        .eq('kam_id', profile.id)
        .or(`request_date.eq.${today},quote_status.eq.asking`)
        .order('asked_at', { ascending: false });
      if (!error) {
        const next = await withClientContext(await appendDeferredOpen(profile.id, await withPeople((data ?? []) as RequestRow[]), async (ids) => {
          const more = await supabase.from('request_outcomes').select('*').in('id', ids);
          if (more.error || !more.data) return [];
          return withPeople(more.data as RequestRow[]);
        }));
        setRows((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        const went = next.filter((row) => row.went_through && row.request_date === today);
        setDoneRows((prev) => (JSON.stringify(prev) === JSON.stringify(went) ? prev : went));
      }
      await paintExtras();
      setLoaded(true);
      return;
    }
    if (!active.error) {
      const fetched = (active.data ?? []) as unknown as ActiveSource[];
      const matched = await matchedSuccessIds(fetched.map((row) => row.id));
      // Do not paint this payload if we could not ask the outcomes view.
      // The last reconciled list stays, so a payment match is not shown as a loss.
      if (matched) {
        let freshnessDay = '';
        try {
          const iso = await rpc<string | null>('data_freshness');
          freshnessDay = iso ? tbilisiDay(iso) : '';
        } catch {
          freshnessDay = '';
        }
        const next = await withClientContext(await appendDeferredOpen(
          profile.id,
          await withPeople(fetched.map((row) => applyMatchedSuccess(decorateActiveRow(row, freshnessDay), matched))),
          async (ids) => {
            const more = await supabase.from('request_active').select(ACTIVE_COLUMNS).in('id', ids);
            if (more.error || !more.data) return [];
            const extra = more.data as unknown as ActiveSource[];
            const extraMatched = await matchedSuccessIds(extra.map((row) => row.id));
            if (!extraMatched) return [];
            return withPeople(extra.map((row) => applyMatchedSuccess(decorateActiveRow(row, freshnessDay), extraMatched)));
          },
        ));
        setRows((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        setDoneRows((prev) => (prev.length === 0 ? prev : []));
      }
    }
    await paintExtras();
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
      let written = await withPeople((data ?? []) as RequestRow[]);
      if (isKam && profile) {
        const held = await deferredOpenIds(profile.id);
        if (held.length) {
          const skip = new Set(held);
          written = written.filter((row) => !skip.has(row.id));
        }
      }
      written = await withClientContext(written);
      if (ticket !== histReq.current) return;
      setHistory((prev) => (JSON.stringify(prev) === JSON.stringify(written) ? prev : written));
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
      const next = await withPeople((data ?? []) as RequestRow[]);
      setApprovedRows((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      setApprovedError('');
    }
    setApprovedLoaded(true);
  }, [seeAll, t]);

  useEffect(() => { void load(); }, [load]);
  // History stays off Realtime and off the short poll. It loads when this
  // page opens, when month / KAM / page size change, and from refresh().
  useEffect(() => { void loadHistory(); }, [loadHistory]);
  useEffect(() => { void loadApproved(); }, [loadApproved]);
  useLive(['requests'], () => { void load(); }, 10000, { realtime: isKam });
  useLive(['requests'], () => { void loadApproved(); }, 60000, { realtime: false });

  useEffect(() => {
    if (!seeAll) return;
    supabase.from('profiles').select('id, full_name, email').eq('role', 'kam').order('full_name')
      .then(({ data }) => setKams((data ?? []) as { id: string; full_name: string; email: string }[]));
  }, [seeAll]);

  const sellsSide = readAmount(sellsAmount);
  const getsSide = readAmount(getsAmount);
  const rateSide = readRate(clientRate);
  const hasAmount = (sellsSide.value != null) || (getsSide.value != null);
  const bothBlank = sellsSide.ok && getsSide.ok && !hasAmount;
  const currenciesOk = sells !== gets && (CURRENCIES as readonly string[]).includes(sells) && (CURRENCIES as readonly string[]).includes(gets);
  const chosenBanks = bankList(banks);

  function onInfo(next: ClientInfo | null) {
    setInfo(next);
    if (next?.picked && next.lastSells && next.lastGets && appliedClient.current !== next.id) {
      const known = CURRENCIES as readonly string[];
      if (known.includes(next.lastSells) && known.includes(next.lastGets)) {
        appliedClient.current = next.id;
        setSells(next.lastSells);
        setGets(next.lastGets);
      }
    }
    if (!next?.valid || !next.id) return;
    if (bankClient.current === next.id) return;
    const previousKnown = bankClientKnown.current;
    bankClient.current = next.id;
    bankClientKnown.current = next.known;
    if (next.known) {
      const remembered = bankList(next.banks);
      setBanks(remembered);
      setBanksFromClient(remembered.length > 0);
      banksTouched.current = false;
    } else if (previousKnown && !banksTouched.current) {
      setBanks([]);
      setBanksFromClient(false);
    }
  }

  function toggleBank(code: string) {
    banksTouched.current = true;
    setBanksFromClient(false);
    setBanks((cur) => bankList(cur.includes(code) ? cur.filter((item) => item !== code) : [...cur, code]));
  }

  function pickSells(c: string) {
    setSells(c);
    if (gets === c) setGets(c === 'GEL' ? 'USD' : 'GEL');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!info?.ready || !info.name || chosenBanks.length < 1 || !hasAmount || !sellsSide.ok || !getsSide.ok || !rateSide.ok || !currenciesOk) return;
    setBusy(true);
    try {
      // Fresh array in TBC, BOG, Liberty order. Only BOG is ['BOG'], never the string "BOG".
      const pBank = BANKS.filter((code) => chosenBanks.includes(code));
      await rpc('log_request', {
        p_client_id: info.id,
        p_sells_currency: sells,
        p_gets_currency: gets,
        p_amount: sellsSide.value,
        p_gets_amount: getsSide.value,
        p_client_rate: rateSide.value,
        p_note: note.trim() || null,
        p_client_name: info.nameFromFile ? null : info.name,
        p_bank: pBank,
      });
      const special = await saveClientSpecialRate(info.id, specialRef.current);
      const sent = t('გაეგზავნა ხაზინას. კურსი ქვემოთ გამოჩნდება, როგორც კი უპასუხებენ.', 'Sent to treasury. The rate appears below as soon as they answer.');
      if (special === 'invalid' || special === 'failed') {
        toast(sent + ' ' + t('საბანკო პირობა ვერ შეინახა.', 'The bank terms were not saved.'), 'error');
      } else {
        toast(sent);
      }
      setInfo(null);
      setClientForm((n) => n + 1);
      setSellsAmount('');
      setGetsAmount('');
      setClientRate('');
      setBanks([]);
      setBanksFromClient(false);
      setNote('');
      setTried(false);
      appliedClient.current = null;
      bankClient.current = null;
      bankClientKnown.current = false;
      banksTouched.current = false;
      specialRef.current = EMPTY_SPECIAL_DRAFT;
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(false);
  }

  async function askAgain(r: RequestRow) {
    try {
      await rpc('ask_again', { p_request_id: r.id, p_note: null });
      toast(t('ხელახლა გაეგზავნა ხაზინას.', 'Sent to treasury again.'));
      load();
    } catch (err) { toast((err as Error).message, 'error'); }
  }

  function canChange(r: RequestRow) {
    return canDeleteRequest(realRole, profile?.id, r.kam_id);
  }

  function openEdit(r: RequestRow) {
    setEditId(r.id);
    setEditClientId(r.client_id);
    setEditName(r.client_name ?? '');
    setEditSells(r.sells_currency && /^[A-Z]{3}$/.test(r.sells_currency) ? r.sells_currency : 'USD');
    setEditGets(r.gets_currency && /^[A-Z]{3}$/.test(r.gets_currency) ? r.gets_currency : 'GEL');
    setEditSellsAmt(r.amount != null ? String(r.amount) : '');
    setEditGetsAmt(r.gets_amount != null ? String(r.gets_amount) : '');
    setEditRate(r.client_rate != null ? String(r.client_rate) : '');
    setEditBanks(bankList(r.bank));
    setEditNote(r.note ?? '');
    setEditTried(false);
  }

  function currencyKept(code: string, original: string | null) {
    if (code === original && /^[A-Z]{3}$/.test(code)) return true;
    return (CURRENCIES as readonly string[]).includes(code);
  }

  async function saveEdit(e: FormEvent, r: RequestRow) {
    e.preventDefault();
    setEditTried(true);
    const idOk = /^([0-9]{9}|[0-9]{11})$/.test(editClientId.trim());
    const nameOk = editName.trim().length >= 2;
    const sellAmt = readAmount(editSellsAmt);
    const getAmt = readAmount(editGetsAmt);
    const rateAmt = readRate(editRate);
    const picked = bankList(editBanks);
    const pairOk = editSells !== editGets && currencyKept(editSells, r.sells_currency) && currencyKept(editGets, r.gets_currency);
    const hasSide = sellAmt.value != null || getAmt.value != null;
    if (!idOk || !nameOk || !sellAmt.ok || !getAmt.ok || !rateAmt.ok || !pairOk || !hasSide || picked.length < 1) return;
    setEditBusy(true);
    try {
      await rpc('edit_request', {
        p_request_id: r.id,
        p_client_id: editClientId.trim(),
        p_client_name: editName.trim(),
        p_sells_currency: editSells,
        p_gets_currency: editGets,
        p_amount: sellAmt.value,
        p_gets_amount: getAmt.value,
        p_client_rate: rateAmt.value,
        p_note: editNote.trim() || null,
        p_bank: BANKS.filter((code) => picked.includes(code)),
      });
      toast(t('მოთხოვნა შეიცვალა.', 'Request updated.'));
      setEditId(null);
      load();
      loadHistory();
      loadApproved();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setEditBusy(false);
  }

  function editForm(r: RequestRow) {
    if (editId !== r.id) return null;
    const idOk = /^([0-9]{9}|[0-9]{11})$/.test(editClientId.trim());
    const nameOk = editName.trim().length >= 2;
    const sellAmt = readAmount(editSellsAmt);
    const getAmt = readAmount(editGetsAmt);
    const rateAmt = readRate(editRate);
    const picked = bankList(editBanks);
    const pairOk = editSells !== editGets && currencyKept(editSells, r.sells_currency) && currencyKept(editGets, r.gets_currency);
    const hasSide = sellAmt.value != null || getAmt.value != null;
    const bothBlank = sellAmt.ok && getAmt.ok && !hasSide;
    return (
      <form onSubmit={(e) => saveEdit(e, r)} noValidate style={{ flex: '1 1 100%' }}>
        <div className="form-row">
          <div className="field" style={{ flex: '1 1 180px', minWidth: 160 }}>
            <label htmlFor={'edit-id-' + r.id}>{t('კლიენტის ID', 'Client ID')}</label>
            <input id={'edit-id-' + r.id} className={'input' + (editTried && !idOk ? ' invalid' : '')} inputMode="numeric" autoComplete="off" value={editClientId} onChange={(e) => setEditClientId(e.target.value)} />
            {editTried && !idOk && <span className="hint error">{t('კომპანიას 9 ციფრი აქვს, ადამიანს 11', 'A company has 9 digits, a person 11')}</span>}
          </div>
          <div className="field" style={{ flex: '2 1 220px', minWidth: 180 }}>
            <label htmlFor={'edit-name-' + r.id}>{t('კლიენტის სახელი', 'Client name')}</label>
            <input id={'edit-name-' + r.id} className={'input' + (editTried && !nameOk ? ' invalid' : '')} autoComplete="off" value={editName} onChange={(e) => setEditName(e.target.value)} />
            {editTried && !nameOk && <span className="hint error">{t('ჩაწერეთ სახელი', 'Enter the name')}</span>}
          </div>
          <div className="field" style={{ flex: '1 1 280px', minWidth: 220 }}>
            <span className="label" id={'edit-banks-' + r.id}>{t('ბანკი, სადაც კლიენტი აგზავნის', 'Bank the client is sending to')}</span>
            <div className="seg" role="group" aria-labelledby={'edit-banks-' + r.id} aria-invalid={editTried && picked.length < 1}>
              {BANKS.map((code) => (
                <button key={code} type="button" aria-pressed={picked.includes(code)} onClick={() => setEditBanks((cur) => bankList(cur.includes(code) ? cur.filter((item) => item !== code) : [...cur, code]))}>
                  {code}
                </button>
              ))}
            </div>
            {editTried && picked.length < 1 && <span className="hint error">{t('აირჩიეთ ერთი ბანკი მაინც', 'Choose at least one bank')}</span>}
          </div>
        </div>
        <div className="form-row" style={{ marginTop: 16 }}>
          <div className="deal-side">
            <CurrencyPicker label={t('კლიენტი ყიდის', 'Client sells')} value={editSells} onChange={(c) => { setEditSells(c); if (editGets === c) setEditGets(c === 'GEL' ? 'USD' : 'GEL'); }} idSuffix={'edit-' + r.id} />
            <div className="field" style={{ flex: '1 1 140px', minWidth: 130 }}>
              <label htmlFor={'edit-sells-' + r.id}>{t('თანხა', 'Amount')}</label>
              <input id={'edit-sells-' + r.id} className={'input' + (editTried && !sellAmt.ok ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={editSellsAmt} onChange={(e) => setEditSellsAmt(e.target.value)} />
            </div>
          </div>
          <div className="deal-side">
            <CurrencyPicker label={t('კლიენტი იღებს', 'Client gets')} value={editGets} onChange={setEditGets} disabledValue={editSells} idSuffix={'edit-' + r.id} />
            <div className="field" style={{ flex: '1 1 140px', minWidth: 130 }}>
              <label htmlFor={'edit-gets-' + r.id}>{t('თანხა', 'Amount')}</label>
              <input id={'edit-gets-' + r.id} className={'input' + (editTried && !getAmt.ok ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={editGetsAmt} onChange={(e) => setEditGetsAmt(e.target.value)} />
            </div>
          </div>
        </div>
        <p className={'hint' + (editTried && (!pairOk || bothBlank) ? ' error' : '')} style={{ margin: '8px 0 0' }}>
          {editTried && !pairOk
            ? t('აირჩიეთ ორი განსხვავებული ვალუტა', 'Choose two different currencies')
            : editTried && bothBlank
              ? t('ჩაწერეთ თანხა ერთ მხარეს', 'Enter an amount on one side')
              : t('შეავსეთ ერთი თანხა. მეორე დატოვეთ ცარიელი, თუ არ გაქვთ.', 'Fill in one amount. Leave the other blank if you do not have it.')}
        </p>
        <div className="form-row" style={{ marginTop: 16 }}>
          <div className="field" style={{ flex: '1 1 200px', minWidth: 180 }}>
            <label htmlFor={'edit-rate-' + r.id}>{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')} <span className="muted" style={{ fontWeight: 400 }}>({t('არასავალდებულო', 'optional')})</span></label>
            <input id={'edit-rate-' + r.id} className={'input' + (editTried && !rateAmt.ok ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={editRate} onChange={(e) => setEditRate(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '2 1 240px', minWidth: 200 }}>
            <label htmlFor={'edit-note-' + r.id}>{t('კომენტარი ხაზინისთვის', 'Comment for treasury')} <span className="muted" style={{ fontWeight: 400 }}>({t('არასავალდებულო', 'optional')})</span></label>
            <input id={'edit-note-' + r.id} className="input" autoComplete="off" value={editNote} onChange={(e) => setEditNote(e.target.value)} />
          </div>
          <div className="row" style={{ paddingTop: 27, gap: 12 }}>
            <button type="submit" className="btn btn-primary" disabled={editBusy}>{editBusy ? t('ინახება…', 'Saving…') : t('შენახვა', 'Save')}</button>
            <button type="button" className="link" onClick={() => setEditId(null)}>{t('გაუქმება', 'Cancel')}</button>
            {canChange(r) && !isWrittenHistory(r) && <DeleteRequestButton requestId={r.id} onDeleted={() => { setEditId(null); refresh(); }} />}
          </div>
        </div>
        {idOk && !hideEarlierDeals(r) && <ClientHistory clientId={editClientId.trim()} excludeId={r.id} />}
      </form>
    );
  }

  function refresh() {
    load();
    loadHistory();
    loadApproved();
  }

  function openReply(id: number, kind: 'approved' | 'better' | 'declined') {
    setReply((cur) => (cur?.id === id && cur.kind === kind ? null : { id, kind }));
    setReplyRate('');
    setReplyReason('');
    setReplyTried(false);
  }

  async function saveReply(r: RequestRow, defer = false) {
    if (!reply || reply.id !== r.id || replyLock.current) return;
    setReplyTried(true);
    const parsed = readRate(replyRate);
    const reason = replyReason.trim();
    if (reply.kind === 'declined') {
      if (reason.length < 2) return;
    } else if (!parsed.ok || parsed.value == null) {
      return;
    }
    replyLock.current = true;
    setReplyBusy(true);
    try {
      if (defer && reply.kind === 'approved') {
        await rpc('kam_defer_rate_write', { p_request_id: r.id, p_rate: parsed.value });
      } else {
        await rpc('kam_client_reply', {
          p_request_id: r.id,
          p_reply: reply.kind,
          p_rate: reply.kind === 'declined' ? null : parsed.value,
          p_reason: reply.kind === 'declined' ? reason : null,
        });
      }
      toast(defer
        ? t('კლიენტის დადასტურება შეინახა. ხაზინის რიგში ჯერ არ არის.', 'The client approval is saved. It is not on the treasury queue yet.')
        : reply.kind === 'approved'
        ? t('გაეგზავნა ხაზინას და მენეჯერებს.', 'Sent to treasury and managers.')
        : reply.kind === 'better'
          ? t('გაეგზავნა ხაზინას.', 'Sent to treasury.')
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
    replyLock.current = false;
    setReplyBusy(false);
  }

  // a quoted rate whose time has passed is expired, even before the next reload
  const stateOf = (r: RequestRow) =>
    r.quote_state === 'quoted' && r.rate_valid_until && new Date(r.rate_valid_until) < new Date() ? 'expired' : r.quote_state;

  const { open, todayCount } = splitKamRequests(rows, doneRows, today);
  const workspace = groupKamRows(open, [...rows, ...doneRows, ...activityRows], followRows, today);
  const openStages = [
    { id: 'kam-action', title: t('კლიენტს ელოდება', 'Awaiting client'), rows: workspace.awaitingClient, empty: t('კლიენტის პასუხს არაფერი ელოდება.', 'Nothing is awaiting the client.') },
    { id: 'kam-waiting', title: t('ხაზინას ელოდება', 'Awaiting treasury'), rows: workspace.awaitingTreasury, empty: t('ხაზინას არაფერი ელოდება.', 'Nothing is waiting on treasury.') },
    { id: 'kam-held', title: t('შეჩერებული', 'Held'), rows: workspace.held, empty: t('შეჩერებული კურსი არ არის.', 'No rate is held.') },
    { id: 'kam-follow', title: t('დაბრუნება', 'Follow-up'), rows: workspace.followUp, empty: t('ბოლო 7 დღეში დასაბრუნებელი არ არის.', 'No follow-up in the last 7 days.') },
    ...(workspace.stillOpen.length
      ? [{ id: 'kam-still', title: t('სხვა ღია', 'Other open'), rows: workspace.stillOpen, empty: '' }]
      : []),
  ];

  function activityLine(r: RequestRow, label: string, cls: string) {
    const transferText = bookedLine(r);
    return (
      <div key={r.id} className="list-row" style={{ paddingTop: 12, paddingBottom: 12 }}>
        <span className="when muted">{fmtTime(r.requested_at)}</span>
        <div className="who">
          <div className="strong">{r.client_name ?? r.client_id}</div>
          <RequestKamLine ownerName={r.owner_name} ownerState={r.owner_state} ownerSource={r.owner_source} requestKam={r.kam_name} />
        </div>
        <span className="what">{describeDeal(r.sells_currency, r.amount, r.gets_currency, r.gets_amount)}{r.rate ? ' ' + t('კურსით', 'at') + ' ' + fmtRate(r.rate) : ''}{formatBanks(r.bank) ? ' · ' + formatBanks(r.bank) : ''}<RatePeople quoted={r.quoted_by_name} written={r.written_by_name} />
          {r.rate_written_at && <WrittenRateNote writtenAt={r.rate_written_at} />}
          {r.payment_confirmed_at && <div className="tiny muted">{t('გადახდა დადასტურდა {when}', 'Payment confirmed {when}', { when: fmtTime(r.payment_confirmed_at) })}</div>}
        </span>
        <span className={'pill ' + cls} style={{ marginLeft: 'auto' }}>{label}</span>
        {canChange(r) && (
          <div className="actions">
            <CorrectStatusButton row={r} onDone={refresh} />
            <button type="button" className="btn" onClick={() => openEdit(r)}>{t('რედაქტირება', 'Edit')}</button>
            {!isWrittenHistory(r) && <DeleteRequestButton requestId={r.id} onDeleted={() => { if (editId === r.id) setEditId(null); refresh(); }} />}
          </div>
        )}
        {editForm(r)}
        <LossApproval row={r} onDone={refresh} />
        {transferText && <CopyLine label={t('კლიენტის ID', 'Client ID')} text={r.client_id} />}
        {transferText && <CopyLine label={t('ტექსტი ჩარიცხვისთვის', 'Text for the transfer')} text={transferText} />}
      </div>
    );
  }

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
          <div className="stat"><div className="label">{t('გადახდა', 'Paid')}</div><div className="value ok-text">{workspace.paidToday.length}</div></div>
        </div>}
      </div>

      {isKam && <section className="card card-primary" aria-labelledby="new-title">
        <h2 id="new-title" style={{ marginBottom: 16 }}>{t('ახალი მოთხოვნა', 'New request')}</h2>
        <form onSubmit={submit} noValidate>
          <div className="form-row">
            <ClientField key={clientForm} tried={tried} onInfo={onInfo} />
            <div className="field" style={{ flex: '1 1 280px', minWidth: 220 }}>
              <span className="label" id="client-banks-label">{t('ბანკი, სადაც კლიენტი აგზავნის', 'Bank the client is sending to')}</span>
              <div className="seg" role="group" aria-labelledby="client-banks-label" aria-invalid={tried && chosenBanks.length < 1}>
                {BANKS.map((code) => (
                  <button
                    key={code}
                    type="button"
                    aria-pressed={chosenBanks.includes(code)}
                    onClick={() => toggleBank(code)}
                  >
                    {code}
                  </button>
                ))}
              </div>
              <span className={'hint' + (tried && chosenBanks.length < 1 ? ' error' : '')}>
                {tried && chosenBanks.length < 1
                  ? t('აირჩიეთ ერთი ბანკი მაინც', 'Choose at least one bank')
                  : banksFromClient
                    ? t('შენახული ბანკები ჩანს. ამ გარიგებისთვის შეგიძლიათ შეცვალოთ. სამივე ერთადაც შეიძლება.', 'Saved banks are on. You can change them for this deal. All three together is allowed.')
                    : t('აირჩიეთ TBC, BOG, Liberty — ერთი, ორი ან სამივე.', 'Choose TBC, BOG, Liberty — one, two, or all three.')}
              </span>
            </div>
          </div>
          <ClientSpecialTerms key={clientForm} clientId={info?.valid ? info.id : null} idSuffix="desk" requestSells={sells} requestGets={gets} onDraft={(draft) => { specialRef.current = draft; }} />
          <DynamicActiveNegotiatedRates clientId={info?.valid ? info.id : null} idSuffix="desk" />
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
              <label htmlFor="treasury-comment">{t('კომენტარი ხაზინისთვის', 'Comment for treasury')} <span className="muted" style={{ fontWeight: 400 }}>({t('არასავალდებულო', 'optional')})</span></label>
              <input id="treasury-comment" className="input" autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div style={{ paddingTop: 27 }}>
              <button type="submit" className="btn btn-primary" style={{ minHeight: 48 }} disabled={busy}><IconPlus />{busy ? t('იგზავნება…', 'Sending…') : t('კურსის თხოვნა ხაზინას', 'Ask treasury for a rate')}</button>
            </div>
          </div>
          {info?.valid && info.id && <ClientHistory clientId={info.id} />}
        </form>
      </section>}

      {isKam && <section className="card flush" aria-labelledby="open-title">
        <div className="card-head">
          <h2 id="open-title" style={{ fontSize: 22 }}>{t('ღია მოთხოვნები', 'Open requests')}</h2>
          <span className="small muted">{t('ხაზინის კურსი აქ ჩნდება. ღია მოთხოვნაზე შეგიძლიათ მონიშნოთ, რომ ტრანზაქცია გავიდა, ან რომ დაიკარგა.', 'Treasury’s rate appears here. On an open request you can mark that the transaction went through, or that it was lost.')}</span>
        </div>
        {!loaded && <LoadingLine />}
        {loaded && openStages.map((stage) => (
          <div key={stage.id} className="workspace-stage" id={stage.id}>
            <h3>{stage.title}</h3>
            {stage.rows.length === 0 && <p className="empty">{stage.empty}</p>}
            {stage.id === 'kam-follow' && stage.rows.length > 0 && (
              <p className="empty" style={{ borderTop: 'none', paddingTop: 0 }}>
                <Link to="/follow-ups" className="btn">{t('მიზეზის ჩაწერა', 'Record the reason')}</Link>
              </p>
            )}
            {stage.rows.map((r) => {
          const st = stateOf(r);
          const answer = clientReplyNote(r, t);
          const chatText = r.client_reply === 'approved' && r.approved_rate != null ? chatHandoff(r.client_id, r.approved_rate) : null;
          const transferText = bookedLine(r);
          const canAnswer = !isPendingLoss(r) && !r.client_reply && r.quote_status === 'quoted';
          const offerText = !chatText && r.rate != null && canAnswer ? clientOffer(r.rate) : null;
          const lostPending = isPendingLoss(r);
          const replyOpen = canAnswer && reply?.id === r.id ? reply.kind : null;
          const parsedReply = readRate(replyRate);
          const replyRateOk = parsedReply.ok && parsedReply.value != null;
          const replyReasonOk = replyReason.trim().length >= 2;
          const own = canChange(r);
          const held = isRateWriteDeferred(r);
          const canAskAgain = !lostPending && (st === 'expired' || st === 'declined')
            && r.client_reply !== 'approved'
            && !(r.client_reply === 'better' && !r.better_decision);
          return (
            <div key={r.id} className={'list-row' + (canAnswer ? ' highlight' : '')}>
              <div className="when">
                <div className="strong">{fmtTime(r.requested_at)}</div>
                <div className="tiny muted">{ago(r.asked_at)}</div>
              </div>
              <div className="who">
                <div className="name">{r.client_name ?? r.client_id}</div>
                <div className="tiny muted">ID {r.client_id}</div>
                <RequestKamLine ownerName={r.owner_name} ownerState={r.owner_state} ownerSource={r.owner_source} requestKam={r.kam_name} />
                {formatBanks(r.bank) && <div className="tiny">{t('ბანკი', 'Bank')}: {formatBanks(r.bank)}</div>}
              </div>
              <div className="what">
                <div>{describeDeal(r.sells_currency, r.amount, r.gets_currency, r.gets_amount)}</div>
                <RatePeople quoted={r.quoted_by_name} written={r.written_by_name} />
                {r.client_rate != null && <div className="tiny muted">{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')}: {fmtRate(r.client_rate)}</div>}
                {r.note && <div className="tiny muted">{t('კომენტარი', 'Comment')}: {r.note}</div>}
                {lostPending && (
                  <div className="tiny muted">
                    {t('მიზეზი', 'Reason')}: {lossReasonLabel(r.loss_reason, lang)}
                    {r.loss_reason_note ? ` — ${r.loss_reason_note}` : ''}
                  </div>
                )}
                {answer
                  ? <div className="tiny muted">{answer}</div>
                  : (
                    <div className="tiny muted">
                      {st === 'asking' && t('იკითხა {time}-ზე', 'Asked at {time}', { time: fmtTime(r.asked_at) })}
                      {canAnswer && t('კლიენტს უთხარით კურსი და ჩაწერეთ პასუხი.', 'Tell the client the rate and record the answer.')}
                      {!canAnswer && st === 'expired' && t('ხელახლა იკითხეთ, თუ კლიენტს კვლავ სურს კონვერტაცია', 'Ask again if the client still wants to convert')}
                      {st === 'declined' && (r.decline_reason ? t('ხაზინამ უარი თქვა: {reason}', 'Treasury declined: {reason}', { reason: treasuryReason(r.decline_reason, lang) }) : t('დაამატეთ დეტალები და ხელახლა იკითხეთ', 'Add details and ask again'))}
                    </div>
                  )}
              </div>
              {held && (
                <span className="pill pill-warn">
                  {t('კლიენტმა დაადასტურა — გაწერას ელოდება', 'Client confirmed — waiting to write the rate')}
                </span>
              )}
              {!held && lostPending && <span className="pill pill-alert">{t('დაიკარგა, ხაზინას ელოდება', 'Lost, waiting on treasury')}</span>}
              {!held && !lostPending && st === 'asking' && <span className="pill pill-wait"><IconClock />{t('ხაზინას ელოდება', 'Waiting on treasury')}</span>}
              {!held && !lostPending && canAnswer && r.rate != null && <span className="pill pill-warn">{t('კურსი {rate}', 'Rate {rate}', { rate: fmtRate(r.rate) })}</span>}
              {!lostPending && st === 'declined' && <span className="pill pill-alert">{t('ხაზინა', 'Treasury')}: {treasuryReason(r.decline_reason, lang)}</span>}
              <div className="actions">
                {canAnswer && (
                  <>
                    <button type="button" className="btn btn-primary" aria-pressed={replyOpen === 'approved'} onClick={() => openReply(r.id, 'approved')}>{t('კლიენტმა დაამტკიცა', 'Client approved')}</button>
                    <button type="button" className="btn" aria-pressed={replyOpen === 'better'} onClick={() => openReply(r.id, 'better')}>{t('კლიენტს უკეთესი კურსი სურს', 'Client wants a better rate')}</button>
                    <button type="button" className="btn btn-quiet" aria-pressed={replyOpen === 'declined'} onClick={() => openReply(r.id, 'declined')}>{t('კლიენტმა უარი თქვა', 'Client declined')}</button>
                  </>
                )}
                {canAskAgain && <button type="button" className="btn" onClick={() => askAgain(r)}>{t('ხელახლა კითხვა', 'Ask again')}</button>}
                <RequestOutcomeButtons row={r} onDone={refresh} />
                <CorrectStatusButton row={r} onDone={refresh} />
                {own && <button type="button" className="btn" onClick={() => openEdit(r)}>{t('რედაქტირება', 'Edit')}</button>}
                {own && !isWrittenHistory(r) && <DeleteRequestButton requestId={r.id} onDeleted={() => { if (editId === r.id) setEditId(null); refresh(); }} />}
              </div>
              {editForm(r)}
              <DeferWriteBar row={r} onDone={refresh} />
              <LossApproval row={r} onDone={refresh} />
              {(chatText || transferText) && <CopyLine label={t('კლიენტის ID', 'Client ID')} text={r.client_id} />}
              {chatText && <CopyLine label={t('ტექსტი ჩატისთვის', 'Text for chat')} text={chatText} />}
              {transferText && <CopyLine label={t('ტექსტი ჩარიცხვისთვის', 'Text for the transfer')} text={transferText} />}
              {offerText && <CopyLine label={t('ტექსტი კლიენტისთვის', 'Text for the client')} text={offerText} />}
              {replyOpen && (
                <form onSubmit={(e) => { e.preventDefault(); if (replyOpen === 'approved' && deferGate === 'unknown') return; void saveReply(r, false); }} noValidate style={{ flex: '1 1 100%', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
                  {replyOpen !== 'declined' ? (
                    <div className="field" style={{ flex: '1 1 200px', maxWidth: 280 }}>
                      <label htmlFor={'reply-rate-' + r.id}>{t('ჩაწერეთ კურსი', 'Enter the rate')}</label>
                      <input id={'reply-rate-' + r.id} className={'input' + (replyTried && !replyRateOk ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={replyRate} onChange={(e) => setReplyRate(e.target.value)} />
                      <span className={'hint' + (replyTried && !replyRateOk ? ' error' : '')}>
                        {replyTried && !replyRateOk
                          ? t('ჩაწერეთ კურსი', 'Enter the rate')
                          : replyOpen === 'approved' && deferGate === 'on'
                            ? t('გაწერეთ კურსი ხაზინის რიგში აგზავნის. ჯერ არ გაწეროთ კურსი შეთანხმებულ კურსს ინახავს და ღია მოთხოვნაზე ტოვებს. მოგვიანებით გაწერა იმავე კურსს აგზავნის.', 'Write the rate sends it to the treasury queue. Do not write the rate yet keeps the agreed rate on your open requests. A later write sends that same rate.')
                            : replyOpen === 'approved'
                              ? t('მოთხოვნა მიდის ხაზინასთან და მენეჯერებთან.', 'This goes to treasury and to managers.')
                              : t('მოთხოვნა მიდის მხოლოდ ხაზინასთან. ხაზინის პასუხის შემდეგ იგივე სამი პასუხი ისევ გამოჩნდება.', 'This goes only to treasury. After treasury answers, the same three replies appear again.')}
                      </span>
                    </div>
                  ) : (
                    <div className="field" style={{ flex: '1 1 280px' }}>
                      <label htmlFor={'reply-reason-' + r.id}>{t('მიზეზი', 'Reason')}</label>
                      <input id={'reply-reason-' + r.id} className={'input' + (replyTried && !replyReasonOk ? ' invalid' : '')} autoComplete="off" value={replyReason} onChange={(e) => setReplyReason(e.target.value)} />
                      <span className={'hint' + (replyTried && !replyReasonOk ? ' error' : '')}>
                        {replyTried && !replyReasonOk ? t('ჩაწერეთ მიზეზი', 'Enter a reason') : t('ხაზინა დაინახავს მიზეზს.', 'Treasury will see the reason.')}
                      </span>
                    </div>
                  )}
                  {replyOpen === 'approved' && deferGate === 'unknown' && <LoadingLine compact />}
                  {replyOpen === 'approved' && deferGate === 'on' && (
                    <>
                      <button type="button" className="btn btn-primary" disabled={replyBusy} onClick={() => { void saveReply(r, false); }}>{replyBusy ? t('იტვირთება', 'Loading') : t('გაწერეთ კურსი', 'Write the rate')}</button>
                      <button type="button" className="btn" disabled={replyBusy} onClick={() => { void saveReply(r, true); }}>{t('ჯერ არ გაწეროთ კურსი', 'Do not write the rate yet')}</button>
                    </>
                  )}
                  {(replyOpen !== 'approved' || deferGate === 'off') && (
                    <button type="submit" className="btn btn-primary" disabled={replyBusy}>{replyBusy ? t('იტვირთება', 'Loading') : replyOpen === 'declined' ? t('შენახვა', 'Save') : t('გაგზავნა', 'Send')}</button>
                  )}
                  <button type="button" className="link" onClick={() => setReply(null)}>{t('უკან', 'Back')}</button>
                </form>
              )}
            </div>
          );
            })}
          </div>
        ))}
      </section>}

      {isKam && <RequestSearch variant="desk" />}

      {isKam && <section className="card flush" aria-labelledby="today-title">
        <div className="card-head">
          <h2 id="today-title" style={{ fontSize: 18 }}>{t('დღევანდელი აქტივობა', "Today's activity")}</h2>
          <span className="small muted">{t('გაწერილი კურსი გადახდა არ არის. შეთანხმების ფაილი აქ არ ჩანს მხოლოდ იმიტომ, რომ დღეს შემოვიდა.', 'A written rate is not a payment. An agreement file is not listed here only because it was imported today.')}</span>
        </div>
        {!loaded && <LoadingLine />}
        {loaded && (
          <>
            <div className="workspace-stage" id="kam-written">
              <h3>{t('დღეს გაწერილი კურსი', 'Rate written today')}</h3>
              {workspace.writtenToday.length === 0 && <p className="empty">{t('დღეს გაწერილი კურსი არ არის.', 'No rate was written today.')}</p>}
              {workspace.writtenToday.map((r) => activityLine(r, t('გაწერილია', 'Written'), 'pill-warn'))}
            </div>
            <div className="workspace-stage" id="kam-paid">
              <h3>{t('დღეს დადასტურებული გადახდა', 'Payment confirmed today')}</h3>
              {workspace.paidToday.length === 0 && <p className="empty">{t('დღეს დადასტურებული გადახდა არ არის.', 'No payment was confirmed today.')}</p>}
              {workspace.paidToday.map((r) => activityLine(r, t('გადახდა დადასტურდა', 'Payment confirmed'), 'pill-ok'))}
            </div>
            <div className="workspace-stage" id="kam-lost">
              <h3>{t('დღეს უარი ან დაკარგული', 'Declined or lost today')}</h3>
              {workspace.lostToday.length === 0 && <p className="empty">{t('დღეს უარი ან დაკარგული არ არის.', 'Nothing was declined or lost today.')}</p>}
              {workspace.lostToday.map((r) => activityLine(r, t('უარი ან დაკარგული', 'Declined or lost'), 'pill-alert'))}
            </div>
          </>
        )}
      </section>}

      {seeAll && <section className="card flush" aria-labelledby="approved-title">
        <div className="card-head">
          <div>
            <h2 id="approved-title" style={{ fontSize: 22 }}>{t('კლიენტმა დაამტკიცა', 'Client approved')}</h2>
            <p className="small muted">{t('ბოლო 7 დღის დადასტურებები. ხაზინაც და მენეჯერებიც ხედავენ.', 'Approvals from the last 7 days. Treasury and managers both see them.')}</p>
          </div>
        </div>
        {approvedError && <p className="empty">{approvedError}</p>}
        {!approvedLoaded && !approvedError && <LoadingLine />}
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
              <RatePeople quoted={r.quoted_by_name} written={r.written_by_name} />
              <div>{t('კლიენტმა დაამტკიცა', 'Client approved')} {fmtRate(r.approved_rate)}</div>
              {r.rate != null && <div className="tiny muted">{t('ხაზინის კურსი', 'Treasury rate')}: {fmtRate(r.rate)}</div>}
            </div>
            {canChange(r) && (
              <div className="actions">
                <RequestOutcomeButtons row={r} onDone={refresh} />
                <CorrectStatusButton row={r} onDone={refresh} />
                <button type="button" className="btn" onClick={() => openEdit(r)}>{t('რედაქტირება', 'Edit')}</button>
                {!isWrittenHistory(r) && <DeleteRequestButton requestId={r.id} onDeleted={() => { if (editId === r.id) setEditId(null); refresh(); }} />}
              </div>
            )}
            {editForm(r)}
            <LossApproval row={r} onDone={refresh} />
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
        {!histLoaded && <LoadingLine />}
        {histLoaded && !histError && !history.length && (
          <p className="empty">
            {month === 'all' && kamFilter === 'all'
              ? t('წინა მოთხოვნა ჯერ არ არის. აქ გამოჩნდება, როცა შეთანხმების ფაილი ჩაიტვირთება.', 'No earlier requests yet. They appear here when the agreement file is loaded.')
              : t('ამ არჩევანზე არაფერია.', 'Nothing for this choice.')}
          </p>
        )}
        {histLoaded && history.map((r) => {
          const st = historyStatus(
            r,
            t('მოგებული', 'Won'),
            t('დაკარგული', 'Lost'),
            t('ღია', 'Open'),
          );
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
                <RequestKamLine ownerName={r.owner_name} ownerState={r.owner_state} ownerSource={r.owner_source} requestKam={r.kam_name} />
                {formatBanks(r.bank) && <div className="tiny">{t('ბანკი', 'Bank')}: {formatBanks(r.bank)}</div>}
              </div>
              <div className="what">
                <div>{describeDeal(r.sells_currency, r.amount, r.gets_currency, r.gets_amount)}{r.rate ? ' ' + t('კურსით', 'at') + ' ' + fmtRate(r.rate) : ''}</div>
                <RatePeople quoted={r.quoted_by_name} written={r.written_by_name} />
                {r.client_rate != null && <div className="tiny muted">{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')}: {fmtRate(r.client_rate)}</div>}
                {r.note && <div className="tiny muted">{t('კომენტარი', 'Comment')}: {r.note}</div>}
                {r.legacy_status?.trim() && <div className="tiny muted">{t('ფაილის სტატუსი', 'File status')}: {r.legacy_status}</div>}
                {r.loss_reason_note && <div className="tiny muted">{t('სხვა მიზეზი', 'Other reason')}: {r.loss_reason_note}</div>}
                {clientReplyNote(r, t) && <div className="tiny muted">{clientReplyNote(r, t)}</div>}
                {r.rate_written_at && <WrittenRateNote writtenAt={r.rate_written_at} />}
                {(chatText || transferText) && <CopyLine label={t('კლიენტის ID', 'Client ID')} text={r.client_id} />}
                {chatText && <CopyLine label={t('ტექსტი ჩატისთვის', 'Text for chat')} text={chatText} />}
                {transferText && <CopyLine label={t('ტექსტი ჩარიცხვისთვის', 'Text for the transfer')} text={transferText} />}
              </div>
              <span className={'pill ' + st.cls} style={{ marginLeft: 'auto' }}>
                {st.cls === 'pill-ok' && <IconCheck />}{st.label}
              </span>
              {(canChange(r) || (canMarkRequestOutcome(realRole, profile?.id, r.kam_id) && isOpenRequest(r))) && (
                <div className="actions">
                  <RequestOutcomeButtons row={r} onDone={refresh} />
                  <CorrectStatusButton row={r} onDone={refresh} />
                  {canChange(r) && <button type="button" className="btn" onClick={() => openEdit(r)}>{t('რედაქტირება', 'Edit')}</button>}
                  {canChange(r) && !isWrittenHistory(r) && <DeleteRequestButton requestId={r.id} onDeleted={() => { if (editId === r.id) setEditId(null); refresh(); }} />}
                </div>
              )}
              {editForm(r)}
              <LossApproval row={r} onDone={refresh} />
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
