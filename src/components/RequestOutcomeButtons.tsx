import { useState } from 'react';
import { rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { useToast } from '../lib/toast';
import { isOpenRequest } from '../lib/requestStatus';
import type { RequestRow, Role } from '../lib/types';

/** Real database role. View-as does not count. A KAM only for their own request. */
export function canMarkRequestOutcome(realRole: Role, profileId: string | undefined, kamId: string | null | undefined): boolean {
  if (realRole === 'admin') return true;
  return realRole === 'kam' && !!profileId && !!kamId && kamId === profileId;
}

/** Lost or success on a still-open row. One confirm, then the existing outcome. */
export default function RequestOutcomeButtons({ row, onDone }: { row: RequestRow; onDone: () => void }) {
  const { profile } = useAuth();
  const { realRole } = useViewAs();
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<'success' | 'lost' | null>(null);

  if (!canMarkRequestOutcome(realRole, profile?.id, row.kam_id) || !isOpenRequest(row)) return null;

  async function markSuccess() {
    if (!window.confirm(t(
      'ტრანზაქცია გავიდა? მოთხოვნა წარმატებულად ჩაითვლება. საბანკო ჩანაწერი არ სჭირდება.',
      'Did this transaction go through? The request counts as successful. A bank record is not required.',
    ))) return;
    setBusy('success');
    try {
      await rpc('confirm_request_payment', { p_request_id: row.id });
      toast(t('ტრანზაქცია გავიდა.', 'The transaction went through.'));
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(null);
  }

  async function markLost() {
    if (!window.confirm(t(
      'მოვნიშნოთ დაკარგულად? სახაზინომ უნდა დაადასტუროს დაკარგული მოთხოვნების ჩანართზე. კომენტარი იქ არასავალდებულოა.',
      'Mark this as lost? Treasury still has to approve it on Lost requests. A comment there is optional.',
    ))) return;
    setBusy('lost');
    try {
      await rpc('mark_request_lost', { p_request_id: row.id });
      toast(t('დაკარგულად მოინიშნა. სახაზინოს დადასტურებას ელოდება.', 'Marked as lost. It is waiting for treasury to approve it.'));
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(null);
  }

  return (
    <>
      <button type="button" className="btn btn-primary" disabled={busy != null} onClick={markSuccess}>
        {busy === 'success' ? t('ინახება…', 'Saving…') : t('ტრანზაქცია გავიდა', 'The transaction went through')}
      </button>
      <button type="button" className="btn btn-quiet" disabled={busy != null} onClick={markLost}>
        {busy === 'lost' ? t('ინახება…', 'Saving…') : t('დაიკარგა', 'Lost')}
      </button>
    </>
  );
}
