import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { fmtRate, parseRate } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { rpc } from '../../lib/supabase';
import { useScreenTitle } from '../../lib/screenTitle';
import { useToast } from '../../lib/toast';
import { useLive } from '../../lib/useLive';
import LoadingLine from '../LoadingLine';
import StickyBar from './StickyBar';
import { clientName, DealFacts, Fact, pairText, WaitClock } from './TreasuryBits';
import { loadActionReplies, type TreasuryReply } from './treasuryLoad';

type Step = 'choose' | 'correct' | 'decline';

export default function TreasuryBetter({ id }: { id: number }) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const [row, setRow] = useState<TreasuryReply | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<Step>('choose');
  const [rateText, setRateText] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const draftRef = useRef(false);
  const ticket = useRef(0);
  draftRef.current = rateText.trim() !== '' || reason.trim() !== '' || step !== 'choose';

  const title = row ? clientName(row.client_name, row.client_id) + (pairText(row.sells_currency, row.gets_currency) ? ' · ' + pairText(row.sells_currency, row.gets_currency) : '') : null;
  useScreenTitle(title);

  async function reload() {
    const mine = ++ticket.current;
    try {
      const next = await loadActionReplies();
      if (mine !== ticket.current) return;
      const found = next.better.find((item) => item.request_id === id) ?? null;
      if (!found) {
        if (!draftRef.current && !lock.current) setMissing(true);
      } else {
        setRow(found);
        setMissing(false);
      }
      setError('');
      setLoaded(true);
    } catch {
      if (mine !== ticket.current) return;
      setError(t('სია ჯერ არ იტვირთება.', 'This list is not loading yet.'));
      setLoaded(true);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useLive(['requests'], () => { void reload(); }, 15000);

  useLayoutEffect(() => {
    if (step !== 'correct') return;
    const field = document.getElementById('treasury-correct');
    const scroller = field?.closest('.m-scroll');
    if (!(field instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return;
    const rect = field.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    if (rect.bottom > box.bottom - 8 || rect.top < box.top + 8) field.scrollIntoView({ block: 'nearest' });
  }, [step]);

  function back() {
    navigate('/rate-desk#treasury-better');
  }

  function choose(next: Step) {
    setStep(next);
    setTried(false);
  }

  async function accept() {
    if (!row || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await rpc('treasury_answer_better', {
        p_request_id: row.request_id,
        p_decision: 'accepted',
        p_rate: null,
        p_reason: null,
      });
      toast(t('კურსი დაუბრუნდა KAM-ს.', 'The rate went back to the KAM.'));
      navigate('/rate-desk#treasury-better', { replace: true });
    } catch (err) {
      toast((err as Error).message, 'error');
      lock.current = false;
      setBusy(false);
    }
  }

  async function correct(e?: FormEvent) {
    e?.preventDefault();
    if (!row || lock.current) return;
    const parsed = parseRate(rateText);
    setTried(true);
    if (!parsed.text || parsed.value == null) return;
    lock.current = true;
    setBusy(true);
    try {
      await rpc('treasury_answer_better', {
        p_request_id: row.request_id,
        p_decision: 'corrected',
        p_rate: parsed.value,
        p_reason: null,
      });
      toast(t('გასწორებული კურსი დაუბრუნდა KAM-ს.', 'The corrected rate went back to the KAM.'));
      navigate('/rate-desk#treasury-better', { replace: true });
    } catch (err) {
      toast((err as Error).message, 'error');
      lock.current = false;
      setBusy(false);
    }
  }

  async function decline(e?: FormEvent) {
    e?.preventDefault();
    if (!row || lock.current) return;
    const text = reason.trim();
    setTried(true);
    if (text.length < 2 || text.length > 200) return;
    lock.current = true;
    setBusy(true);
    try {
      await rpc('treasury_answer_better', {
        p_request_id: row.request_id,
        p_decision: 'declined',
        p_rate: null,
        p_reason: text,
      });
      toast(t('უარი შენახულია. KAM დაინახავს მიზეზს.', 'Decline saved. The KAM will see the reason.'));
      navigate('/rate-desk#treasury-better', { replace: true });
    } catch (err) {
      toast((err as Error).message, 'error');
      lock.current = false;
      setBusy(false);
    }
  }

  if (!loaded) return <LoadingLine />;
  if (error && !row) {
    return (
      <div className="m-detail">
        <button type="button" className="m-back" onClick={back}>{t('უკან', 'Back')}</button>
        <p className="alert-box" role="alert">{error}</p>
      </div>
    );
  }
  if (missing || !row) {
    return (
      <div className="m-detail">
        <button type="button" className="m-back" onClick={back}>{t('უკან', 'Back')}</button>
        <p className="m-quiet">{t('ეს მოთხოვნა აღარ ელოდება.', 'This request is no longer waiting.')}</p>
      </div>
    );
  }

  const parsed = parseRate(rateText);
  const rateOk = parsed.ok && parsed.value != null;
  const reasonOk = reason.trim().length >= 2 && reason.trim().length <= 200;
  const facts = (
    <div className="m-focal">
      <h2>{clientName(row.client_name, row.client_id)}</h2>
      <DealFacts sells={row.sells_currency} gets={row.gets_currency} amount={row.amount} getsAmount={row.gets_amount} />
      <Fact label="KAM" value={row.kam_name} />
      <p className="m-fact">
        <span className="m-fact-label">{t('ხაზინის კურსი', 'Treasury rate')}</span>
        <span className="m-fact-value">{fmtRate(row.rate)}</span>
      </p>
      <p className="m-fact">
        <span className="m-fact-label">{t('კლიენტს სურს', 'The client wants')}</span>
        <span className="m-rate">{fmtRate(row.wanted_rate)}</span>
      </p>
      <WaitClock iso={row.client_replied_at} />
      {row.note && <p className="note-box">{t('კომენტარი', 'Comment')}: {row.note}</p>}
    </div>
  );

  if (step === 'correct') {
    return (
      <form className="m-form m-dock" onSubmit={correct} noValidate>
        <div className="m-scroll">
          <button type="button" className="m-back" onClick={() => choose('choose')}>{t('უკან', 'Back')}</button>
          {facts}
          <div className="field" id="treasury-correct-field">
            <label htmlFor="treasury-correct">{t('გასწორებული კურსი', 'Corrected rate')}</label>
            <input
              id="treasury-correct"
              className={'input m-rate-input' + (tried && !rateOk ? ' invalid' : '')}
              inputMode="decimal"
              enterKeyHint="send"
              autoComplete="off"
              value={rateText}
              onChange={(e) => { setRateText(e.target.value.replace(/,/g, '.')); setTried(false); }}
            />
            <span className={'hint' + (tried && !rateOk ? ' error' : '')}>
              {tried && !rateOk
                ? t('ჩაწერეთ გასწორებული კურსი', 'Enter the corrected rate')
                : t('ეს კურსი ბრუნდება KAM-თან.', 'This rate goes back to the KAM.')}
            </span>
          </div>
        </div>
        <StickyBar>
          <button type="submit" className="btn btn-primary m-send" disabled={busy}>
            {busy ? t('იგზავნება', 'Sending') : t('გაგზავნა', 'Send')}
          </button>
        </StickyBar>
      </form>
    );
  }

  if (step === 'decline') {
    return (
      <form className="m-form m-dock" onSubmit={decline} noValidate>
        <div className="m-scroll">
          <button type="button" className="m-back" onClick={() => choose('choose')}>{t('უკან', 'Back')}</button>
          {facts}
          <div className="field">
            <label htmlFor="treasury-better-no">{t('მიზეზი', 'Reason')}</label>
            <input
              id="treasury-better-no"
              className={'input' + (tried && !reasonOk ? ' invalid' : '')}
              autoComplete="off"
              maxLength={200}
              value={reason}
              onChange={(e) => { setReason(e.target.value); setTried(false); }}
            />
            <span className={'hint' + (tried && !reasonOk ? ' error' : '')}>
              {tried && !reasonOk
                ? t('ჩაწერეთ მიზეზი', 'Enter a reason')
                : t('KAM დაინახავს მიზეზს. ეს აჩერებს მოთხოვნას.', 'The KAM will see the reason. This stops the request.')}
            </span>
          </div>
        </div>
        <StickyBar>
          <button type="submit" className="btn btn-primary m-send" disabled={busy}>
            {busy ? t('ინახება', 'Saving') : t('შენახვა', 'Save')}
          </button>
        </StickyBar>
      </form>
    );
  }

  return (
    <div className="m-detail">
      <button type="button" className="m-back" onClick={back}>{t('უკან', 'Back')}</button>
      {facts}
      <div className="m-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void accept(); }}>
          {busy ? t('ინახება', 'Saving') : t('მოთხოვნილი კურსის მიღება', 'Accept the requested rate')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => choose('correct')}>
          {t('სხვა კურსის შეთავაზება', 'Offer a corrected rate')}
        </button>
        <button type="button" className="m-text-btn" disabled={busy} onClick={() => choose('decline')}>
          {t('უარი', 'Decline')}
        </button>
      </div>
    </div>
  );
}
