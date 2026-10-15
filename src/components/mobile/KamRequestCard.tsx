import { ago, sideAmount } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import type { RequestRow } from '../../lib/types';
import { cardTime, mobileStatus, needsKamAction, pairLabel, treasuryRate, waitingOnTreasury } from './kamBuckets';

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
        {pair && <div className="m-card-pair">{pair}</div>}
        {amounts && <div className="m-card-amount">{amounts}</div>}
        {action && rate && <div className="m-card-quote">{rate}</div>}
        <div className={'m-card-time' + (waiting ? ' is-wait' : '')}>{time}</div>
        {!waiting && <span className={'pill ' + status.cls}>{status.label}</span>}
      </button>
      {action && (
        <button type="button" className="btn btn-primary m-card-action" onClick={onOpen}>
          {t('პასუხი', 'Reply')}
        </button>
      )}
    </article>
  );
}
