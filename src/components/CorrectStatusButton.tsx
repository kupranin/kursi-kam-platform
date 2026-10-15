import { useEffect, useState } from 'react';
import { rpc, supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { useToast } from '../lib/toast';
import type { LossReason, RequestRow } from '../lib/types';
import { canMarkRequestOutcome } from './RequestOutcomeButtons';

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
  const { t, lang } = useI18n();
  const toast = useToast();
  const mark = correctableMark(row);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'lost' | null>(null);
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<LossReason[]>(FALLBACK_REASONS);
  const [reason, setReason] = useState<string | null>(null);
  const [otherText, setOtherText] = useState('');

  useEffect(() => {
    if (mode !== 'lost') return;
    let gone = false;
    supabase.from('loss_reasons').select('*').eq('active', true).order('sort_order')
      .then(({ data }) => {
        if (gone || !data?.length) return;
        setReasons(data as LossReason[]);
      });
    return () => { gone = true; };
  }, [mode]);

  if (!mark || !canMarkRequestOutcome(realRole, profile?.id, row.kam_id)) return null;

  const chosen = reasons.find((item) => item.code === reason);
  const reasonText = (item: LossReason) => (lang === 'en' ? item.label_en : item.label_ka).trim() || item.label_en || item.label_ka;

  function close() {
    setOpen(false);
    setMode(null);
    setReason(null);
    setOtherText('');
  }

  async function send(outcome: 'went_through' | 'lost' | 'clear', detail?: string) {
    setBusy(true);
    try {
      await rpc('correct_request_outcome', {
        p_request_id: row.id,
        p_outcome: outcome,
        ...(outcome === 'lost' ? { p_reason: reason, ...(detail ? { p_detail: detail } : {}) } : {}),
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
    await send('lost', detail);
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
        <div className="stack-sm" style={{ width: '100%' }}>
          <div className="tiny muted">{t('მიზეზი სავალდებულოა, სანამ ხაზინას გაეგზავნება.', 'A reason is required before this goes to treasury.')}</div>
          <div className="chips">
            {reasons.map((item) => (
              <button key={item.code} type="button" className="chip" aria-pressed={reason === item.code} onClick={() => setReason(item.code)}>
                {reasonText(item)}
              </button>
            ))}
          </div>
          {isOther(chosen) && (
            <label className="field" style={{ margin: 0 }}>
              <span className="tiny">{t('კომენტარი', 'Comment')}</span>
              <input className="input" value={otherText} maxLength={500} placeholder={t('ჩაწერეთ მიზეზი', 'Write the reason')} onChange={(e) => setOtherText(e.target.value)} />
            </label>
          )}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" disabled={busy || !reason} onClick={() => { void markLost(); }}>
              {busy ? t('ინახება', 'Saving') : t('ხაზინისთვის გაგზავნა', 'Send to treasury')}
            </button>
            <button type="button" className="link" onClick={() => setMode(null)}>{t('უკან', 'Back')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
