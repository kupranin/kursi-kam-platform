import { useEffect, useState } from 'react';
import { supabase, rpc } from '../../lib/supabase';
import { useToast } from '../../lib/toast';
import { fmtDateTime } from '../../lib/format';

interface NotificationRule { event_type: string; audience: string; enabled: boolean; description: string }
interface HookStatus { audience: string; has_webhook: boolean; last_delivered_at: string | null; failed_last_24h: number; waiting: number }
interface EventRow {
  id: number; event_type: string; audience: string; status: string; attempts: number; last_error: string | null; created_at: string;
  payload: { message?: { en?: string; ka?: string }; recipients?: { name: string }[] };
}

export const EVENT_NAMES: Record<string, string> = {
  'request.new': 'ახალი მოთხოვნა კურსზე',
  'request.asked_again': 'მოთხოვნა ხელახლა',
  'request.client_approved': 'კლიენტმა დაამტკიცა კურსი',
  'request.waiting_long': 'მოთხოვნა დიდხანს ელოდება',
  'rate.ready': 'კურსი მზადაა',
  'request.sent_back': 'მოთხოვნა დაბრუნდა',
  'rate.expiring': 'კურსს ვადა ეწურება',
  'request.went_through': 'კლიენტის ტრანზაქცია მოვიდა',
  'followups.daily': 'დილის შეჯამება დაბრუნებაზე',
  'sync.failed': 'ტრანზაქციების სინქრონიზაცია ჩაიშალა',
  'user.invite': 'ადამიანი მოწვეულია',
};
const AUDIENCE: Record<string, string> = { kam: 'KAM, რომელმაც იკითხა', treasury: 'სახაზინო', admin: 'ადმინები', manager: 'მენეჯერები' };
const HOOK_NAME: Record<string, string> = { kam: 'KAM-ები', treasury: 'სახაზინო', admin: 'ადმინები', manager: 'მენეჯერები' };
const STATUS: Record<string, { text: string; cls: string }> = {
  delivered: { text: 'მიწოდებულია', cls: 'pill-ok' },
  sent: { text: 'გაიგზავნა, GoSMS-ს ან Meta-ს ელოდება', cls: 'pill-wait' },
  pending: { text: 'ელოდება', cls: 'pill-wait' },
  failed: { text: 'ჩაიშალა', cls: 'pill-alert' },
  no_webhook: { text: 'SMS ან WhatsApp ჯერ არ არის მიერთებული', cls: 'pill-warn' },
  no_recipients: { text: 'გასაგზავნი არავინ არის', cls: 'pill-warn' },
};
const DESC_KA: Record<string, string> = {
  'A KAM asks for a rate': 'KAM კურსს ითხოვს',
  'A KAM asks again after an expired rate or a send-back': 'KAM ხელახლა ითხოვს ვადაგასული კურსის ან დაბრუნების შემდეგ',
  'A request has waited longer than the alert time': 'მოთხოვნა გაფრთხილების დროზე დიდხანს ელოდება',
  'Same alert, copied to admins': 'იგივე გაფრთხილება, ასლი ადმინებს',
  'Treasury sent a rate': 'სახაზინომ კურსი გაგზავნა',
  'Treasury sent the request back, with the reason': 'სახაზინომ მოთხოვნა დააბრუნა, მიზეზით',
  'A rate is about to expire and the client\'s transaction hasn\'t arrived': 'კურსს ვადა ეწურება და კლიენტის ტრანზაქცია ჯერ არ მოსულა',
  'The client\'s transaction arrived': 'კლიენტის ტრანზაქცია მოვიდა',
  'Same news, copied to treasury': 'იგივე ამბავი, ასლი სახაზინოს',
  'Morning summary: reasons to give and priority A clients to call': 'დილის შეჯამება: მისათითებელი მიზეზები და პრიორიტეტი A-ს კლიენტები, რომლებსაც უნდა დარეკოთ',
  'Transactions could not be updated from ClickHouse': 'ტრანზაქციები ClickHouse-იდან ვერ განახლდა',
};

