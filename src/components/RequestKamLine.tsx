import { useI18n } from '../lib/i18n';

/** Client owner is clients.assigned_kam_id. Request KAM is requests.kam_id. */
export default function RequestKamLine({
  ownerName,
  ownerState,
  requestKam,
}: {
  ownerName?: string | null;
  ownerState?: 'named' | 'none' | 'deleted';
  requestKam?: string | null;
}) {
  const { t } = useI18n();
  const owner = ownerState === 'deleted'
    ? t('წაშლილი პროფილი', 'Deleted profile')
    : ownerState === 'none'
      ? t('არ არის მინიჭებული', 'Not assigned')
      : (ownerName ?? '');
  return (
    <>
      {ownerState && (
        <div className="tiny muted">{t('კლიენტის მფლობელი', 'Client owner')}: {owner || t('სახელი არ არის', 'No name')}</div>
      )}
      <div className="tiny muted">{t('მოთხოვნის KAM', 'Request KAM')}: {requestKam?.trim() || t('KAM არ არის', 'No KAM')}</div>
    </>
  );
}
