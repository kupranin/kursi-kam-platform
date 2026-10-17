import { useState } from 'react';
import { kamMayEditRequest } from '../lib/clientOwnership';
import { isWrittenHistory } from '../lib/requestStatus';
import { rpc } from '../lib/supabase';
import { useI18n } from '../lib/i18n';
import { useToast } from '../lib/toast';
import type { Role } from '../lib/types';

/** Real database role. View-as does not count. */
export function canDeleteRequest(realRole: Role, profileId: string | undefined, kamId: string | null | undefined): boolean {
  return kamMayEditRequest(realRole, profileId, kamId);
}

/** A written rate is deletable for a real admin only. A KAM still cannot delete one. */
export function mayDeleteRequestRow(
  realRole: Role,
  profileId: string | undefined,
  kamId: string | null | undefined,
  row: { rate_written_at?: string | null },
): boolean {
  if (!canDeleteRequest(realRole, profileId, kamId)) return false;
  return realRole === 'admin' || !isWrittenHistory(row);
}

export default function DeleteRequestButton({ requestId, onDeleted }: { requestId: number; onDeleted: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!window.confirm(t(
      'წავშალოთ ეს მოთხოვნა? კლიენტი დარჩება. ეს ქმედება უკან ვერ ბრუნდება.',
      'Delete this request? The client stays. This cannot be undone.',
    ))) return;
    setBusy(true);
    try {
      await rpc('delete_request', { p_request_id: requestId });
      toast(t('მოთხოვნა წაიშალა.', 'Request deleted.'));
      onDeleted();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(false);
  }

  return (
    <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
      {busy ? t('იშლება…', 'Deleting…') : t('წაშლა', 'Delete')}
    </button>
  );
}
