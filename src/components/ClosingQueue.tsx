import { useRef, useState } from 'react';
import ClientAgreedThenLost from './AgreedThenLostMark';
import { holdWindow, type ClosingDeal } from '../lib/deferWrite';
import { fmtDateTime, fmtRate, sideAmount } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { rpc } from '../lib/supabase';
import { useToast } from '../lib/toast';

function elapsedPhrase(
  minutes: number,
  t: (ka: string, en: string, vars?: Record<string, string | number>) => string,
): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return t('{m} წუთი', '{m} min', { m: mins });
  return t('{h} სთ {m} წთ', '{h} h {m} min', { h: hours, m: mins });
}

function ClosingCard({ row, onDone }: { row: ClosingDeal; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'except' | null>(null);
  const lock = useRef(false);
  const clock = holdWindow(row.client_replied_at);
  const excepted = row.closing_exception_at != null;
  const reasonOk = reason.trim().length >= 2 && reason.trim().length <= 500;

  async function approve() {
    if (lock.current) return;
    lock.current = true;
    setBusy('approve');
    try {
      const result = await rpc<string | null>('treasury_approve_closing', { p_request_id: row.request_id });
      toast(result === 'approved'
        ? t('გასაწერ რიგში გადავიდა. შეთანხმებული კურსი იგივეა.', 'It moved to the write queue. The agreed rate is the same.')
        : t('ცვლილება არ ჩაიწერა.', 'Nothing was changed.'));
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
      lock.current = false;
      setBusy(null);
    }
  }

  async function recordException() {
    if (lock.current || excepted) return;
    setTried(true);
    if (!reasonOk) return;
    lock.current = true;
    setBusy('except');
    try {
      const result = await rpc<string | null>('treasury_record_closing_exception', {
        p_request_id: row.request_id,
        p_reason: reason.trim(),
      });
      toast(result === 'excepted'
        ? t('გამონაკლისი ჩაიწერა. შეთანხმებული კურსი იგივეა.', 'The exception is saved. The agreed rate is the same.')
        : t('ცვლილება არ ჩაიწერა.', 'Nothing was changed.'));
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
      lock.current = false;
      setBusy(null);
    }
  }

  return (
    <article className="req-card">
      <div className="name">{row.client_name ?? row.client_id}</div>
      <div className="tiny muted">ID {row.client_id} · {row.kam_name}</div>
      <ClientAgreedThenLost clientId={row.client_id} excludeId={row.request_id} />
      <div className="small" style={{ marginTop: 6 }}>{t('კლიენტი ყიდის', 'Client sells')} {sideAmount(row.sells_currency, row.amount)}</div>
      <div className="small">{t('კლიენტი იღებს', 'Client gets')} {sideAmount(row.gets_currency, row.gets_amount)}</div>
      <div className="small strong" style={{ marginTop: 6 }}>{t('შეთანხმებული კურსი', 'Agreed rate')} {fmtRate(row.approved_rate)}</div>
      {row.rate != null && <div className="tiny muted">{t('ხაზინის კურსი', 'Treasury rate')}: {fmtRate(row.rate)}</div>}
      {clock && (
        <p className="small" style={{ margin: '8px 0' }}>
          {t(
            'დადასტურებიდან გავიდა {elapsed}. ვადა იყო {deadline}.',
            'Held for {elapsed} since the client accepted. The deadline was {deadline}.',
            { elapsed: elapsedPhrase(clock.elapsedMinutes, t), deadline: fmtDateTime(clock.deadlineIso) },
          )}
        </p>
      )}
      {row.note && <p className="note-box">{t('კომენტარი', 'Comment')}: {row.note}</p>}
      {excepted && (
        <p className="note-box">
          {t('გამონაკლისი', 'Exception')}: {row.closing_exception_reason}
          {row.closing_exception_at ? ' · ' + fmtDateTime(row.closing_exception_at) : ''}
        </p>
      )}
      {excepted && (
        <p className="small" style={{ margin: '8px 0' }}>
          {t(
            'პირველი გამონაკლისი რჩება. დასტური იმავე კურსს გასაწერ რიგში გადაიტანს.',
            'The first exception stays. Approval moves that same rate to the write queue.',
          )}
        </p>
      )}
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button type="button" className="btn btn-primary" disabled={busy != null} onClick={() => { void approve(); }}>
          {busy === 'approve' ? t('იტვირთება', 'Loading') : t('დახურვის დასტური', 'Approve closing')}
        </button>
      </div>
      {!excepted && (
        <>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor={'closing-reason-' + row.request_id}>{t('თუ დახურვა ვერ დასტურდება, მიზეზი', 'Reason, if closing cannot be approved')}</label>
            <input
              id={'closing-reason-' + row.request_id}
              className={'input' + (tried && !reasonOk ? ' invalid' : '')}
              autoComplete="off"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <span className={'hint' + (tried && !reasonOk ? ' error' : '')}>
              {tried && !reasonOk
                ? t('მიზეზი 2-დან 500 სიმბოლომდე უნდა იყოს', 'The reason must be 2 to 500 characters')
                : t('კურსი, დადასტურება და გადახდა არ იცვლება.', 'The rate, the approval, and payment stay as they are.')}
            </span>
          </div>
          <button type="button" className="btn" style={{ marginTop: 8 }} disabled={busy != null} onClick={() => { void recordException(); }}>
            {busy === 'except' ? t('იტვირთება', 'Loading') : t('ვერ დასტურდება', 'Cannot approve')}
          </button>
        </>
      )}
    </article>
  );
}

/** Overdue held deals. Hidden by the parent when setup 43 has not been pasted. */
export default function ClosingQueue({ rows, onDone }: { rows: ClosingDeal[]; onDone: () => void }) {
  const { t } = useI18n();
  return (
    <section className="card flush" id="treasury-closing" aria-labelledby="treasury-closing-title" style={{ marginTop: 22 }}>
      <div className="card-head">
        <h2 id="treasury-closing-title" style={{ fontSize: 22 }}>{t('დასახური გარიგებები — ხაზინის დასტური', 'Held deals — treasury closing approval')}</h2>
        <span className="small muted">{t(
          '24 საათი გავიდა და KAM თავად აღარ აგზავნის. დასტური იმავე კურსს გასაწერ რიგში გადაიტანს. კურსი ამ ღილაკით არ იწერება.',
          '24 hours have passed and the KAM can no longer send it. Approval moves that same rate to the write queue. This button does not write the rate.',
        )}</span>
      </div>
      {rows.length === 0 && <p className="empty">{t('დასახური გარიგება არ არის.', 'No held deal is waiting.')}</p>}
      <div className="stack-sm">
        {rows.map((row) => <ClosingCard key={row.request_id} row={row} onDone={onDone} />)}
      </div>
    </section>
  );
}
