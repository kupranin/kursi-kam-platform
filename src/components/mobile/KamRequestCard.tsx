import { holdWindow, isRateWriteDeferred } from '../../lib/deferWrite';
import { ago, fmtDateTime, sideAmount } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import type { RequestRow } from '../../lib/types';
import { cardTime, mobileStatus, needsKamAction, pairLabel, treasuryRate, waitingOnTreasury } from './kamBuckets';
import RequestKamLine from '../RequestKamLine';
import WrittenRateNote from '../WrittenRateNote';

export default function KamRequestCard({
  row,
  onOpen,
  compact = false,
}: {
  row: RequestRow;
  onOpen: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const status = mobileStatus(row, t);
  const pair = pairLabel(row);
  const rate = treasuryRate(row);
  const time = cardTime(row, t, ago);
  const held = isRateWriteDeferred(row);
  const clock = held ? holdWindow(row.client_replied_at) : null;
  const waiting = waitingOnTreasury(row);
  const action = needsKamAction(row);
  const amounts = [
    row.sells_currency && row.amount != null ? sideAmount(row.sells_currency, row.amount) : '',
    row.gets_currency && row.gets_amount != null ? sideAmount(row.gets_currency, row.gets_amount) : '',
  ].filter(Boolean).join(' · ');

  return (
    <article className={'m-card' + (action ? ' is-action' : '') + (waiting ? ' is-waiting' : '') + (compact ? ' is-compact' : '')}>
      <button type="button" className="m-card-hit" onClick={onOpen}>
        <div className="m-card-client">{row.client_name || row.client_id}</div>
        <RequestKamLine ownerName={row.owner_name} ownerState={row.owner_state} ownerSource={row.owner_source} requestKam={row.kam_name} />
        {pair && <div className="m-card-pair">{pair}</div>}
        {amounts && <div className="m-card-amount">{amounts}</div>}
        {action && rate && <div className="m-card-quote">{rate}</div>}
        <div className={'m-card-time' + (waiting ? ' is-wait' : '')}>{time}</div>
        {!waiting && <span className={'pill ' + status.cls}>{status.label}</span>}
        {clock && (
          <div className="m-card-time">
            {t(
              'დადასტურებიდან გავიდა {elapsed}. ვადაა {deadline}.',
              'Held for {elapsed} since the client accepted. Deadline {deadline}.',
              {
                elapsed: clock.elapsedMinutes < 60
                  ? t('{m} წუთი', '{m} min', { m: clock.elapsedMinutes })
                  : t('{h} სთ {m} წთ', '{h} h {m} min', { h: Math.floor(clock.elapsedMinutes / 60), m: clock.elapsedMinutes % 60 }),
                deadline: fmtDateTime(clock.deadlineIso),
              },
            )}
          </div>
        )}
      </button>
      {row.rate_written_at && <WrittenRateNote writtenAt={row.rate_written_at} />}
      {action && (
        <button type="button" className="btn btn-primary m-card-action" onClick={onOpen}>
          {t('პასუხი', 'Reply')}
        </button>
      )}
    </article>
  );
}
