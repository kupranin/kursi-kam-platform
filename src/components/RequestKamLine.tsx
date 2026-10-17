import { ownerDisplayText, ownerSourceCaption, type OwnerSource } from '../lib/clientOwnership';
import { useI18n } from '../lib/i18n';

/** Client owner is the all-time owner. Request KAM is requests.kam_id. */
export default function RequestKamLine({
  ownerName,
  ownerState,
  ownerSource,
  requestKam,
}: {
  ownerName?: string | null;
  ownerState?: 'named' | 'none' | 'deleted' | 'unresolved';
  ownerSource?: OwnerSource | null;
  requestKam?: string | null;
}) {
  const { t, lang } = useI18n();
  const owner = ownerState ? ownerDisplayText(ownerState, ownerName, lang) : '';
  const caption = ownerSource ? ownerSourceCaption(ownerSource, lang) : '';
  return (
    <>
      {ownerState && (
        <div className="tiny muted" title={caption || undefined}>{t('კლიენტის მფლობელი', 'Client owner')}: {owner}</div>
      )}
      <div className="tiny muted">{t('მოთხოვნის KAM', 'Request KAM')}: {requestKam?.trim() || t('KAM არ არის', 'No KAM')}</div>
    </>
  );
}
