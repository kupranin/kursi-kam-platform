import { useState } from 'react';
import { rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { useToast } from '../lib/toast';
import { kamMayEditRequest } from '../lib/clientOwnership';
import { isRateWriteDeferred } from '../lib/deferWrite';
import { isHistoricalRequest } from '../lib/displayClass';
import { isOpenRequest, writtenAwaitingNotice } from '../lib/requestStatus';
import { LOSS_PICKER, lossDetailMessage, lossMarkDetail, type BetterRatePlaceId } from '../lib/lossReasons';
import type { RequestRow, Role } from '../lib/types';
import LossReasonPicker from './LossReasonPicker';

/** Real database role. View-as does not count. A KAM only for their own request. */
export function canMarkRequestOutcome(realRole: Role, profileId: string | undefined, kamId: string | null | undefined): boolean {
  return kamMayEditRequest(realRole, profileId, kamId);
}

/**
 * Lost or success on a still-open row. Lost needs a reason before treasury sees it.
 * A better rate elsewhere also needs the place. A held approval, and the
 * tell-the-client step, cannot be marked as paid yet.
 * clientLost is only that tell-the-client label. The held card keeps Lost.
 */
export default function RequestOutcomeButtons({
  row,
  onDone,
  showSuccess = true,
  showLost = true,
  clientLost = false,
}: {
  row: RequestRow;
  onDone: () => void;
  showSuccess?: boolean;
  /** False when this card already shows Lost next to Client was notified. */
  showLost?: boolean;
  clientLost?: boolean;
}) {
  const { profile } = useAuth();
  const { realRole } = useViewAs();
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<'success' | 'lost' | null>(null);
  const [picking, setPicking] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [place, setPlace] = useState<BetterRatePlaceId | null>(null);
  const [otherText, setOtherText] = useState('');

  const mayMark = !isHistoricalRequest(row) && canMarkRequestOutcome(realRole, profile?.id, row.kam_id);
  const explicitLoss = !!(row.marked_lost_at || (row.loss_reason && row.loss_reason.trim()) || row.loss_approved_at);
  const canLoseWritten = writtenAwaitingNotice(row) && !explicitLoss && !row.went_through && row.outcome !== 'went_through';
  const canLose = showLost && mayMark && (isOpenRequest(row) || canLoseWritten);
  const canNotify = mayMark && showSuccess && !isRateWriteDeferred(row) && !!row.rate_written_at && !row.payment_confirmed_at;
  if (!canLose && !canNotify) return null;

  const allowSuccess = canNotify;
  const chosen = LOSS_PICKER.find((item) => item.code === reason);
  const mark = lossMarkDetail(chosen, place, otherText);

  function closePicker() {
    setPicking(false);
    setReason(null);
    setPlace(null);
    setOtherText('');
  }

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
    if (mark.error) {
      const [ka, en] = lossDetailMessage(mark.error);
      toast(t(ka, en), 'error');
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
        ...(mark.detail ? { p_detail: mark.detail } : {}),
      });
      toast(t('დაკარგულად მოინიშნა. ხაზინის დადასტურებას ელოდება.', 'Marked as lost. It is waiting for treasury to approve it.'));
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(null);
  }

  return (
    <div className={picking ? 'loss-open' : 'stack-sm'} style={picking ? undefined : { alignItems: 'flex-start' }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {allowSuccess && (
          <button type="button" className="btn btn-primary" disabled={busy != null} onClick={markSuccess}>
            {busy === 'success' ? t('ინახება…', 'Saving…') : t('კლიენტს შეატყობინეს', 'Client was notified')}
          </button>
        )}
        {canLose && (
          <button type="button" className={clientLost ? 'btn' : 'btn btn-quiet'} disabled={busy != null} onClick={() => { if (picking) closePicker(); else setPicking(true); }}>
            {clientLost ? t('კლიენტი დაკარგულია', 'Client lost') : t('დაიკარგა', 'Lost')}
          </button>
        )}
      </div>
      {canLose && picking && (
        <div className="loss-picker-slot stack-sm">
          <LossReasonPicker
            reason={reason}
            place={place}
            comment={otherText}
            onReason={(code) => { setReason(code); setPlace(null); setOtherText(''); }}
            onPlace={setPlace}
            onComment={setOtherText}
          />
          <button type="button" className="btn btn-primary" disabled={busy != null || mark.error != null} onClick={markLost}>
            {busy === 'lost' ? t('ინახება…', 'Saving…') : t('ხაზინისთვის გაგზავნა', 'Send to treasury')}
          </button>
        </div>
      )}
    </div>
  );
}