export default function MessagesPanel() {
  const toast = useToast();
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [hooks, setHooks] = useState<HookStatus[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [testEvent, setTestEvent] = useState('rate.ready');

  async function load() {
    const [r, e] = await Promise.all([
      supabase.from('notification_rules').select('*').order('event_type'),
      supabase.from('notification_events').select('id, event_type, audience, status, attempts, last_error, created_at, payload').order('id', { ascending: false }).limit(25),
    ]);
    setRules((r.data ?? []) as NotificationRule[]);
    setEvents((e.data ?? []) as EventRow[]);
    try { setHooks(await rpc<HookStatus[]>('admin_message_status')); } catch { setHooks([]); }
  }
  useEffect(() => { load(); }, []);

  async function toggle(r: NotificationRule) {
    const { error } = await supabase.from('notification_rules').update({ enabled: !r.enabled }).eq('event_type', r.event_type).eq('audience', r.audience);
    if (error) { toast(error.message, 'error'); return; }
    toast(`${EVENT_NAMES[r.event_type] ?? r.event_type}, ${AUDIENCE[r.audience]}: ${r.enabled ? 'გამორთულია' : 'ჩართულია'}.`);
    load();
  }

  async function sendTest() {
    try {
      const n = await rpc<number>('send_test_notification', { p_event: testEvent });
      toast(n ? 'ტესტი გაიგზავნა. იწყება [Test]-ით, რომ არავინ აურიოს ნამდვილ მოთხოვნაში.' : 'ეს შეტყობინება ყველა როლისთვის გამორთულია.');
      window.setTimeout(load, 1500);
    } catch (err) { toast((err as Error).message, 'error'); }
  }

  const order = Object.keys(EVENT_NAMES);
  const sorted = [...rules].sort((a, b) => order.indexOf(a.event_type) - order.indexOf(b.event_type));
  const eventTypes = Array.from(new Set(sorted.map((r) => r.event_type)));

  return (
    <section id="messages" className="card flush" aria-labelledby="messages-title">
      <div className="card-head" style={{ alignItems: 'center' }}>
        <div>
          <h2 id="messages-title" style={{ fontSize: 22 }}>შეტყობინებები</h2>
          <p className="small" style={{ color: 'var(--ink-2)' }}>SMS იგზავნება GoSMS-ით, WhatsApp კი Meta-თი. ტექსტი ქართულია. ელფოსტა ამ გზით არ იგზავნება.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <label className="small strong" style={{ fontWeight: 500 }} htmlFor="test-event">ტესტის გაგზავნა</label>
          <select id="test-event" className="select" style={{ width: 'auto', minHeight: 44 }} value={testEvent} onChange={(e) => setTestEvent(e.target.value)}>
            {eventTypes.map((t) => <option key={t} value={t}>{EVENT_NAMES[t] ?? t}</option>)}
          </select>
          <button type="button" className="btn" onClick={sendTest}>გაგზავნა</button>
        </div>
      </div>

      <div style={{ padding: '0 24px 18px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
        {hooks.filter((h) => h.has_webhook || h.audience !== 'manager').map((h) => (
          <div key={h.audience} style={{ padding: '14px 16px', borderRadius: 12, background: h.has_webhook ? '#EAF7F1' : 'var(--warn-bg)' }}>
            <div className="strong">{HOOK_NAME[h.audience]}</div>
            <div className="small strong" style={{ fontWeight: 500, color: h.has_webhook ? 'var(--ok)' : 'var(--warn)' }}>{h.has_webhook ? 'მიერთებულია' : 'ჯერ არ არის მიერთებული'}</div>
            <div className="tiny" style={{ color: 'var(--ink-2)' }}>
              {h.has_webhook
                ? (h.last_delivered_at ? 'ბოლოს გაიგზავნა ' + fmtDateTime(h.last_delivered_at) : 'ჯერ არაფერი გაგზავნილა') + (Number(h.failed_last_24h) ? `. დღეს ${h.failed_last_24h} ჩაიშალა.` : '')
                : 'Vault-ში დაამატეთ GoSMS-ის გასაღები ან Meta-ს WhatsApp ტოკენი'}
            </div>
          </div>
        ))}
      </div>

      <div className="table-wrap">
        <table className="table" style={{ minWidth: 640 }}>
          <thead><tr><th>შეტყობინება</th><th>მიდის</th><th className="num">ჩართული</th></tr></thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.event_type + r.audience}>
                <td><div className="strong" style={{ fontWeight: 500, color: r.enabled ? undefined : 'var(--muted)' }}>{EVENT_NAMES[r.event_type] ?? r.event_type}</div><div className="tiny muted">{DESC_KA[r.description] ?? r.description}</div></td>
                <td style={{ color: r.enabled ? undefined : 'var(--muted)' }}>{AUDIENCE[r.audience]}</td>
                <td className="num">
                  <label className="checkbox" style={{ justifyContent: 'flex-end' }}>
                    <span className="sr-only">{EVENT_NAMES[r.event_type]}, {AUDIENCE[r.audience]}</span>
                    <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} />
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ margin: '22px 24px 6px' }}>ბოლო შეტყობინებები</h3>
      {!events.length && <p className="empty">შეტყობინება ჯერ არ არის.</p>}
      {events.map((e) => {
        const st = STATUS[e.status] ?? { text: e.status, cls: 'pill-wait' };
        const to = e.payload.recipients?.map((r) => r.name).join(', ') || HOOK_NAME[e.audience];
        return (
          <div key={e.id} className="list-row" style={{ paddingTop: 12, paddingBottom: 12 }}>
            <span className="muted" style={{ flex: '0 0 110px' }}>{fmtDateTime(e.created_at)}</span>
            <span style={{ flex: '1 1 320px', minWidth: 0 }}>
              <span className="strong" style={{ fontWeight: 500 }}>{EVENT_NAMES[e.event_type] ?? e.event_type}</span>
              <span className="tiny muted" style={{ display: 'block' }}>{e.payload.message?.ka ?? e.payload.message?.en}</span>
              {e.last_error && <span className="tiny error-text" style={{ display: 'block' }}>{e.last_error}{e.attempts > 1 ? ` (${e.attempts} ცდა)` : ''}</span>}
            </span>
            <span style={{ flex: '0 0 200px', color: 'var(--ink-2)' }}>{to}</span>
            <span className={'pill ' + st.cls}>{st.text}</span>
          </div>
        );
      })}
    </section>
  );
}
