import { fmtDateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';

const MINUTES = 30;

/** Deadline is rate_written_at plus 30 minutes. Display only. */
export function writtenRateUntil(writtenAt: string | null | undefined): string {
  if (!writtenAt) return '';
  const start = new Date(writtenAt).getTime();
  if (!Number.isFinite(start)) return '';
  return new Date(start + MINUTES * 60_000).toISOString();
}

/**
 * The written rate works for 30 minutes from rate_written_at.
 * Passing that time does not cancel, lose, or change the rate.
 */
export default function WrittenRateNote({ writtenAt }: { writtenAt?: string | null }) {
  const { t } = useI18n();
  const until = writtenRateUntil(writtenAt);
  if (!until) {
    return <p className="small">{t('კურსი გაწერიდან 30 წუთი მოქმედებს.', 'The written rate works for 30 minutes from the moment it is written.')}</p>;
  }
  return (
    <p className="small">
      {t(
        'კურსი გაწერიდან 30 წუთი მოქმედებს, {time}-მდე.',
        'The written rate works for 30 minutes from when it was written, until {time}.',
        { time: fmtDateTime(until) },
      )}
    </p>
  );
}
