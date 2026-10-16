import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fmtRate, sideAmount } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import type { QueueRow } from '../../lib/types';
import { formatBanks } from '../../lib/types';
import LoadingLine from '../LoadingLine';
import SpecialRateMark from '../SpecialRateMark';
import { useSpecialRates, type SpecialRateRow } from '../../lib/specialRates';
import { clientName, pairText, WaitClock } from './TreasuryBits';
import type { TreasuryReply } from './treasuryLoad';
import ClosingQueue from '../ClosingQueue';
import { useTreasuryDesk } from './useTreasuryDesk';

function Quiet({ title, id, text }: { title: string; id: string; text: string }) {
  return (
    <section className="m-block is-empty" id={id} aria-labelledby={id + '-title'}>
      <h2 id={id + '-title'} className="m-block-title">{title}</h2>
      <p className="m-quiet">{text}</p>
    </section>
  );
}

function WaitingCard({ row, bank, terms }: { row: QueueRow; bank?: string[]; terms: SpecialRateRow[] }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const open = () => navigate('/rate-desk/quote/' + row.request_id);
  const banks = formatBanks(bank);
  return (
    <article className="m-card is-waiting">
      <button type="button" className="m-card-hit" onClick={open}>
        <div className="m-card-client">{clientName(row.client_name, row.client_id)}</div>
        <div className="m-card-pair">{pairText(row.sells_currency, row.gets_currency)}</div>
        <div className="m-card-dir">{t('კლიენტი ყიდის', 'Client sells')} {sideAmount(row.sells_currency, row.amount)}</div>
        <div className="m-card-dir">{t('კლიენტი იღებს', 'Client gets')} {sideAmount(row.gets_currency, row.gets_amount)}</div>
        {banks && <div className="m-card-dir">{t('ბანკი', 'Bank')}: {banks}</div>}
        <SpecialRateMark clientId={row.client_id} rows={terms} variant="pill" />
        <div className="m-card-dir">KAM: {row.kam_name}</div>
        <WaitClock iso={row.asked_at} />
      </button>
      <button type="button" className="btn btn-primary m-card-action" onClick={open}>
        {t('კურსის გაგზავნა', 'Send rate')}
      </button>
    </article>
  );
}

function BetterCard({ row }: { row: TreasuryReply }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const open = () => navigate('/rate-desk/better/' + row.request_id);
  return (
    <article className="m-card is-action">
      <button type="button" className="m-card-hit" onClick={open}>
        <div className="m-card-client">{clientName(row.client_name, row.client_id)}</div>
        <div className="m-card-pair">{pairText(row.sells_currency, row.gets_currency)}</div>
        <div className="m-card-dir">{t('კლიენტი ყიდის', 'Client sells')} {sideAmount(row.sells_currency, row.amount)}</div>
        <div className="m-card-rate">{t('ხაზინის კურსი', 'Treasury rate')} {fmtRate(row.rate)}</div>
        <div className="m-card-quote">{t('კლიენტს სურს', 'The client wants')} {fmtRate(row.wanted_rate)}</div>
        <div className="m-card-dir">KAM: {row.kam_name}</div>
        <WaitClock iso={row.client_replied_at} />
      </button>
      <button type="button" className="btn btn-primary m-card-action" onClick={open}>
        {t('პასუხი', 'Reply')}
      </button>
    </article>
  );
}

function WriteCard({ row }: { row: TreasuryReply }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const open = () => navigate('/rate-desk/write/' + row.request_id);
  return (
    <article className="m-card">
      <button type="button" className="m-card-hit" onClick={open}>
        <div className="m-card-client">{clientName(row.client_name, row.client_id)}</div>
        <div className="m-card-pair">{pairText(row.sells_currency, row.gets_currency)}</div>
        <div className="m-card-dir">{t('კლიენტი ყიდის', 'Client sells')} {sideAmount(row.sells_currency, row.amount)}</div>
        <div className="m-card-quote">{fmtRate(row.approved_rate)}</div>
        <div className="m-card-dir">KAM: {row.kam_name}</div>
      </button>
      <button type="button" className="btn btn-primary m-card-action" onClick={open}>
        {t('კურსი ჩაიწერა', 'Rate written')}
      </button>
    </article>
  );
}

