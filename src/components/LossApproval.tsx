import { useState, type FormEvent } from 'react';
import { rpc } from '../lib/supabase';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { useToast } from '../lib/toast';
import type { RequestRow } from '../lib/types';

function pendingLoss(row: RequestRow): boolean {
  return row.loss_open === true
    && !row.went_through
    && !row.rate_written_at
    && !row.payment_confirmed_at;
}

/** Treasury explanation on a lost request, and the approval box for treasury or an admin. */
export default function LossApproval({ row, onDone }: { row: RequestRow; onDone: () => void }) {
  const { realRole } = useViewAs();
  const { t } = useI18n();
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = pendingLoss(row);
  const comment = (!row.went_through && !row.rate_written_at && !row.payment_confirmed_at
    ? row.loss_approval_comment
    : '')?.trim() ?? '';
  if (!pending && !comment) return null;
  const canApprove = pending && (realRole === 'treasury' || realRole === 'admin');

  async function approve(e: FormEvent) {
    e.preventDefault();
    const explanation = text.trim();
    if (explanation.length > 500) return;
    setBusy(true);
    try {
      await rpc('approve_request_loss', {
        p_request_id: row.id,
        p_comment: explanation || null,
      });
      toast(explanation
        ? t('დანაკარგი დადასტურებულია. კომენტარი შენახულია.', 'Loss approved. The comment is saved.')
        : t('დანაკარგი დადასტურებულია.', 'Loss approved.'));
      setText('');
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(false);
  }

  return (
    <div style={{ flex: '1 1 100%' }}>
      {pending && (
        <p className="tiny" style={{ margin: '8px 0 0' }}>
          <span className="pill pill-alert">{t('არ გავიდა', 'Did not go through')}</span>
          {' '}
          <span className="muted">{t(
            'სახაზინომ ჯერ არ დაადასტურა. სანამ არ დაადასტურებს, დანაკარგი საბოლოო არ არის.',
            'Treasury has not approved it yet. Until they approve it, the loss is not final.',
          )}</span>
        </p>
      )}
      {comment && (
        <p className="note-box">
          {t('სახაზინოს კომენტარი', 'Treasury comment')}: {comment}
          {row.loss_approver_name ? ` — ${row.loss_approver_name}` : ''}
        </p>
      )}
      {canApprove && (
        <form onSubmit={approve} noValidate className="form-row" style={{ marginTop: 8 }}>
          <div className="field" style={{ flex: '1 1 280px' }}>
            <label htmlFor={'loss-comment-' + row.id}>
              {t('სახაზინოს კომენტარი', 'Treasury comment')}{' '}
              <span className="muted" style={{ fontWeight: 400 }}>({t('არასავალდებულო', 'optional')})</span>
            </label>
            <textarea
              id={'loss-comment-' + row.id}
              className="input"
              maxLength={500}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <span className="hint">{t(
              'ჩაწერეთ, თუ ახსნა გჭირდებათ. ცარიელიც შეიძლება.',
              'Write one when you need to explain. Empty is allowed.',
            )}</span>
          </div>
          <div style={{ paddingTop: 27 }}>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? t('ინახება…', 'Saving…') : t('დანაკარგის დადასტურება', 'Approve the loss')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
