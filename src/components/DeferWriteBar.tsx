import { useEffect, useRef, useState } from 'react';
import { holdWindow, isRateWriteDeferred, saveRequestNote, useClosingReady } from '../lib/deferWrite';
import { fmtDateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { rpc } from '../lib/supabase';
import { useToast } from '../lib/toast';
import type { RequestRow } from '../lib/types';
import LoadingLine from './LoadingLine';

function elapsedPhrase(
  minutes: number,
  t: (ka: string, en: string, vars?: Record<string, string | number>) => string,
): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return t('{m} წუთი', '{m} min', { m: mins });
  return t('{h} სთ {m} წთ', '{h} h {m} min', { h: hours, m: mins });
}

/**
 * Held approval: release it to treasury once, and edit the request comment.
 * The clock is client_replied_at, set when the KAM saves the deferred approval.
 * That instant is the client acceptance. Passing 24 hours leaves the rate as agreed.
 */
export default function DeferWriteBar({ row, onDone }: { row: RequestRow; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const closingGate = useClosingReady();
  const [note, setNote] = useState(row.note ?? '');
  const [busy, setBusy] = useState<'write' | 'note' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lock = useRef(false);
  useEffect(() => { setNote(row.note ?? ''); }, [row.id, row.note]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  if (!isRateWriteDeferred(row)) return null;

  const clock = holdWindow(row.client_replied_at, now);

  async function release() {
    if (lock.current) return;
    lock.current = true;
    setBusy('write');
    try {
      const result = await rpc<string | null>('kam_release_rate_write', { p_request_id: row.id });
      if (result === 'released') {
        toast(t('გაეგზავნა ხაზინას და მენეჯერებს.', 'Sent to treasury and managers.'));
        onDone();
      } else {
        toast(t('გაწერის რიგში არ გაგზავნილა.', 'It was not sent to the write queue.'));
        lock.current = false;
        setBusy(null);
        onDone();
      }
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
      {clock && (
        <p className="small" style={{ margin: '0 0 8px' }}>
          {t(
            'დადასტურებიდან გავიდა {elapsed}. გაწერის 24 საათი სრულდება {deadline}-ზე. შეთანხმებული კურსი იგივეა.',
            'Held for {elapsed} since the client accepted. The 24-hour hold ends at {deadline}. The agreed rate stays the same.',
            { elapsed: elapsedPhrase(clock.elapsedMinutes, t), deadline: fmtDateTime(clock.deadlineIso) },
          )}
        </p>
      )}
      {clock?.overdue && closingGate === 'unknown' && <LoadingLine compact />}
      {clock?.overdue && closingGate === 'on' && (
        <p className="small" style={{ margin: '0 0 8px' }}>
          {t(
            '24 საათი გავიდა. შეთანხმებული კურსი იგივეა. დახურვას ხაზინა ადასტურებს.',
            '24 hours have passed. The agreed rate is the same. Treasury approves closing.',
          )}
        </p>
      )}
      {clock?.overdue && closingGate === 'off' && (
        <p className="small" style={{ margin: '0 0 8px' }}>
          {t(
            '24 საათი გავიდა. შეთანხმებული კურსი იგივეა. გაწერა ისევ ამ ღილაკს ელოდება.',
            '24 hours have passed. The agreed rate is the same. Writing still waits for this button.',
          )}
        </p>
      )}
      {(!clock?.overdue || closingGate === 'off') && (
        <button type="button" className="btn btn-primary" disabled={busy != null} onClick={() => { void release(); }}>
          {busy === 'write' ? t('იტვირთება', 'Loading') : t('გაწერეთ კურსი', 'Write the rate')}
        </button>
      )}
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