export default function TreasuryHome() {
  const { t } = useI18n();
  const data = useTreasuryDesk();
  const specialRates = useSpecialRates(
    data.waiting.map((row) => row.client_id),
    data.waiting.map((row) => row.request_id).join(','),
  );

  useEffect(() => {
    if (!data.loaded) return;
    const id = window.location.hash.replace('#', '');
    if (!id) return;
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [data.loaded, data.waiting.length, data.better.length, data.write.length, data.closing?.length]);

  const waitingTitle = t('კურსს ელოდება', 'Waiting for a rate');
  const betterTitle = t('უკეთესი კურსი', 'Better rate');
  const writeTitle = t('დასაწერია', 'To write');
  const lostTitle = t('დაკარგული', 'Lost');

  return (
    <div className="m-home m-treasury">
      {!data.loaded && <LoadingLine />}
      {data.loaded && (
        <>
          {data.queueError && <p className="alert-box" role="alert">{data.queueError}</p>}
          {data.waiting.length > 0 ? (
            <section className="m-block" id="treasury-waiting" aria-labelledby="treasury-waiting-title">
              <h2 id="treasury-waiting-title" className="m-block-title">{waitingTitle}</h2>
              {data.waiting.map((row) => (
                <WaitingCard key={row.request_id} row={row} bank={data.banks[row.request_id]} terms={specialRates.get(row.client_id) ?? []} />
              ))}
            </section>
          ) : !data.queueError ? (
            <Quiet id="treasury-waiting" title={waitingTitle} text={t('კურსს არაფერი ელოდება.', 'Nothing is waiting for a rate.')} />
          ) : null}

          {data.replyError && <p className="alert-box" role="alert">{data.replyError}</p>}
          {data.repliesReady && data.better.length === 0 && !data.replyError ? (
            <Quiet id="treasury-better" title={betterTitle} text={t('უკეთეს კურსს არაფერი ელოდება.', 'No better rate is waiting.')} />
          ) : data.better.length > 0 ? (
            <section className="m-block" id="treasury-better" aria-labelledby="treasury-better-title">
              <h2 id="treasury-better-title" className="m-block-title">{betterTitle}</h2>
              {data.better.map((row) => <BetterCard key={row.request_id} row={row} />)}
            </section>
          ) : !data.repliesReady ? <LoadingLine compact /> : null}

          {data.closing != null && <ClosingQueue rows={data.closing} onDone={() => { void data.reload(); }} />}

          {data.repliesReady && data.write.length === 0 && !data.replyError ? (
            <Quiet id="treasury-write" title={writeTitle} text={t('კურსი გასაწერი არ არის.', 'Nothing is waiting to be written.')} />
          ) : data.write.length > 0 ? (
            <section className="m-block" id="treasury-write" aria-labelledby="treasury-write-title">
              <h2 id="treasury-write-title" className="m-block-title">{writeTitle}</h2>
              {data.write.map((row) => <WriteCard key={row.request_id} row={row} />)}
            </section>
          ) : null}

          <section className={'m-block' + (data.losses === 0 && !data.lossError ? ' is-empty' : '')} id="treasury-lost" aria-labelledby="treasury-lost-title">
            <h2 id="treasury-lost-title" className="m-block-title">{lostTitle}</h2>
            {data.lossError && <p className="alert-box" role="alert">{data.lossError}</p>}
            {data.losses == null && !data.lossError && <LoadingLine compact />}
            {data.losses === 0 && !data.lossError && (
              <p className="m-quiet">{t('დასადასტურებელი დანაკარგი არ არის.', 'No loss is waiting for approval.')}</p>
            )}
            {data.losses != null && data.losses > 0 && (
              <div className="m-card">
                <div className="m-loss-n">{data.losses}</div>
                <p className="m-quiet">{t('დასადასტურებელი', 'To approve')}</p>
              </div>
            )}
            {(data.losses != null || data.lossError) && (
              <Link to="/lost-requests" className={data.losses ? 'btn btn-primary m-card-action' : 'm-more-row'}>
                {t('დაკარგული მოთხოვნები', 'Lost requests')}
              </Link>
            )}
          </section>
        </>
      )}
    </div>
  );
}
