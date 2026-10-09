import { useI18n } from '../lib/i18n';

/** Who gave the rate, and who wrote it in the core. Blank until a name is stored. */
export default function RatePeople({ quoted, written }: { quoted?: string | null; written?: string | null }) {
  const { t } = useI18n();
  if (!quoted && !written) return null;
  return (
    <div className="rate-people">
      {quoted ? <div>{t('კურსი გასცა {name}', 'Rate given by {name}', { name: quoted })}</div> : null}
      {written ? <div>{t('კურსი გაწერა {name}', 'Rate written by {name}', { name: written })}</div> : null}
    </div>
  );
}
