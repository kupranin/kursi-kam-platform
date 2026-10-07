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
  month_grace_days: 'month cutoff', default_quote_minutes: 'rate validity', winback_window_days: 'win-back window',
  tier_a_min_gel: 'priority A threshold', tier_b_min_gel: 'priority B threshold', request_delete_minutes: 'delete window',
  admin_requires_mfa: 'authenticator app for admins', treasury_alert_seconds: 'treasury alert time',
  expiry_warning_minutes: 'expiry warning', app_url: 'platform address',
};

function describe(a: AuditRow, names: Names): string {
  const n = (a.new_data ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const o = (a.old_data ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (a.table_name) {
    case 'requests':
      if (a.action === 'insert') return `Asked for a rate: client ${n.client_id}, ${describeDeal(n.sells_currency, n.amount, n.gets_currency, n.gets_amount).toLowerCase()}`;
      if (a.action === 'delete') return `Deleted request #${a.row_key} (client ${o.client_id})`;
      if (o.loss_reason !== n.loss_reason || o.loss_reason_note !== n.loss_reason_note) {
        if (!n.loss_reason) return `Cleared the reason for request #${a.row_key}`;
        return `Gave a reason for request #${a.row_key}: ${n.loss_reason}${n.loss_reason_note ? ` (${n.loss_reason_note})` : ''}`;
      }
      if (o.quote_status !== n.quote_status && n.quote_status === 'asking') return `Asked again for request #${a.row_key}`;
      return `Changed request #${a.row_key}`;
    case 'quotes':
      return n.action === 'quoted' ? `Gave rate ${fmtRate(n.rate)} for request #${n.request_id}` : `Sent back request #${n.request_id}: ${n.reason}`;
    case 'clients':
      if (a.action === 'insert') return `Added client ${n.client_id}${n.name ? ' (' + n.name + ')' : ''}`;
      return `Changed client ${a.row_key}`;
    case 'winback_actions':
      return `Win-back step for client ${n.client_id}: ${String(n.step).replace(/_/g, ' ')}`;
    case 'rules': {
      const changed = Object.keys(RULE_LABELS).filter((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k]));
      return changed.length ? 'Changed ' + changed.map((k) => `${RULE_LABELS[k]} from ${o[k] ?? 'not set'} to ${n[k] ?? 'not set'}`).join('; ') : 'Saved the rules';
    }
    case 'loss_reasons':
      return a.action === 'insert' ? `Added the reason "${n.label_en}"` : `Changed the reason "${n.label_en ?? o.label_en}"`;
    case 'notification_rules':
      return `${EVENT_NAMES[n.event_type] ?? n.event_type} to ${n.audience}: ${n.enabled ? 'on' : 'off'}`;
    case 'profiles':
      if (a.action === 'invite_user') return `Invited ${n.email} as ${ROLE_NAMES[n.role as Role] ?? n.role}`;
      if (a.action === 'set_role') return `Changed ${names[a.row_key ?? ''] ?? 'a person'}'s role from ${n.from} to ${n.to}`;
      if (a.action === 'deactivate_user') return `Switched off ${n.email}`;
      if (a.action === 'reactivate_user') return `Switched on ${n.email}`;
      if (a.action === 'send_password_reset') return `Sent a password link to ${n.email}`;
      if (a.action === 'set_contact') return `Changed how ${names[a.row_key ?? ''] ?? 'a person'} gets messages`;
      if (a.action === 'insert') return `Added ${n.full_name}`;
      return `Changed ${n.full_name ?? 'a person'}`;
    default:
      return `${a.action} ${a.table_name ?? ''} ${a.row_key ?? ''}`.trim();
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

  const actor = (id: string | null) => (id ? names[id] ?? 'Someone' : 'System');

  return (
    <section id="activity" className="card flush" aria-labelledby="activity-title">
      <div className="card-head" style={{ alignItems: 'center' }}>
        <div>
          <h2 id="activity-title" style={{ fontSize: 22 }}>Activity</h2>
          <p className="small" style={{ color: 'var(--ink-2)' }}>Every change, with who made it. Nobody can edit or delete this list.</p>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <label htmlFor="who" className="small strong" style={{ fontWeight: 500 }}>Show</label>
          <select id="who" className="select" style={{ width: 'auto', minHeight: 44 }} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="all">Everyone</option>
            {Object.entries(names).sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            <option value="system">System (sync, imports)</option>
          </select>
          <button type="button" className="btn btn-quiet" onClick={() => downloadCsv('activity.csv', [['When', 'Who', 'What'], ...rows.map((r) => [fmtDateTime(r.at), actor(r.actor_profile_id), describe(r, names)])])}>Download</button>
        </div>
      </div>
      {!rows.length && <p className="empty">Nothing here yet.</p>}
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
