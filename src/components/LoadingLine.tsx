import { useI18n } from '../lib/i18n';

/** The same word on every screen while data is still coming in. */
export default function LoadingLine({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const text = t('იტვირთება', 'Loading');
  if (compact) return <p className="tiny muted" style={{ margin: '6px 0 0' }}>{text}</p>;
  return <p className="empty">{text}</p>;
}
