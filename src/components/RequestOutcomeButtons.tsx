import { useEffect, useState } from 'react';
import { rpc, supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { useToast } from '../lib/toast';
import { kamMayEditRequest } from '../lib/clientOwnership';
import { isRateWriteDeferred } from '../lib/deferWrite';
import { isHistoricalRequest } from '../lib/displayClass';
import { isOpenRequest } from '../lib/requestStatus';
import type { LossReason, RequestRow, Role } from '../lib/types';

/** Real database role. View-as does not count. A KAM only for their own request. */
export function canMarkRequestOutcome(realRole: Role, profileId: string | undefined, kamId: string | null | undefined): boolean {
  return kamMayEditRequest(realRole, profileId, kamId);
}

const FALLBACK_REASONS: LossReason[] = [
  { code: 'better_rate', label_en: 'Better rate elsewhere', label_ka: 'სხვაგან უკეთესი კურსი', sort_order: 10, active: true },
  { code: 'postponed', label_en: 'Postponed', label_ka: 'გადადო', sort_order: 20, active: true },
  { code: 'funds_not_received', label_en: 'Funds not received', label_ka: 'თანხა არ ჩაურიცხავს', sort_order: 30, active: true },
  { code: 'liquidity', label_en: 'Liquidity problem', label_ka: 'ლიკვიდობის პრობლემა', sort_order: 40, active: true },
  { code: 'other', label_en: 'Other', label_ka: 'სხვა', sort_order: 90, active: true },
];

function isOther(reason: LossReason | undefined): boolean {
  if (!reason) return false;
  return reason.code === 'other' || reason.label_en.trim().toLowerCase() === 'other';
}

/**
 * Lost or success on a still-open row. Lost needs a reason before treasury sees it.
 * A held approval, and the tell-the-client step, cannot be marked as paid yet.
 * clientLost is only that tell-the-client label. The held card keeps Lost.
 */
export default function RequestOutcomeButtons({
  row,
  onDone,
  showSuccess = true,
  clientLost = false,
}: {
  row: RequestRow;
  onDone: () => void;
  showSuccess?: boolean;
  clientLost?: boolean;
}) {
  const { profile } = useAuth();
  const { realRole } = useViewAs();
  const { t, lang } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<'success' | 'lost' | null>(null);
  const [picking, setPicking] = useState(false);
  const [reasons, setReasons] = useState<LossReason[]>(FALLBACK_REASONS);
  const [reason, setReason] = useState<string | null>(null);
  const [otherText, setOtherText] = useState('');

  useEffect(() => {
    if (!picking) return;
    let gone = false;
    supabase.from('loss_reasons').select('*').eq('active', true).order('sort_order')
      .then(({ data }) => {
        if (gone || !data?.length) return;
        setReasons(data as LossReason[]);
      });
    return () => { gone = true; };
  }, [picking]);

  const mayMark = !isHistoricalRequest(row) && canMarkRequestOutcome(realRole, profile?.id, row.kam_id);
  const canLose = mayMark && isOpenRequest(row);
  const canNotify = mayMark && showSuccess && !isRateWriteDeferred(row) && !!row.rate_written_at && !row.payment_confirmed_at;
  if (!canLose && !canNotify) return null;

  const allowSuccess = canNotify;
  const chosen = reasons.find((r) => r.code === reason);
  const reasonText = (r: LossReason) => (lang === 'en' ? r.label_en : r.label_ka).trim() || r.label_en || r.label_ka;

  async function markSuccess() {
    if (!window.confirm(t(
      'კლიენტს ეცნობა? მოთხოვნა წარმატებულად ჩაითვლება.',
      'Mark that the client was notified? The request counts as successful.',
    ))) return;
    setBusy('success');
    try {
      await rpc('confirm_request_payment', { p_request_id: row.id });
      toast(t('კლიენტს ეცნობა.', 'Client was notified.'));
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(null);
  }

  async function markLost() {
    if (!reason) {
      toast(t('აირჩიეთ მიზეზი.', 'Choose a reason.'), 'error');
      return;
    }
    const detail = isOther(chosen) ? otherText.trim() : '';
    if (isOther(chosen) && !detail) {
      toast(t('სხვა მიზეზს კომენტარი სჭირდება.', 'Other needs a comment.'), 'error');
      return;
    }
    if (!window.confirm(t(
      'მოვნიშნოთ დაკარგულად? მიზეზით ხაზინას გაეგზავნება დასადასტურებლად.',
      'Mark this as lost? It goes to treasury for approval with this reason.',
    ))) return;
    setBusy('lost');
    try {
      await rpc('mark_request_lost', {
        p_request_id: row.id,
        p_reason: reason,
        ...(detail ? { p_detail: detail } : {}),
      });
      toast(t('დაკარგულად მოინიშნა. ხაზინის დადასტურებას ელოდება.', 'Marked as lost. It is waiting for treasury to approve it.'));
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(null);
  }

  return (
    <div className="stack-sm" style={{ alignItems: 'flex-start' }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {allowSuccess && (
          <button type="button" className="btn btn-primary" disabled={busy != null} onClick={markSuccess}>
            {busy === 'success' ? t('ინახება…', 'Saving…') : t('კლიენტს შეატყობინეს', 'Client was notified')}
          </button>
        )}
        {canLose && (
          <button type="button" className={clientLost ? 'btn' : 'btn btn-quiet'} disabled={busy != null} onClick={() => setPicking((v) => !v)}>
            {clientLost ? t('კლიენტი დაკარგულია', 'Client lost') : t('დაიკარგა', 'Lost')}
          </button>
        )}
      </div>
        {canLose && picking && (
        <div className="stack-sm" style={{ width: '100%' }}>
          <div className="tiny muted">{t('მიზეზი სავალდებულოა, სანამ ხაზინას გაეგზავნება.', 'A reason is required before this goes to treasury.')}</div>
          <div className="chips">
            {reasons.map((r) => (
              <button
                key={r.code}
                type="button"
                className="chip"
                aria-pressed={reason === r.code}
                onClick={() => setReason(r.code)}
              >
                {reasonText(r)}
              </button>
            ))}
          </div>
          {isOther(chosen) && (
            <label className="field" style={{ margin: 0 }}>
              <span className="tiny">{t('კომენტარი', 'Comment')}</span>
              <input
                className="input"
                value={otherText}
                maxLength={500}
                placeholder={t('ჩაწერეთ მიზეზი', 'Write the reason')}
                onChange={(e) => setOtherText(e.target.value)}
              />
            </label>
          )}
          <button type="button" className="btn btn-primary" disabled={busy != null || !reason} onClick={markLost}>
            {busy === 'lost' ? t('ინახება…', 'Saving…') : t('ხაზინისთვის გაგზავნა', 'Send to treasury')}
          </button>
        </div>
      )}
    </div>
  );
}
