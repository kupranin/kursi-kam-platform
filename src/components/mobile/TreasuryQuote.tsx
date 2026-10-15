import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { fmtRate, fmtTime, parseRate, rateUnit } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { treasuryReason } from '../../lib/requestStatus';
import { rpc } from '../../lib/supabase';
import { useScreenTitle } from '../../lib/screenTitle';
import { useToast } from '../../lib/toast';
import type { QueueRow } from '../../lib/types';
import LoadingLine from '../LoadingLine';
import StickyBar from './StickyBar';
import { clientName, DealFacts, Fact, pairText, WaitClock } from './TreasuryBits';
import { DECLINE_REASONS, FAR_PCT, loadDefaultValid, loadRequestBanks, loadWaitingQueue } from './treasuryLoad';

export default function TreasuryQuote({ id }: { id: number }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const [row, setRow] = useState<QueueRow | null>(null);
  const [banks, setBanks] = useState<string[] | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [rateText, setRateText] = useState('');
  const [valid, setValid] = useState(15);
  const [tried, setTried] = useState(false);
  const [confirmFar, setConfirmFar] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const rateRef = useRef('');
  const validReady = useRef(false);
  const ticket = useRef(0);
  rateRef.current = rateText;

  const title = row ? clientName(row.client_name, row.client_id) + (pairText(row.sells_currency, row.gets_currency) ? ' · ' + pairText(row.sells_currency, row.gets_currency) : '') : null;
  useScreenTitle(title);

  async function reload() {
    const mine = ++ticket.current;
    try {
      const [queue, minutes, bankMap] = await Promise.all([
        loadWaitingQueue(),
        validReady.current ? Promise.resolve(valid) : loadDefaultValid(),
        loadRequestBanks([id]),
      ]);
      if (mine !== ticket.current) return;
      if (!validReady.current) {
        validReady.current = true;
        setValid(minutes);
      }
      setBanks(bankMap[id]);
      const next = queue.find((item) => item.request_id === id) ?? null;
      if (!next) {
        if (!rateRef.current && !lock.current) setMissing(true);
      } else {
        setRow(next);
        setMissing(false);
      }
      setError('');
      setLoaded(true);
    } catch (err) {
      if (mine !== ticket.current) return;
      setError((err as Error).message);
      setLoaded(true);
    }
  }

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => { void reload(); }, 3000);
    return () => window.clearInterval(timer);
    // The waiting list keeps the desk's 3-second check. Draft text lives in a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useLayoutEffect(() => {
    if (declining || !loaded) return;
    const field = document.getElementById('treasury-rate');
    const scroller = field?.closest('.m-scroll');
    if (!(field instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return;
    const rect = field.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    if (rect.bottom > box.bottom - 8 || rect.top < box.top + 8) field.scrollIntoView({ block: 'nearest' });
  }, [declining, loaded]);

  function back() {
    navigate('/rate-desk#treasury-waiting');
  }

  if (!loaded) return <LoadingLine />;
  if (error && !row) {
    return (
      <div className="m-detail">
        <button type="button" className="m-back" onClick={back}>{t('უკან', 'Back')}</button>
        <p className="alert-box" role="alert">{error}</p>
        <button type="button" className="btn" onClick={() => { setLoaded(false); void reload(); }}>{t('თავიდან ცდა', 'Try again')}</button>
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
  const deal = row;

  const parsed = parseRate(rateText);
  const rateOk = parsed.ok && parsed.value != null;
  const standard = row.standard_rate != null ? Number(row.standard_rate) : null;
  const dev = rateOk && parsed.value != null && standard ? Math.abs(parsed.value - standard) / standard * 100 : 0;
  const refs = [
    standard != null && { label: t('ჩვენი სტანდარტი', 'Our standard'), value: standard },
    row.nbg_rate != null && { label: 'NBG', value: Number(row.nbg_rate) },
    row.last_given_today != null && { label: t('დღეს ბოლოს გაცემული', 'Last given today'), value: Number(row.last_given_today) },
    row.last_rate != null && { label: t('ბოლო ამ კლიენტზე', 'Last for this client'), value: Number(row.last_rate) },
  ].filter((item): item is { label: string; value: number } => Boolean(item) && Number.isFinite((item as { value: number }).value));

  function fill(value: number) {
    const rate = fmtRate(value);
    setRateText(rate);
    setConfirmFar(false);
    setTried(false);
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (lock.current) return;
    setTried(true);
    if (!rateOk || parsed.value == null) return;
    if (standard && dev > FAR_PCT && !confirmFar) {
      setConfirmFar(true);
      return;
    }
    lock.current = true;
    setBusy(true);
    try {
      const until = await rpc<string>('treasury_quote', {
        p_request_id: deal.request_id,
        p_rate: parsed.value,
        p_valid_minutes: valid,
      });
      toast(t(
        'კურსი {rate} გაეგზავნა {name}-ს, მოქმედებს {time}-მდე',
        'Rate {rate} sent to {name}, valid until {time}',
        { rate: fmtRate(parsed.value), name: deal.kam_name.split(' ')[0], time: fmtTime(until) },
      ));
      navigate('/rate-desk#treasury-waiting', { replace: true });
    } catch (err) {
      toast((err as Error).message, 'error');
      lock.current = false;
      setBusy(false);
    }
  }

  async function decline(reason: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await rpc('treasury_decline', { p_request_id: deal.request_id, p_reason: reason });
      toast(t(
        'დაუბრუნდა {name}-ს: {reason}',
        'Sent back to {name}: {reason}',
        { name: deal.kam_name.split(' ')[0], reason: treasuryReason(reason, lang) },
      ));
      navigate('/rate-desk#treasury-waiting', { replace: true });
    } catch (err) {
      toast((err as Error).message, 'error');
      lock.current = false;
      setBusy(false);
    }
  }

  const sendLabel = dev > FAR_PCT && confirmFar
    ? t('მაინც გაგზავნა', 'Send anyway')
    : t('კურსის გაგზავნა', 'Send rate');

  return (
    <form className="m-form m-dock" onSubmit={send} noValidate>
      <div className="m-scroll">
        <button type="button" className="m-back" onClick={back}>{t('უკან', 'Back')}</button>
        <div className="m-focal">
          <h2>{clientName(row.client_name, row.client_id)}</h2>
          <DealFacts
            sells={row.sells_currency}
            gets={row.gets_currency}
            amount={row.amount}
            getsAmount={row.gets_amount}
            bank={banks}
          />
          <Fact label="KAM" value={row.kam_name} />
          <WaitClock iso={row.asked_at} />
        </div>
        {row.client_rate != null && (
          <p className="note-box">{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')}: {fmtRate(row.client_rate)}</p>
        )}
        {row.note && <p className="note-box">{t('კომენტარი ხაზინისთვის', 'Comment for treasury')}: {row.note}</p>}
        {row.loss_reason_note && <p className="note-box">{t('სხვა მიზეზი', 'Other reason')}: {row.loss_reason_note}</p>}
        {refs.length > 0 && !declining && (
          <div className="m-refs" aria-label={t('კურსები ამ გარიგებაზე', 'Rates for this deal')}>
            {refs.map((item) => (
              <button key={item.label} type="button" className="ref-chip" onClick={() => fill(item.value)}>
                <span>{item.label}</span>
                <span>{fmtRate(item.value)}</span>
              </button>
            ))}
          </div>
        )}
        {!declining && (
          <>
            <div className="field">
              <span className="label" id={'valid-' + row.request_id}>{t('მოქმედებს', 'Valid for')}</span>
              <div className="seg dark" role="group" aria-labelledby={'valid-' + row.request_id}>
                {[5, 15, 30].map((minutes) => (
                  <button key={minutes} type="button" aria-pressed={valid === minutes} onClick={() => setValid(minutes)}>
                    {t('{n} წთ', '{n} min', { n: minutes })}
                  </button>
                ))}
              </div>
            </div>
            <div className="field" id="treasury-rate-field">
              <label htmlFor="treasury-rate">{t('კურსი', 'Rate')}</label>
              <input
                id="treasury-rate"
                className={'input m-rate-input' + (tried && !rateOk ? ' invalid' : '')}
                inputMode="decimal"
                enterKeyHint="send"
                autoComplete="off"
                value={rateText}
                onChange={(e) => {
                  setRateText(e.target.value.replace(/,/g, '.'));
                  setConfirmFar(false);
                  setTried(false);
                }}
              />
              <span className={'hint' + (tried && !rateOk ? ' error' : '')}>
                {tried && !rateOk ? t('ჯერ ჩაწერეთ კურსი', 'Enter the rate first') : rateUnit(row.sells_currency, row.gets_currency)}
              </span>
            </div>
            {dev > FAR_PCT && confirmFar && (
              <p className="alert-box" role="alert">{t(
                'შეამოწმეთ კურსი: {rate} სტანდარტულ კურსს {standard} {pct}%-ით შორდება. თუ სწორია, დააჭირეთ „მაინც გაგზავნა“.',
                'Check the rate: {rate} is {pct}% away from the standard rate {standard}. If it is right, press Send anyway.',
                { rate: rateText, standard: fmtRate(standard), pct: dev.toFixed(1) },
              )}</p>
            )}
          </>
        )}
        {declining && (
          <div id="decline-reasons">
            <p className="small strong">{t('უთხარით {name}-ს, რატომ', 'Tell {name} why', { name: row.kam_name.split(' ')[0] })}</p>
            <div className="chips">
              {DECLINE_REASONS.map((reason) => (
                <button key={reason} type="button" className="chip" disabled={busy} onClick={() => { void decline(reason); }}>
                  {treasuryReason(reason, lang)}
                </button>
              ))}
            </div>
            <button type="button" className="m-text-btn" disabled={busy} onClick={() => setDeclining(false)}>{t('უკან', 'Back')}</button>
          </div>
        )}
      </div>
      {!declining && (
        <StickyBar>
          <button type="submit" className="btn btn-primary m-send" disabled={busy}>
            {busy ? t('იგზავნება', 'Sending') : sendLabel}
          </button>
          <button type="button" className="m-text-btn" disabled={busy} onClick={() => setDeclining(true)}>
            {t('კურსს ვერ ვიძლევი', 'I cannot give a rate')}
          </button>
        </StickyBar>
      )}
    </form>
  );
}
