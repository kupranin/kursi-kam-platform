import { fmtDateTime, fmtRate } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useSpecialRates, type SpecialRateRow } from '../lib/specialRates';

function bankName(row: SpecialRateRow, other: string): string {
  if (row.bank === 'Other') return row.provider_label?.trim() || other;
  return row.bank;
}

/** Compact client-reported terms. Nothing when the client has none, or setup 42 is absent. */
export default function SpecialRateMark({
  clientId,
  rows,
  variant,
}: {
  clientId: string;
  rows?: SpecialRateRow[];
  variant: 'pill' | 'detail';
}) {
  const { t } = useI18n();
  const loaded = useSpecialRates(rows ? [] : [clientId]);
  const list = rows ?? loaded.get(clientId) ?? [];
  if (!list.length) return null;

  const other = t('სხვა', 'Other');
  if (variant === 'pill') {
    return (
      <span className="pill pill-gold">{t('სპეც. კურსი', 'Special rate')} · {list.map((row) => bankName(row, other)).join(', ')}</span>
    );
  }

  return (
    <div className="special-rate">
      <div className="small strong">{t('სპეც. კურსი', 'Special rate')}</div>
      <p className="tiny muted" style={{ margin: '2px 0 0' }}>{t('კლიენტის თქმით', 'As reported by the client')}</p>
      {list.map((row) => {
        const pair = row.sells_currency && row.gets_currency ? row.sells_currency + '/' + row.gets_currency : '';
        const when = row.updated_at ? fmtDateTime(row.updated_at) : '';
        return (
          <p key={row.bank} className="small" style={{ margin: '6px 0 0' }}>
            <span className="strong">{bankName(row, other)}</span>
            {pair ? ` · ${pair}` : ''}
            {row.rate != null ? ` · ${fmtRate(row.rate)}` : ''}
            {row.comment ? ` · ${row.comment}` : ''}
            {when ? ` · ${when}` : ''}
            {row.updated_by_name ? ` · ${row.updated_by_name}` : ''}
          </p>
        );
      })}
    </div>
  );
}
