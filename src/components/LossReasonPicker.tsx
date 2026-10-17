import { useI18n } from '../lib/i18n';
import {
  BETTER_RATE_PLACES,
  LOSS_PICKER,
  isBetterRate,
  reasonNeedsComment,
  reasonText,
  type BetterRatePlaceId,
} from '../lib/lossReasons';

/** The eight loss choices, then the better-rate place. Send stays with the caller. */
export default function LossReasonPicker({
  reason,
  place,
  comment,
  onReason,
  onPlace,
  onComment,
  hint,
}: {
  reason: string | null;
  place: BetterRatePlaceId | null;
  comment: string;
  onReason: (code: string) => void;
  onPlace: (id: BetterRatePlaceId) => void;
  onComment: (value: string) => void;
  hint?: string;
}) {
  const { t, lang } = useI18n();
  const chosen = LOSS_PICKER.find((item) => item.code === reason);
  const placeOther = isBetterRate(chosen) && place === 'other';
  const showComment = placeOther || reasonNeedsComment(chosen);

  return (
    <div className="loss-picker stack-sm">
      <div className="tiny muted">
        {hint ?? t('მიზეზი სავალდებულოა, სანამ ხაზინას გაეგზავნება.', 'A reason is required before this goes to treasury.')}
      </div>
      <div className="chips" role="group" aria-label={t('მიზეზი', 'Reason')}>
        {LOSS_PICKER.map((item) => (
          <button
            key={item.code}
            type="button"
            className="chip"
            aria-pressed={reason === item.code}
            onClick={() => onReason(item.code)}
          >
            {reasonText(item, lang)}
          </button>
        ))}
      </div>
      {isBetterRate(chosen) && (
        <>
          <div className="tiny muted">
            {t(
              'სად მიიღო უკეთესი კურსი? ეს აუცილებელია, სანამ ხაზინას გაეგზავნება.',
              'Where was the better rate? This is required before it goes to treasury.',
            )}
          </div>
          <div className="chips" role="group" aria-label={t('სად მიიღო უკეთესი კურსი', 'Where the better rate was')}>
            {BETTER_RATE_PLACES.map((item) => (
              <button
                key={item.id}
                type="button"
                className="chip"
                aria-pressed={place === item.id}
                onClick={() => onPlace(item.id)}
              >
                {lang === 'en' ? item.en : item.ka}
              </button>
            ))}
          </div>
        </>
      )}
      {showComment && (
        <label className="field" style={{ margin: 0 }}>
          <span className="tiny">{t('კომენტარი', 'Comment')}</span>
          <input
            className="input"
            value={comment}
            maxLength={500}
            placeholder={placeOther
              ? t('ჩაწერეთ სად', 'Write where')
              : t('ჩაწერეთ მიზეზი', 'Write the reason')}
            onChange={(e) => onComment(e.target.value)}
          />
        </label>
      )}
    </div>
  );
}
