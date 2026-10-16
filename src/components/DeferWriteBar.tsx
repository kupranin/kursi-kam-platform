import { useEffect, useRef, useState } from 'react';
import { isRateWriteDeferred, saveRequestNote } from '../lib/deferWrite';
import { useI18n } from '../lib/i18n';
import { rpc } from '../lib/supabase';
import { useToast } from '../lib/toast';
import type { RequestRow } from '../lib/types';

/** Held approval: release it to treasury once, and edit the request comment. */
export default function DeferWriteBar({ row, onDone }: { row: RequestRow; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [note, setNote] = useState(row.note ?? '');
  const [busy, setBusy] = useState<'write' | 'note' | null>(null);
  const lock = useRef(false);
  useEffect(() => { setNote(row.note ?? ''); }, [row.id, row.note]);
  if (!isRateWriteDeferred(row)) return null;

  async function release() {
    if (lock.current) return;
    lock.current = true;
    setBusy('write');
    try {
      await rpc('kam_release_rate_write', { p_request_id: row.id });
      toast(t('გაეგზავნა ხაზინას და მენეჯერებს.', 'Sent to treasury and managers.'));
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
      lock.current = false;
      setBusy(null);
    }
  }

  async function saveNote() {
    if (lock.current) return;
    lock.current = true;
    setBusy('note');
    try {
      await saveRequestNote(row, note);
      toast(t('კომენტარი შეინახა.', 'Comment saved.'));
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    lock.current = false;
    setBusy(null);
  }

  return (
    <div className="defer-write">
      <p className="small strong" style={{ margin: '0 0 8px' }}>
        {t('კლიენტმა დაადასტურა — გაწერას ელოდება', 'Client confirmed — waiting to write the rate')}
      </p>
      <button type="button" className="btn btn-primary" disabled={busy != null} onClick={() => { void release(); }}>
        {busy === 'write' ? t('იტვირთება', 'Loading') : t('გაწერეთ კურსი', 'Write the rate')}
      </button>
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor={'defer-note-' + row.id}>{t('კომენტარი ხაზინისთვის', 'Comment for treasury')}</label>
        <input id={'defer-note-' + row.id} className="input" autoComplete="off" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <button type="button" className="btn" style={{ marginTop: 8 }} disabled={busy != null} onClick={() => { void saveNote(); }}>
        {busy === 'note' ? t('იტვირთება', 'Loading') : t('კომენტარის შენახვა', 'Save comment')}
      </button>
    </div>
  );
}
