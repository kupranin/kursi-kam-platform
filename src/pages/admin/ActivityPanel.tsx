import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { describeDeal, downloadCsv, fmtDateTime, fmtRate } from '../../lib/format';
import { ROLE_NAMES, type Role } from '../../lib/types';
import type { Names } from './Admin';
import { EVENT_NAMES } from './MessagesPanel';

interface AuditRow {
  id: number; at: string; actor_profile_id: string | null; action: string; table_name: string | null; row_key: string | null;
  old_data: Record<string, unknown> | null; new_data: Record<string, unknown> | null;
}

const RULE_LABELS: Record<string, string> = {
  month_grace_days: 'თვის ზღვარი', default_quote_minutes: 'კურსის მოქმედება', winback_window_days: 'დაბრუნების ფანჯარა',
  tier_a_min_gel: 'პრიორიტეტი A-ის ზღვარი', tier_b_min_gel: 'პრიორიტეტი B-ის ზღვარი', request_delete_minutes: 'წაშლის დრო',
  admin_requires_mfa: 'ავთენტიფიკატორი ადმინებისთვის', treasury_alert_seconds: 'სახაზინოს გაფრთხილების დრო',
  expiry_warning_minutes: 'ვადის გაფრთხილება', app_url: 'პლატფორმის მისამართი',
};

const LOSS_KA: Record<string, string> = {
  better_rate: 'სხვაგან უკეთესი კურსი',
  postponed: 'გადადო',
  funds_not_received: 'თანხა არ ჩაურიცხავს',
  other: 'სხვა',
};

const DECLINE_KA: Record<string, string> = {
  'Amount too large': 'თანხა ძალიან დიდია',
  'Market moving too fast': 'ბაზარი ძალიან სწრაფად იცვლება',
  'Need more details': 'მეტი დეტალია საჭირო',
};

const STEP_KA: Record<string, string> = {
  not_contacted: 'ჯერ არ დაკავშირებულა',
  called: 'დარეკა',
  meeting_set: 'შეხვედრა დანიშნულია',
  converted: 'კვლავ გადაიყვანა',
  not_interested: 'არ აინტერესებს',
};

const AUDIENCE_KA: Record<string, string> = {
  kam: 'KAM',
  treasury: 'სახაზინო',
  admin: 'ადმინები',
  manager: 'მენეჯერები',
};

const ACTION_KA: Record<string, string> = { insert: 'დამატება', update: 'შეცვლა', delete: 'წაშლა' };
const TABLE_KA: Record<string, string> = {
  requests: 'მოთხოვნა',
  quotes: 'კურსი',
  clients: 'კლიენტი',
  winback_actions: 'დაბრუნება',
  rules: 'წესები',
  loss_reasons: 'მიზეზი',
  notification_rules: 'შეტყობინება',
  profiles: 'ადამიანი',
};

function ruleVal(v: unknown): string {
  if (v == null || v === '') return 'არ არის';
  if (v === true) return 'ჩართულია';
  if (v === false) return 'გამორთულია';
  return String(v);
}

function roleName(role: unknown): string {
  return ROLE_NAMES[role as Role] ?? String(role ?? '');
}

