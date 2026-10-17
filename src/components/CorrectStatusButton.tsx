import { useState } from 'react';
import { rpc } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { useToast } from '../lib/toast';
import { LOSS_PICKER, lossDetailMessage, lossMarkDetail, type BetterRatePlaceId } from '../lib/lossReasons';
import type { RequestRow } from '../lib/types';
import { canMarkRequestOutcome } from './RequestOutcomeButtons';
import LossReasonPicker from './LossReasonPicker';

/**
 * A mark a KAM or an admin already saved.
 * A written rate, or a success that is only a matched payment, is not one of those marks.
 */
export function correctableMark(row: RequestRow): 'went_through' | 'lost' | null {
  if (row.source === 'import') return null;
  if (row.rate_written_at) return null;
  const lost = !!(row.marked_lost_at || (row.loss_reason && row.loss_reason.trim()));
  const confirmed = !!row.payment_confirmed_at;
  if (confirmed) return 'went_through';
  if (lost && !row.went_through) return 'lost';
  return null;
}

/** Correct a saved went-through or lost mark. Hidden unless that mark is theirs to change. */
export default function CorrectStatusButton({ row, onDone }: { row: RequestRow; onDone: () => void }) {
  const { profile } = useAuth();
  const { realRole } = useViewAs();
  const { t } = useI18n();
  const toast = useToast();
  const mark = correctableMark(row);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'lost' | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [place, setPlace] = useState<BetterRatePlaceId | null>(null);
  const [otherText, setOtherText] = useState('');

  if (!mark || !canMarkRequestOutcome(realRole, profile?.id, row.kam_id)) return null;

  const chosen = LOSS_PICKER.find((item) => item.code === reason);
  const detail = lossMarkDetail(chosen, place, otherText);

  function close() {
    setOpen(false);
    setMode(null);
    setReason(null);
    setPlace(null);
    setOtherText('');
  }

  async function send(outcome: 'went_through' | 'lost' | 'clear', note?: string | null) {
    setBusy(true);
    try {
      await rpc('correct_request_outcome', {
        p_request_id: row.id,
        p_outcome: outcome,
        ...(outcome === 'lost' ? { p_reason: reason, ...(note ? { p_detail: note } : {}) } : {}),
      });
      toast(outcome === 'clear'
        ? t('ნიშანი მოიხსნა.', 'The mark was cleared.')
        : outcome === 'lost'
          ? t('დაკარგულად მოინიშნა. ხაზინის დადასტურებას ელოდება.', 'Marked as lost. It is waiting for treasury to approve it.')
          : t('ტრანზაქცია გავიდა.', 'The transaction went through.'));
      close();
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(false);
  }

  async function markWentThrough() {
    if (!window.confirm(t(
      'ტრანზაქცია გავიდა? მოთხოვნა წარმატებულად ჩაითვლება. საბანკო ჩანაწერი არ სჭირდება.',
      'Did this transaction go through? The request counts as successful. A bank record is not required.',
    ))) return;
    await send('went_through');
  }

  async function markLost() {
    if (detail.error) {
      const [ka, en] = lossDetailMessage(detail.error);
      toast(t(ka, en), 'error');
      return;
    }
    if (!window.confirm(t(
      'მოვნიშნოთ დაკარგულად? მიზეზით ხაზინას გაეგზავნება დასადასტურებლად.',
      'Mark this as lost? It goes to treasury for approval with this reason.',
    ))) return;
    await send('lost', detail.detail);
  }

  async function clearMark() {
    if (!window.confirm(t(
      'მოვხსნათ ეს ნიშანი? მოთხოვნა იმ მდგომარეობას დაუბრუნდება, რაც ნიშნამდე ჰქონდა.',
      'Clear this mark? The request returns to the state it had before the mark.',
    ))) return;
    await send('clear');
  }

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        {t('სტატუსის გასწორება', 'Correct status')}
      </button>
    );
  }

  return (
    <div className="stack-sm correct-status" style={{ alignItems: 'flex-start', flex: '1 1 100%' }}>
      {mode == null && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {mark === 'lost' ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void markWentThrough(); }}>
              {busy ? t('ინახება', 'Saving') : t('ტრანზაქცია გავიდა', 'The transaction went through')}
            </button>
          ) : (
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setMode('lost')}>
              {t('დაიკარგა', 'Lost')}
            </button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={() => { void clearMark(); }}>
            {busy ? t('ინახება', 'Saving') : t('ნიშნის მოხსნა', 'Clear the mark')}
          </button>
          <button type="button" className="link" onClick={close}>{t('უკან', 'Back')}</button>
        </div>
      )}
      {mode === 'lost' && (
        <>
          <LossReasonPicker
            reason={reason}
            place={place}
            comment={otherText}
            onReason={(code) => { setReason(code); setPlace(null); setOtherText(''); }}
            onPlace={setPlace}
            onComment={setOtherText}
          />
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" disabled={busy || detail.error != null} onClick={() => { void markLost(); }}>
              {busy ? t('ინახება', 'Saving') : t('ხაზინისთვის გაგზავნა', 'Send to treasury')}
            </button>
            <button type="button" className="link" onClick={() => { setMode(null); setReason(null); setPlace(null); setOtherText(''); }}>{t('უკან', 'Back')}</button>
          </div>
        </>
      )}
    </div>
  );
}
