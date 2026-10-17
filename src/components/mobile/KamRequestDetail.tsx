import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import CopyLine from '../CopyLine';
import DeleteRequestButton, { canDeleteRequest } from '../DeleteRequestButton';
import LossApproval from '../LossApproval';
import RequestOutcomeButtons, { canMarkRequestOutcome } from '../RequestOutcomeButtons';
import CorrectStatusButton from '../CorrectStatusButton';
import { useAuth } from '../../lib/auth';
import { chatHandoff, clientOffer, rateBooked } from '../../lib/copyText';
import { ago, fmtDateTime, fmtRate, sideAmount } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { isPendingLoss, isWrittenHistory, lossReasonLabel, treasuryReason } from '../../lib/requestStatus';
import { rpc } from '../../lib/supabase';
import { useToast } from '../../lib/toast';
import { useViewAs } from '../../lib/viewAs';
import { useScreenTitle } from '../../lib/screenTitle';
import { formatBanks, type RequestRow } from '../../lib/types';
import LoadingLine from '../LoadingLine';
import { readRate } from './amounts';
import { canAskAgain, mobileStatus, needsKamAction, pairLabel, quoteLive, waitingOnTreasury } from './kamBuckets';
import KamEditForm from './KamEditForm';
import { loadKamRequest } from './kamLoad';
import { isRateWriteDeferred, useDeferWriteReady } from '../../lib/deferWrite';
import DeferWriteBar from '../DeferWriteBar';
import RequestKamLine from '../RequestKamLine';
import WrittenRateNote from '../WrittenRateNote';

type ReplyMode = 'approved' | 'better' | 'declined';

function bookedLine(row: RequestRow): string | null {
  if (row.client_reply !== 'approved' || row.approved_rate == null || !row.rate_written_at) return null;
  return rateBooked(row.client_id, row.approved_rate);
}

