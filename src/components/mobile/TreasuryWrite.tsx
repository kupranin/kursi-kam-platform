import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fmtRate } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { rpc } from '../../lib/supabase';
import { useScreenTitle } from '../../lib/screenTitle';
import { useToast } from '../../lib/toast';
import { useLive } from '../../lib/useLive';
import LoadingLine from '../LoadingLine';
import WrittenRateNote from '../WrittenRateNote';
import SpecialRateMark from '../SpecialRateMark';
import DynamicActiveNegotiatedRates from '../DynamicActiveNegotiatedRates';
import StickyBar from './StickyBar';
import { clientName, DealFacts, Fact, pairText } from './TreasuryBits';
import { loadActionReplies, type TreasuryReply } from './treasuryLoad';

export default function TreasuryWrite({ id }: { id: number }) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const [row, setRow] = useState<TreasuryReply | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const ticket = useRef(0);

  const title = row ? clientName(row.client_name, row.client_id) + (pairText(row.sells_currency, row.gets_currency) ? ' · ' + pairText(row.sells_currency, row.gets_currency) : '') : null;
  useScreenTitle(title);

  async function reload() {
    const mine = ++ticket.current;
    try {
      const next = await loadActionReplies();
      if (mine !== ticket.current) return;
      const found = next.write.find((item) => item.request_id === id) ?? null;
      if (!found) {
        if (!lock.current) setMissing(true);
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

  function back() {
    navigate('/rate-desk#treasury-write');
  }

  async function markWritten() {
    if (!row || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await rpc('treasury_mark_rate_written', { p_request_id: row.request_id });
      toast(t(
        'KAM-ს ეცნობა, რომ კურსი გაწერილია. კურსი გაწერიდან 30 წუთი მოქმედებს.',
        'The KAM is notified that the rate is written. The written rate works for 30 minutes from that moment.',
      ));
      navigate('/rate-desk#treasury-write', { replace: true });
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
        <p className="m-quiet">{t('ეს კურსი აღარ არის გასაწერი.', 'This rate is no longer waiting to be written.')}</p>
      </div>
    );
  }

  return (
    <div className="m-detail m-form m-dock">
      <div className="m-scroll">
        <button type="button" className="m-back" onClick={back}>{t('უკან', 'Back')}</button>
        <div className="m-focal">
          <h2>{clientName(row.client_name, row.client_id)}</h2>
          <DealFacts sells={row.sells_currency} gets={row.gets_currency} amount={row.amount} getsAmount={row.gets_amount} />
          <Fact label="KAM" value={row.kam_name} />
          <p className="m-fact">
            <span className="m-fact-label">{t('დამტკიცებული კურსი', 'Accepted rate')}</span>
            <span className="m-rate">{fmtRate(row.approved_rate)}</span>
          </p>
        </div>
        <SpecialRateMark clientId={row.client_id} variant="detail" />
        <DynamicActiveNegotiatedRates clientId={row.client_id} idSuffix={'phone-write-' + row.request_id} />
        <WrittenRateNote />
        <p className="note-box">{t(
          'კლიენტმა ეს კურსი დაამტკიცა. „კურსი ჩაიწერა“ ნიშნავს, რომ კურსი ძირითად სისტემაში ჩაიწერა. გადახდა ამით არ დასტურდება და გარიგება წარმატებულად არ ითვლება.',
          'The client approved this rate. “Rate written” means the rate was entered in the core system. It does not confirm the payment, and it does not mark the deal successful.',
        )}</p>
      </div>
      <StickyBar>
        <button type="button" className="btn btn-primary m-send" disabled={busy} onClick={() => { void markWritten(); }}>
          {busy ? t('ინახება', 'Saving') : t('კურსი ჩაიწერა', 'Rate written')}
        </button>
      </StickyBar>
    </div>
  );
}