function describe(a: AuditRow, names: Names): string {
  const n = (a.new_data ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const o = (a.old_data ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (a.table_name) {
    case 'requests':
      if (a.action === 'insert') return `კურსი ითხოვა: კლიენტი ${n.client_id}, ${describeDeal(n.sells_currency, n.amount, n.gets_currency, n.gets_amount)}`;
      if (a.action === 'delete') return `წაიშალა მოთხოვნა #${a.row_key} (კლიენტი ${o.client_id})`;
      if (o.client_reply !== n.client_reply && n.client_reply === 'approved') return `კლიენტმა დაამტკიცა მოთხოვნა #${a.row_key}, კურსი ${fmtRate(n.approved_rate)}`;
      if (o.client_reply !== n.client_reply && n.client_reply === 'better') return `კლიენტს უკეთესი კურსი სურს, მოთხოვნა #${a.row_key}: ${fmtRate(n.wanted_rate)}`;
      if (o.client_reply !== n.client_reply && n.client_reply === 'declined') return `კლიენტმა უარი თქვა, მოთხოვნა #${a.row_key}: ${n.client_decline_reason}`;
      if (o.better_decision !== n.better_decision && n.better_decision === 'accepted') return `სახაზინომ დაადასტურა ${fmtRate(n.given_rate)}, მოთხოვნა #${a.row_key}`;
      if (o.better_decision !== n.better_decision && n.better_decision === 'corrected') return `გასწორებული კურსი ${fmtRate(n.given_rate)}, მოთხოვნა #${a.row_key}`;
      if (o.quote_status !== 'declined' && n.quote_status === 'declined' && n.decline_reason) return `სახაზინომ უარი თქვა, მოთხოვნა #${a.row_key}: ${DECLINE_KA[n.decline_reason] ?? n.decline_reason}`;
      if (o.client_reply === 'better' && !n.client_reply && n.quote_status === 'quoted') return `სახაზინომ დააბრუნა კურსი ${fmtRate(n.rate)}, მოთხოვნა #${a.row_key}`;
      if (o.loss_reason !== n.loss_reason || o.loss_reason_note !== n.loss_reason_note) {
        if (!n.loss_reason) return `მიზეზი გასუფთავდა მოთხოვნაზე #${a.row_key}`;
        return `მიზეზი მიეთითა მოთხოვნაზე #${a.row_key}: ${LOSS_KA[n.loss_reason] ?? n.loss_reason}${n.loss_reason_note ? ` (${n.loss_reason_note})` : ''}`;
      }
      if (o.quote_status !== n.quote_status && n.quote_status === 'asking') return `ხელახლა იკითხა მოთხოვნაზე #${a.row_key}`;
      return `შეიცვალა მოთხოვნა #${a.row_key}`;
    case 'quotes':
      return n.action === 'quoted' ? `კურსი ${fmtRate(n.rate)} გასცა მოთხოვნაზე #${n.request_id}` : `დააბრუნა მოთხოვნა #${n.request_id}: ${DECLINE_KA[n.reason] ?? n.reason}`;
    case 'clients':
      if (a.action === 'insert') return `დაემატა კლიენტი ${n.client_id}${n.name ? ' (' + n.name + ')' : ''}`;
      return `შეიცვალა კლიენტი ${a.row_key}`;
    case 'winback_actions':
      return `დაბრუნების ნაბიჯი კლიენტზე ${n.client_id}: ${STEP_KA[n.step] ?? String(n.step).replace(/_/g, ' ')}`;
    case 'rules': {
      const changed = Object.keys(RULE_LABELS).filter((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k]));
      return changed.length ? 'შეიცვალა ' + changed.map((k) => `${RULE_LABELS[k]} ${ruleVal(o[k])}-დან ${ruleVal(n[k])}-ზე`).join('; ') : 'წესები შეინახა';
    }
    case 'loss_reasons':
      return a.action === 'insert' ? `დაემატა მიზეზი „${n.label_ka || n.label_en}“` : `შეიცვალა მიზეზი „${n.label_ka || n.label_en || o.label_ka || o.label_en}“`;
    case 'notification_rules':
      return `${EVENT_NAMES[n.event_type] ?? n.event_type}, ${AUDIENCE_KA[n.audience] ?? n.audience}: ${n.enabled ? 'ჩართულია' : 'გამორთულია'}`;
    case 'profiles':
      if (a.action === 'invite_user') return `მოიწვია ${n.email} როლით ${roleName(n.role)}`;
      if (a.action === 'set_role') {
        const person = names[a.row_key ?? ''];
        const who = person ? `${person}-ის` : 'ადამიანის';
        return `${who} როლი შეიცვალა ${roleName(n.from)}-დან ${roleName(n.to)}-ზე`;
      }
      if (a.action === 'deactivate_user') return `გამორთო ${n.email}`;
      if (a.action === 'reactivate_user') return `ჩართო ${n.email}`;
      if (a.action === 'send_password_reset') return `პაროლის ბმული გაუგზავნა ${n.email}-ს`;
      if (a.action === 'set_contact') return `შეიცვალა, როგორ იღებს შეტყობინებას ${names[a.row_key ?? ''] ?? 'ადამიანი'}`;
      if (a.action === 'insert') return `დაემატა ${n.full_name}`;
      return `შეიცვალა ${n.full_name ?? 'ადამიანი'}`;
    default:
      return `${ACTION_KA[a.action] ?? a.action} ${TABLE_KA[a.table_name ?? ''] ?? a.table_name ?? ''} ${a.row_key ?? ''}`.trim();
  }
}

export default function ActivityPanel({ names }: { names: Names }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [who, setWho] = useState('all');

  useEffect(() => {
    let q = supabase.from('audit_log').select('*').order('id', { ascending: false }).limit(150);
    if (who === 'system') q = q.is('actor_profile_id', null);
    else if (who !== 'all') q = q.eq('actor_profile_id', who);
    q.then(({ data }) => setRows((data ?? []) as AuditRow[]));
  }, [who]);

  const actor = (id: string | null) => (id ? names[id] ?? 'ვიღაც' : 'სისტემა');

  return (
    <section id="activity" className="card flush" aria-labelledby="activity-title">
      <div className="card-head" style={{ alignItems: 'center' }}>
        <div>
          <h2 id="activity-title" style={{ fontSize: 22 }}>აქტივობა</h2>
          <p className="small" style={{ color: 'var(--ink-2)' }}>ყველა ცვლილება, ვინც გააკეთა. ამ სიას ვერავინ შეცვლის ან წაშლის.</p>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <label htmlFor="who" className="small strong" style={{ fontWeight: 500 }}>ჩვენება</label>
          <select id="who" className="select" style={{ width: 'auto', minHeight: 44 }} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="all">ყველა</option>
            {Object.entries(names).sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            <option value="system">სისტემა (სინქრონიზაცია, იმპორტი)</option>
          </select>
          <button type="button" className="btn btn-quiet" onClick={() => downloadCsv('activity.csv', [['როდის', 'ვინ', 'რა'], ...rows.map((r) => [fmtDateTime(r.at), actor(r.actor_profile_id), describe(r, names)])])}>ჩამოტვირთვა</button>
        </div>
      </div>
      {!rows.length && <p className="empty">ჯერ არაფერია.</p>}
      {rows.map((r) => (
        <div key={r.id} className="list-row" style={{ paddingTop: 12, paddingBottom: 12 }}>
          <span className="muted" style={{ flex: '0 0 130px' }}>{fmtDateTime(r.at)}</span>
          <span className="strong" style={{ flex: '0 0 190px', fontWeight: 500 }}>{actor(r.actor_profile_id)}</span>
          <span style={{ flex: '1 1 320px', minWidth: 0 }}>{describe(r, names)}</span>
        </div>
      ))}
    </section>
  );
}
