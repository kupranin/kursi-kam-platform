import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminUsers } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import { fmtDateTime } from '../../lib/format';
import { ROLE_NAMES, type Role } from '../../lib/types';
import { IconPlus } from '../../components/Icons';

interface Person {
  id: string;
  auth_user_id: string | null;
  email: string;
  full_name: string;
  role: Role;
  active: boolean;
  phone: string | null;
  notify_channels: string[];
  has_login: boolean;
  password_set: boolean;
  last_sign_in_at: string | null;
}

const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS' },
  { value: 'whatsapp', label: 'WhatsApp' },
];
const ROLE_TEXT: Record<Role, string> = {
  kam: 'A KAM asks for rates and sees only their own clients and follow-ups.',
  treasury: 'Treasury gives rates and sees every request.',
  manager: 'A manager sees everything and changes nothing.',
  admin: 'An admin also manages people, rules and messages.',
};

function channelText(list: string[] | null) {
  const names = (list ?? []).map((c) => CHANNELS.find((x) => x.value === c)?.label ?? c);
  if (!names.length) return 'No messages';
  return 'Messages by ' + (names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]);
}

export default function People() {
  const { profile } = useAuth();
  const toast = useToast();
  const [people, setPeople] = useState<Person[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inv, setInv] = useState({ full_name: '', email: '', role: 'kam' as Role, phone: '', channels: ['email'] });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [contact, setContact] = useState({ phone: '', channels: ['email'] as string[] });

  const load = useCallback(async () => {
    try {
      const res = await adminUsers<{ people: Person[] }>({ action: 'list' });
      setPeople(res.people ?? []);
    } catch (err) { toast((err as Error).message, 'error'); }
    setLoaded(true);
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inv.email.trim());
  const nameOk = inv.full_name.trim().length >= 2;
  const phoneClean = inv.phone.replace(/[\s-]/g, '');
  const needsPhone = inv.channels.some((c) => c !== 'email');
  const phoneOk = phoneClean === '' ? !needsPhone : /^\+[0-9]{8,15}$/.test(phoneClean);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!emailOk || !nameOk || !phoneOk || !inv.channels.length) return;
    setBusy(true);
    try {
      await adminUsers({ action: 'invite', email: inv.email.trim(), full_name: inv.full_name.trim(), role: inv.role, phone: phoneClean || null, channels: inv.channels });
      toast(`Invite sent to ${inv.email.trim()}. They choose their own password from the email.`);
      setInviting(false); setTried(false);
      setInv({ full_name: '', email: '', role: 'kam', phone: '', channels: ['email'] });
      load();
    } catch (err) { toast((err as Error).message, 'error'); }
    setBusy(false);
  }

  async function act(body: Record<string, unknown>, done: string) {
    try { await adminUsers(body); toast(done); load(); }
    catch (err) { toast((err as Error).message, 'error'); }
  }

  async function saveContact(p: Person) {
    const phone = contact.phone.replace(/[\s-]/g, '');
    await act({ action: 'set_contact', profile_id: p.id, phone: phone || null, channels: contact.channels }, `${p.full_name}: ${channelText(contact.channels).toLowerCase()}.`);
    setEditing(null);
  }

  const status = (p: Person) => {
    if (!p.active) return { text: 'Switched off', cls: 'pill-wait' };
    if (!p.has_login) return { text: 'No login, history only', cls: 'pill-wait' };
    if (!p.password_set) return { text: 'Invited, no password yet', cls: 'pill-warn' };
    return { text: 'Active', cls: 'pill-ok' };
  };

  return (
    <section id="people" className="card flush" aria-labelledby="people-title">
      <div className="card-head" style={{ alignItems: 'center' }}>
        <div>
          <h2 id="people-title" style={{ fontSize: 22 }}>People</h2>
          <p className="small" style={{ color: 'var(--ink-2)' }}>Everyone has their own login. Nobody, including admins, sees another person's password.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setInviting(true)}><IconPlus />Invite a person</button>
      </div>

      {inviting && (
        <form onSubmit={invite} noValidate style={{ margin: '0 24px 18px', padding: 20, borderRadius: 12, background: 'var(--ground)' }}>
          <div className="form-row">
            <div className="field grow"><label htmlFor="inv-name">Full name</label>
              <input id="inv-name" className={'input' + (tried && !nameOk ? ' invalid' : '')} value={inv.full_name} onChange={(e) => setInv({ ...inv, full_name: e.target.value })} /></div>
            <div className="field grow"><label htmlFor="inv-email">Work email</label>
              <input id="inv-email" type="email" className={'input' + (tried && !emailOk ? ' invalid' : '')} placeholder="name@kursi.ge" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
              {tried && !emailOk && <span className="hint error">Enter a work email address</span>}</div>
            <div className="field" style={{ flex: '0 1 200px' }}><label htmlFor="inv-role">Role</label>
              <select id="inv-role" className="select" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value as Role })}>
                {(['kam', 'treasury', 'manager', 'admin'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}
              </select></div>
          </div>
          <div className="form-row" style={{ marginTop: 14 }}>
            <div className="field" style={{ flex: '0 1 260px' }}><label htmlFor="inv-phone">Mobile <span className="muted" style={{ fontWeight: 400 }}>(for SMS or WhatsApp)</span></label>
              <input id="inv-phone" type="tel" className={'input' + (tried && !phoneOk ? ' invalid' : '')} placeholder="+995 5XX XXX XXX" value={inv.phone} onChange={(e) => setInv({ ...inv, phone: e.target.value })} />
              {tried && !phoneOk && <span className="hint error">Add a mobile number with the country code</span>}</div>
            <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="small strong" style={{ fontWeight: 500, marginBottom: 6 }}>Send their messages by</legend>
              <div className="row" style={{ gap: '0 18px' }}>
                {CHANNELS.map((c) => (
                  <label key={c.value} className="checkbox"><input type="checkbox" checked={inv.channels.includes(c.value)}
                    onChange={() => setInv({ ...inv, channels: inv.channels.includes(c.value) ? inv.channels.filter((x) => x !== c.value) : [...inv.channels, c.value] })} />{c.label}</label>
                ))}
              </div>
            </fieldset>
          </div>
          <p className="small" style={{ margin: '12px 0', color: 'var(--ink-2)' }}>{ROLE_TEXT[inv.role]} They get an email and choose their own password.</p>
          <div className="row">
            <button type="submit" className="btn btn-dark" disabled={busy}>{busy ? 'Sending…' : 'Send invite'}</button>
            <button type="button" className="btn btn-quiet" onClick={() => { setInviting(false); setTried(false); }}>Cancel</button>
          </div>
        </form>
      )}

      {!loaded && <p className="empty">Loading…</p>}
      {loaded && (
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 980 }}>
            <thead><tr><th>Person</th><th>Role</th><th>Login</th><th>Last signed in</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {people.map((p) => {
                const st = status(p);
                const me = p.auth_user_id != null && p.id === profile!.id;
                return (
                  <tr key={p.id} style={{ background: p.active ? undefined : '#FBF9FC' }}>
                    <td>
                      <div className="strong" style={{ fontWeight: 500 }}>{p.full_name}</div>
                      <div className="tiny muted">{p.email}{p.phone ? ', ' + p.phone : ''}</div>
                      {editing === p.id ? (
                        <div className="row" style={{ marginTop: 8, gap: 8 }}>
                          <label className="sr-only" htmlFor={'ph-' + p.id}>Mobile</label>
                          <input id={'ph-' + p.id} className="input" style={{ width: 180, minHeight: 40 }} placeholder="+995…" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
                          {CHANNELS.map((c) => (
                            <label key={c.value} className="checkbox small"><input type="checkbox" checked={contact.channels.includes(c.value)}
                              onChange={() => setContact({ ...contact, channels: contact.channels.includes(c.value) ? contact.channels.filter((x) => x !== c.value) : [...contact.channels, c.value] })} />{c.label}</label>
                          ))}
                          <button type="button" className="btn btn-dark" style={{ minHeight: 40 }} onClick={() => saveContact(p)}>Save</button>
                          <button type="button" className="link" onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      ) : (
                        <div className="tiny muted">{channelText(p.notify_channels)}{p.has_login && <> <button type="button" className="link tiny" style={{ minHeight: 0, padding: 0 }} onClick={() => { setEditing(p.id); setContact({ phone: p.phone ?? '', channels: p.notify_channels?.length ? p.notify_channels : ['email'] }); }}>Change</button></>}</div>
                      )}
                    </td>
                    <td>
                      <label className="sr-only" htmlFor={'role-' + p.id}>Role for {p.full_name}</label>
                      <select id={'role-' + p.id} className="select" style={{ width: 'auto', minHeight: 40 }} value={p.role} disabled={me}
                        onChange={(e) => {
                          const role = e.target.value as Role;
                          if (window.confirm(`Make ${p.full_name} ${ROLE_NAMES[role]}?`)) act({ action: 'set_role', profile_id: p.id, role }, `${p.full_name} is now ${ROLE_NAMES[role]}.`);
                        }}>
                        {(['kam', 'treasury', 'manager', 'admin'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}
                      </select>
                    </td>
                    <td><span className={'pill ' + st.cls}>{st.text}</span></td>
                    <td className="muted">{p.last_sign_in_at ? fmtDateTime(p.last_sign_in_at) : 'Never'}</td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                        {me && <span className="small muted">This is you</span>}
                        {!me && !p.has_login && <button type="button" className="btn btn-quiet" style={{ minHeight: 40 }} onClick={() => { setInviting(true); setInv({ full_name: p.full_name.includes('@') ? '' : p.full_name, email: p.email, role: p.role, phone: '', channels: ['email'] }); }}>Invite</button>}
                        {!me && p.has_login && p.active && <button type="button" className="btn btn-quiet" style={{ minHeight: 40 }} onClick={() => act({ action: 'send_password_reset', profile_id: p.id }, `Password reset link sent to ${p.email}.`)}>{p.password_set ? 'Send password reset' : 'Resend invite'}</button>}
                        {!me && p.has_login && (p.active
                          ? <button type="button" className="btn btn-danger" style={{ minHeight: 40 }} onClick={() => window.confirm(`Switch off ${p.full_name}'s login? Their past requests stay in the reports.`) && act({ action: 'deactivate', profile_id: p.id }, `${p.full_name}'s login is switched off.`)}>Switch off</button>
                          : <button type="button" className="btn" style={{ minHeight: 40 }} onClick={() => act({ action: 'reactivate', profile_id: p.id }, `${p.full_name} can sign in again.`)}>Switch on</button>)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