export default function KamRequestDetail({ id, seed }: { id: number; seed?: RequestRow }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const { profile } = useAuth();
  const { realRole } = useViewAs();
  const navigate = useNavigate();
  const { search } = useLocation();
  const home = { pathname: '/requests', search };
  const [row, setRow] = useState<RequestRow | null>(seed ?? null);
  const [loaded, setLoaded] = useState(seed != null);
  const [missing, setMissing] = useState(false);
  const [mode, setMode] = useState<ReplyMode | null>(null);
  const [rateText, setRateText] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [secondary, setSecondary] = useState(false);
  const lock = useRef(false);
  const deferGate = useDeferWriteReady();
  const rateRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  const title = row
    ? (row.client_name || row.client_id) + (pairLabel(row) ? ' · ' + pairLabel(row) : '')
    : null;
  useScreenTitle(title);

  async function reload(keepEdit = false) {
    const next = await loadKamRequest(id);
    if (!next) {
      setMissing(true);
      setLoaded(true);
      return;
    }
    setRow(next);
    setMissing(false);
    setLoaded(true);
    setEditing(keepEdit);
    setMode(null);
  }

  useEffect(() => {
    if (seed) return;
    let gone = false;
    loadKamRequest(id).then((next) => {
      if (gone) return;
      setRow(next);
      setMissing(!next);
      setLoaded(true);
    }).catch(() => {
      if (gone) return;
      setLoaded(true);
    });
    return () => { gone = true; };
  }, [id, seed]);

  useEffect(() => {
    if (mode === 'better') rateRef.current?.focus();
    if (mode === 'declined') reasonRef.current?.focus();
  }, [mode]);

  function choose(next: ReplyMode) {
    if (!row) return;
    setTried(false);
    setReason('');
    if (mode === next) {
      setMode(null);
      setRateText('');
      return;
    }
    setMode(next);
    setRateText(next === 'approved' && row.rate != null ? fmtRate(row.rate) : '');
  }

  async function sendReply(defer = false) {
    if (!row || !mode || lock.current) return;
    setTried(true);
    const parsed = readRate(rateText);
    const why = reason.trim();
    if (mode === 'declined') {
      if (why.length < 2) return;
    } else if (!parsed.ok || parsed.value == null) {
      return;
    }
    lock.current = true;
    setBusy(true);
    try {
      if (defer && mode === 'approved') {
        await rpc('kam_defer_rate_write', { p_request_id: row.id, p_rate: parsed.value });
      } else {
        await rpc('kam_client_reply', {
          p_request_id: row.id,
          p_reply: mode,
          p_rate: mode === 'declined' ? null : parsed.value,
          p_reason: mode === 'declined' ? why : null,
        });
      }
      toast(defer
        ? t('კლიენტის დადასტურება შეინახა. ხაზინის რიგში ჯერ არ არის.', 'The client approval is saved. It is not on the treasury queue yet.')
        : mode === 'approved'
        ? t('გაეგზავნა ხაზინას და მენეჯერებს.', 'Sent to treasury and managers.')
        : mode === 'better'
          ? t('გაეგზავნა ხაზინას.', 'Sent to treasury.')
          : t('მიზეზი შენახულია.', 'Reason saved.'));
      setMode(null);
      setRateText('');
      setReason('');
      setTried(false);
      await reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    lock.current = false;
    setBusy(false);
  }

  async function askAgain() {
    if (!row || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await rpc('ask_again', { p_request_id: row.id, p_note: null });
      toast(t('ხელახლა გაეგზავნა ხაზინას.', 'Sent to treasury again.'));
      await reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    lock.current = false;
    setBusy(false);
  }

  if (!loaded) return <LoadingLine />;
  if (missing || !row) {
    return (
      <div className="m-detail">
        <p className="m-quiet">{t('მოთხოვნა ვერ მოიძებნა.', 'Request not found.')}</p>
        <Link to={home} className="btn">{t('საქმეზე დაბრუნება', 'Back to home')}</Link>
      </div>
    );
  }

  const status = mobileStatus(row, t);
  const action = needsKamAction(row);
  const waiting = waitingOnTreasury(row);
  const again = canAskAgain(row);
  const own = canDeleteRequest(realRole, profile?.id, row.kam_id);
  const showOutcomes = canMarkRequestOutcome(realRole, profile?.id, row.kam_id);
  const showDelete = own && !isWrittenHistory(row);
  const parsed = readRate(rateText);
  const rateOk = parsed.ok && parsed.value != null;
  const reasonOk = reason.trim().length >= 2;
  const banks = formatBanks(row.bank);
  const chatText = row.client_reply === 'approved' && row.approved_rate != null ? chatHandoff(row.client_id, row.approved_rate) : null;
  const transferText = bookedLine(row);
  const live = quoteLive(row);
  const offerText = !chatText && row.rate != null && (live === 'quoted' || live === 'expired')
    ? clientOffer(row.rate)
    : null;
  const lostPending = isPendingLoss(row);
  const pair = pairLabel(row);
  const amountText = [
    row.sells_currency && row.amount != null ? sideAmount(row.sells_currency, row.amount) : '',
    row.gets_currency && row.gets_amount != null ? sideAmount(row.gets_currency, row.gets_amount) : '',
  ].filter(Boolean).join(' · ');
  const reply = action ? (
    <div className="m-actions">
      {mode == null && (
        <>
          <button type="button" className="btn btn-primary" onClick={() => choose('approved')}>{t('დამტკიცება', 'Approve')}</button>
          <button type="button" className="btn" onClick={() => choose('better')}>{t('უკეთესი კურსი', 'Better rate')}</button>
          <button type="button" className="m-text-btn m-danger" onClick={() => choose('declined')}>{t('უარი', 'Decline')}</button>
        </>
      )}
      {mode === 'approved' && (
        <>
          <label className="field" htmlFor="reply-rate">
            <span>{t('დამტკიცებული კურსი', 'Approved rate')}</span>
            <input id="reply-rate" ref={rateRef} className={'input m-amount' + (tried && !rateOk ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={rateText} onChange={(e) => setRateText(e.target.value)} />
          </label>
          {tried && !rateOk && <span className="hint error">{t('ჩაწერეთ კურსი', 'Enter the rate')}</span>}
          {deferGate === 'unknown' && <LoadingLine compact />}
          {deferGate === 'on' && (
            <>
              <p className="tiny muted">{t('გაწერეთ კურსი ხაზინის რიგში აგზავნის. ჯერ არ გაწეროთ კურსი შეთანხმებულ კურსს ინახავს და ღია მოთხოვნაზე ტოვებს. მოგვიანებით გაწერა იმავე კურსს აგზავნის.', 'Write the rate sends it to the treasury queue. Do not write the rate yet keeps the agreed rate on your open requests. A later write sends that same rate.')}</p>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void sendReply(false); }}>
                {busy ? t('იტვირთება', 'Loading') : t('გაწერეთ კურსი', 'Write the rate')}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => { void sendReply(true); }}>
                {t('ჯერ არ გაწეროთ კურსი', 'Do not write the rate yet')}
              </button>
            </>
          )}
          {deferGate === 'off' && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void sendReply(false); }}>
              {busy ? t('იტვირთება', 'Loading') : t('გაგზავნა', 'Send')}
            </button>
          )}
          <button type="button" className="m-text-btn" onClick={() => choose('approved')}>{t('უკან', 'Back')}</button>
        </>
      )}
      {mode === 'better' && (
        <>
          <label className="field" htmlFor="better-rate">
            <span>{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')}</span>
            <input id="better-rate" ref={rateRef} className={'input m-amount' + (tried && !rateOk ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={rateText} onChange={(e) => setRateText(e.target.value)} />
          </label>
          {tried && !rateOk && <span className="hint error">{t('ჩაწერეთ კურსი', 'Enter the rate')}</span>}
          <button type="button" className="btn" disabled={busy} onClick={() => { void sendReply(); }}>
            {busy ? t('იგზავნება', 'Sending') : t('გაგზავნა', 'Send')}
          </button>
          <button type="button" className="m-text-btn" onClick={() => choose('better')}>{t('უკან', 'Back')}</button>
        </>
      )}
      {mode === 'declined' && (
        <>
          <label className="field" htmlFor="decline-reason">
            <span>{t('მიზეზი', 'Reason')}</span>
            <input id="decline-reason" ref={reasonRef} className={'input' + (tried && !reasonOk ? ' invalid' : '')} autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {tried && !reasonOk && <span className="hint error">{t('ჩაწერეთ მიზეზი', 'Enter a reason')}</span>}
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => { void sendReply(); }}>
            {busy ? t('იგზავნება', 'Sending') : t('შენახვა', 'Save')}
          </button>
          <button type="button" className="m-text-btn" onClick={() => choose('declined')}>{t('უკან', 'Back')}</button>
        </>
      )}
    </div>
  ) : null;

  return (
    <div className="m-detail">
      <Link to={home} className="m-back">{t('უკან', 'Back')}</Link>
      {action ? (
        <section className="m-focal">
          {pair && <p className="m-focal-pair">{pair}</p>}
          {amountText && <p className="m-focal-amount">{amountText}</p>}
          {row.rate != null && <p className="m-rate">{fmtRate(row.rate)}</p>}
          <div className="m-detail-head">
            <h2>{row.client_name || row.client_id}</h2>
            <span className={'pill ' + status.cls}>{status.label}</span>
          </div>
          <p className="tiny muted">ID {row.client_id}</p>
          <RequestKamLine ownerName={row.owner_name} ownerState={row.owner_state} requestKam={row.kam_name} />
          {row.legacy_status?.trim() && <p className="tiny muted">{t('ფაილის სტატუსი', 'File status')}: {row.legacy_status}</p>}
          {reply}
        </section>
      ) : (
        <>
          <div className="m-detail-head">
            <h2>{row.client_name || row.client_id}</h2>
            <span className={'pill ' + status.cls}>{status.label}</span>
          </div>
          <p className="tiny muted">ID {row.client_id}</p>
          <RequestKamLine ownerName={row.owner_name} ownerState={row.owner_state} requestKam={row.kam_name} />
          {row.legacy_status?.trim() && <p className="tiny muted">{t('ფაილის სტატუსი', 'File status')}: {row.legacy_status}</p>}
          {pair && <p className="m-card-pair">{pair}</p>}
          {amountText && <p className="m-card-amount">{amountText}</p>}
          {waiting && <p className="m-card-time is-wait">{ago(row.client_reply === 'better' ? (row.client_replied_at || row.asked_at) : row.asked_at)}</p>}
          {row.rate != null && <p className="m-rate">{fmtRate(row.rate)}</p>}
        </>
      )}
      {banks && <p>{t('ბანკი', 'Bank')}: {banks}</p>}
      {row.client_rate != null && <p className="small">{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')}: {fmtRate(row.client_rate)}</p>}
      {row.note && !isRateWriteDeferred(row) && <p className="note-box">{t('კომენტარი', 'Comment')}: {row.note}</p>}
      <DeferWriteBar row={row} onDone={() => { void reload(); }} />
      {lostPending && (
        <p className="small">
          {t('მიზეზი', 'Reason')}: {lossReasonLabel(row.loss_reason, lang)}
          {row.loss_reason_note ? ' — ' + row.loss_reason_note : ''}
        </p>
      )}
      {row.client_reply === 'better' && row.wanted_rate != null && !row.better_decision && (
        <p className="small">{t('კლიენტს სურს {rate}.', 'The client wants {rate}.', { rate: fmtRate(row.wanted_rate) })}</p>
      )}
      {row.quote_state === 'declined' && row.decline_reason && (
        <p className="small">{t('ხაზინამ უარი თქვა: {reason}', 'Treasury declined: {reason}', { reason: treasuryReason(row.decline_reason, lang) })}</p>
      )}
      {row.client_reply === 'declined' && row.client_decline_reason && (
        <p className="small">{t('კლიენტმა უარი თქვა: {reason}', 'Client declined: {reason}', { reason: row.client_decline_reason })}</p>
      )}

      <ol className="m-timeline">
        <li><span>{t('იკითხა', 'Asked')}</span><time dateTime={row.asked_at}>{fmtDateTime(row.asked_at)}</time></li>
        {row.quoted_at && <li><span>{t('კურსი', 'Rate')}</span><time dateTime={row.quoted_at}>{fmtDateTime(row.quoted_at)}</time></li>}
        {row.client_replied_at && <li><span>{t('პასუხი', 'Reply')}</span><time dateTime={row.client_replied_at}>{fmtDateTime(row.client_replied_at)}</time></li>}
        {row.rate_written_at && <li><span>{t('გაწერილია', 'Written')}</span><time dateTime={row.rate_written_at}>{fmtDateTime(row.rate_written_at)}</time></li>}
      </ol>
      {row.rate_written_at && <WrittenRateNote writtenAt={row.rate_written_at} />}

      {(chatText || transferText) && <CopyLine label={t('კლიენტის ID', 'Client ID')} text={row.client_id} />}
      {chatText && <CopyLine label={t('ტექსტი ჩატისთვის', 'Text for chat')} text={chatText} />}
      {transferText && <CopyLine label={t('ტექსტი ჩარიცხვისთვის', 'Text for the transfer')} text={transferText} />}
      {offerText && <CopyLine label={t('ტექსტი კლიენტისთვის', 'Text for the client')} text={offerText} />}

      {(own || showOutcomes || showDelete) && (
        <section className="m-secondary">
          <button type="button" className="m-disclosure" aria-expanded={secondary} onClick={() => setSecondary((open) => !open)}>
            {t('სხვა ქმედებები', 'Other actions')}
          </button>
          {secondary && !editing && (
            <div className="m-secondary-body">
              <RequestOutcomeButtons row={row} onDone={() => { void reload(); }} />
              <CorrectStatusButton row={row} onDone={() => { setSecondary(true); void reload(true); }} />
              <LossApproval row={row} onDone={() => { void reload(); }} />
              {own && <button type="button" className="btn" onClick={() => setEditing(true)}>{t('რედაქტირება', 'Edit')}</button>}
              {showDelete && <DeleteRequestButton requestId={row.id} onDeleted={() => navigate(home)} />}
            </div>
          )}
          {secondary && editing && (
            <KamEditForm
              row={row}
              onClose={() => setEditing(false)}
              onSaved={() => { void reload(); }}
              onDeleted={() => navigate(home)}
            />
          )}
        </section>
      )}

      {!action && again && (
        <button type="button" className="btn btn-primary m-send" disabled={busy} onClick={() => { void askAgain(); }}>
          {busy ? t('იგზავნება', 'Sending') : t('ხელახლა კითხვა', 'Ask again')}
        </button>
      )}
    </div>
  );
}
