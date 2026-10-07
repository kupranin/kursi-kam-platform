import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
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
  { value: 'email', label: 'ელფოსტა' },
  { value: 'sms', label: 'SMS' },
  { value: 'whatsapp', label: 'WhatsApp' },
];
const ROLE_TEXT: Record<Role, string> = {
  kam: 'KAM კურსს ითხოვს და ხედავს მხოლოდ თავის კლიენტებსა და დაბრუნებას.',
  treasury: 'სახაზინო კურსს იძლევა და ყველა მოთხოვნას ხედავს.',
  manager: 'მენეჯერი ყველაფერს ხედავს და არაფერს ცვლის.',
  admin: 'ადმინი ასევე მართავს ხალხს, წესებს და შეტყობინებებს.',
};
const MESSAGE_GROUP: Record<Role, string> = {
  kam: 'KAM-ები',
  treasury: 'სახაზინო',
  admin: 'ადმინები',
  manager: 'მენეჯერები',
};

interface InviteReady {
  name: string;
  phone: string;
  channels: string[];
  role: Role;
  link: string;
  message_status: string | null;
  message_channels: string[];
}

function joinLabels(list: string[]) {
  const names = list.map((c) => CHANNELS.find((x) => x.value === c)?.label ?? c);
  if (names.length <= 1) return names[0] ?? '';
  return names.slice(0, -1).join(', ') + ' და ' + names[names.length - 1];
}

function channelText(list: string[] | null) {
  const names = (list ?? []).map((c) => CHANNELS.find((x) => x.value === c)?.label ?? c);
  if (!names.length) return 'შეტყობინება არ არის';
  return 'შეტყობინებები: ' + (names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' და ' + names[names.length - 1]);
}

function textNote(ready: InviteReady) {
  const via = ready.message_channels;
  if (!via.length) return null;
  const how = joinLabels(via);
  const onTheWay = ready.message_status === 'sent' || ready.message_status === 'pending' || ready.message_status === 'delivered';
  if (onTheWay) {
    const verb = ready.message_status === 'delivered' ? 'გაიგზავნა' : 'იგზავნება';
    return <p className="small" style={{ margin: '8px 0 0' }}>იგივე ბმული {how}-ით {verb} ნომერზე {ready.phone}.</p>;
  }
  if (ready.message_status === 'no_webhook') {
    return <p className="small warn-text" style={{ margin: '8px 0 0' }}>{how}-ის შეტყობინება არ გაიგზავნა, რადგან {MESSAGE_GROUP[ready.role]}-ის შეტყობინებები ჯერ არ არის მიერთებული. დააკოპირეთ ბმული და თავად გაუგზავნეთ.</p>;
  }
  return <p className="small warn-text" style={{ margin: '8px 0 0' }}>{how}-ის შეტყობინება ვერ გაიგზავნა ნომერზე {ready.phone}. დააკოპირეთ ბმული და თავად გაუგზავნეთ.</p>;
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
  const [ready, setReady] = useState<InviteReady | null>(null);
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState<{ id: string; name: string; link: string; kind: 'invite' | 'reset' } | null>(null);
  const [shownCopied, setShownCopied] = useState(false);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const shownRow = useRef<HTMLTableRowElement>(null);
  const readyBox = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await adminUsers<{ people: Person[] }>({ action: 'list' });
      setPeople(res.people ?? []);
    } catch (err) { toast((err as Error).message, 'error'); }
    setLoaded(true);
  }, [toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (shown) shownRow.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [shown]);
  useEffect(() => { if (ready) readyBox.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [ready]);

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
      const res = await adminUsers<{ invite_link?: string; message_status?: string | null; message_channels?: string[] }>({
        action: 'invite', email: inv.email.trim(), full_name: inv.full_name.trim(), role: inv.role, phone: phoneClean || null, channels: inv.channels,
      });
      const name = inv.full_name.trim();
      if (!res.invite_link) {
        toast(`${name} დაემატა, მაგრამ ბმული არ დაბრუნდა. ჩასვით განახლებული admin-users ფუნქცია Supabase-ში, შემდეგ გაუგზავნეთ პაროლის აღდგენა, თუ ბმული კვლავ სჭირდებათ.`, 'error');
      } else {
        setReady({
          name,
          phone: phoneClean,
          channels: [...inv.channels],
          role: inv.role,
          link: res.invite_link,
          message_status: res.message_status ?? null,
          message_channels: res.message_channels ?? [],
        });
        setCopied(false);
        toast(`მოწვევა მზადაა: ${name}. დააკოპირეთ ბმული.`);
      }
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

  async function copyText(link: string, mark: (on: boolean) => void) {
    try {
      await navigator.clipboard.writeText(link);
      mark(true);
      window.setTimeout(() => mark(false), 3000);
      return true;
    } catch {
      toast('მონიშნეთ ბმული და დააკოპირეთ.', 'error');
      return false;
    }
  }

  async function copyLink() {
    if (!ready) return;
    await copyText(ready.link, setCopied);
  }

  async function copyInvite(p: Person) {
    setCopyingId(p.id);
    try {
      const res = await adminUsers<{ link?: string }>({ action: 'copy_invite', profile_id: p.id });
      if (!res.link) {
        toast('ბმული არ დაბრუნდა. ჩასვით განახლებული admin-users ფუნქცია Supabase-ში და სცადეთ თავიდან.', 'error');
      } else {
        setShown({ id: p.id, name: p.full_name, link: res.link, kind: 'invite' });
        setShownCopied(false);
        const ok = await copyText(res.link, setShownCopied);
        if (ok) toast(`მოწვევის ბმული დაკოპირდა: ${p.full_name}.`);
      }
    } catch (err) {
      const message = (err as Error).message;
      toast(/unknown action/i.test(message)
        ? 'მოწვევის ბმულის კოპირება სერვერზე ჯერ არ არის. ჩასვით განახლებული admin-users ფუნქცია Supabase-ში, გააშვით და სცადეთ თავიდან.'
        : message, 'error');
    }
    setCopyingId(null);
  }

  async function copyReset(p: Person) {
    setResettingId(p.id);
    try {
      const res = await adminUsers<{ link?: string }>({ action: 'copy_reset', profile_id: p.id });
      if (!res.link) {
        toast('ბმული არ დაბრუნდა. ჩასვით განახლებული admin-users ფუნქცია Supabase-ში და სცადეთ თავიდან.', 'error');
      } else {
        setShown({ id: p.id, name: p.full_name, link: res.link, kind: 'reset' });
        setShownCopied(false);
        const ok = await copyText(res.link, setShownCopied);
        if (ok) toast(`აღდგენის ბმული დაკოპირდა: ${p.full_name}.`);
      }
    } catch (err) {
      const message = (err as Error).message;
      toast(/unknown action/i.test(message)
        ? 'აღდგენის ბმულის კოპირება სერვერზე ჯერ არ არის. ჩასვით განახლებული admin-users ფუნქცია Supabase-ში, გააშვით და სცადეთ თავიდან.'
        : message, 'error');
    }
    setResettingId(null);
  }

  async function saveContact(p: Person) {
    const phone = contact.phone.replace(/[\s-]/g, '');
    await act({ action: 'set_contact', profile_id: p.id, phone: phone || null, channels: contact.channels }, `${p.full_name}: ${channelText(contact.channels).toLowerCase()}.`);
    setEditing(null);
  }

  const status = (p: Person) => {
    if (!p.active) return { text: 'გამორთულია', cls: 'pill-wait' };
    if (!p.has_login) return { text: 'შესვლა არ არის, მხოლოდ ისტორია', cls: 'pill-wait' };
    if (!p.password_set) return { text: 'მოწვეულია, პაროლი ჯერ არ აქვს', cls: 'pill-warn' };
    return { text: 'აქტიური', cls: 'pill-ok' };
  };

  return (
    <section id="people" className="card flush" aria-labelledby="people-title">
      <div className="card-head" style={{ alignItems: 'center' }}>
        <div>
          <h2 id="people-title" style={{ fontSize: 22 }}>ხალხი</h2>
          <p className="small" style={{ color: 'var(--ink-2)' }}>ყველას თავისი შესვლა აქვს. არავინ, ადმინიც, სხვის პაროლს ვერ ხედავს.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setInviting(true)}><IconPlus />ადამიანის მოწვევა</button>
      </div>

      {ready && (
        <div ref={readyBox} role="status" style={{ margin: '0 24px 18px', padding: 20, borderRadius: 12, background: ready.message_channels.length && !['sent', 'pending', 'delivered'].includes(ready.message_status ?? '') ? 'var(--warn-bg)' : 'var(--ok-bg)' }}>
          <h3 style={{ fontSize: 18 }}>მოწვევა მზადაა: {ready.name}</h3>
          <p className="small" style={{ margin: '8px 0 12px', color: 'var(--ink-2)' }}>
            დააკოპირეთ ბმული და გაუგზავნეთ. ისინი გახსნიან და თავად აირჩევენ პაროლს. ბმული ერთხელ მუშაობს.
          </p>
          <div className="field">
            <label htmlFor="invite-link">ბმული</label>
            <textarea id="invite-link" className="input" readOnly rows={3} value={ready.link} onFocus={(e) => e.currentTarget.select()} />
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-dark" onClick={copyLink}>{copied ? 'დაკოპირდა' : 'ბმულის კოპირება'}</button>
            <button type="button" className="btn btn-quiet" onClick={() => setReady(null)}>მზადაა</button>
          </div>
          {ready.channels.includes('email') && (
            <p className="small" style={{ margin: '12px 0 0' }}>
              ეს ბმული Supabase-მა ელფოსტით არ გაუგზავნა. ეს ფოსტა საათში ორი წერილით არის შეზღუდული, ამიტომ დააკოპირეთ ბმული და თავად გაუგზავნეთ.
            </p>
          )}
          {textNote(ready)}
        </div>
      )}

      {inviting && (
        <form onSubmit={invite} noValidate style={{ margin: '0 24px 18px', padding: 20, borderRadius: 12, background: 'var(--ground)' }}>
          <div className="form-row">
            <div className="field grow"><label htmlFor="inv-name">სრული სახელი</label>
              <input id="inv-name" className={'input' + (tried && !nameOk ? ' invalid' : '')} value={inv.full_name} onChange={(e) => setInv({ ...inv, full_name: e.target.value })} /></div>
            <div className="field grow"><label htmlFor="inv-email">სამუშაო ელფოსტა</label>
              <input id="inv-email" type="email" className={'input' + (tried && !emailOk ? ' invalid' : '')} placeholder="name@kursi.ge" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
              {tried && !emailOk && <span className="hint error">შეიყვანეთ სამუშაო ელფოსტა</span>}</div>
            <div className="field" style={{ flex: '0 1 200px' }}><label htmlFor="inv-role">როლი</label>
              <select id="inv-role" className="select" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value as Role })}>
                {(['kam', 'treasury', 'manager', 'admin'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}
              </select></div>
          </div>
          <div className="form-row" style={{ marginTop: 14 }}>
            <div className="field" style={{ flex: '0 1 260px' }}><label htmlFor="inv-phone">მობილური <span className="muted" style={{ fontWeight: 400 }}>(SMS-ისთვის ან WhatsApp-ისთვის)</span></label>
              <input id="inv-phone" type="tel" className={'input' + (tried && !phoneOk ? ' invalid' : '')} placeholder="+995 5XX XXX XXX" value={inv.phone} onChange={(e) => setInv({ ...inv, phone: e.target.value })} />
              {tried && !phoneOk && <span className="hint error">დაამატეთ მობილური ქვეყნის კოდით</span>}</div>
            <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="small strong" style={{ fontWeight: 500, marginBottom: 6 }}>შეტყობინებების გაგზავნა</legend>
              <div className="row" style={{ gap: '0 18px' }}>
                {CHANNELS.map((c) => (
                  <label key={c.value} className="checkbox"><input type="checkbox" checked={inv.channels.includes(c.value)}
                    onChange={() => setInv({ ...inv, channels: inv.channels.includes(c.value) ? inv.channels.filter((x) => x !== c.value) : [...inv.channels, c.value] })} />{c.label}</label>
                ))}
              </div>
            </fieldset>
          </div>
          <p className="small" style={{ margin: '12px 0', color: 'var(--ink-2)' }}>{ROLE_TEXT[inv.role]} მიიღებთ ბმულს დასაკოპირებლად. ისინი გახსნიან და თავად აირჩევენ პაროლს. თუ SMS ან WhatsApp მონიშნულია და მობილური შევსებულია, ბმული ტელეფონზეც გაეგზავნება.</p>
          <div className="row">
            <button type="submit" className="btn btn-dark" disabled={busy}>{busy ? 'ბმული მზადდება…' : 'მოწვევის გაგზავნა'}</button>
            <button type="button" className="btn btn-quiet" onClick={() => { setInviting(false); setTried(false); }}>გაუქმება</button>
          </div>
        </form>
      )}

      {!loaded && <p className="empty">იტვირთება…</p>}
      {loaded && (
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 1120 }}>
            <thead><tr><th>ადამიანი</th><th>როლი</th><th>შესვლა</th><th>ბოლო შესვლა</th><th><span className="sr-only">მოქმედებები</span></th></tr></thead>
            <tbody>
              {people.map((p) => {
                const st = status(p);
                const me = p.auth_user_id != null && p.id === profile!.id;
                const needsLink = !me && p.has_login && !p.password_set;
                return (
                  <Fragment key={p.id}>
                  <tr style={{ background: p.active ? undefined : '#FBF9FC' }}>
                    <td>
                      <div className="strong" style={{ fontWeight: 500 }}>{p.full_name}</div>
                      <div className="tiny muted">{p.email}{p.phone ? ', ' + p.phone : ''}</div>
                      {editing === p.id ? (
                        <div className="row" style={{ marginTop: 8, gap: 8 }}>
                          <label className="sr-only" htmlFor={'ph-' + p.id}>მობილური</label>
                          <input id={'ph-' + p.id} className="input" style={{ width: 180, minHeight: 40 }} placeholder="+995…" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
                          {CHANNELS.map((c) => (
                            <label key={c.value} className="checkbox small"><input type="checkbox" checked={contact.channels.includes(c.value)}
                              onChange={() => setContact({ ...contact, channels: contact.channels.includes(c.value) ? contact.channels.filter((x) => x !== c.value) : [...contact.channels, c.value] })} />{c.label}</label>
                          ))}
                          <button type="button" className="btn btn-dark" style={{ minHeight: 40 }} onClick={() => saveContact(p)}>შენახვა</button>
                          <button type="button" className="link" onClick={() => setEditing(null)}>გაუქმება</button>
                        </div>
                      ) : (
                        <div className="tiny muted">{channelText(p.notify_channels)}{p.has_login && <> <button type="button" className="link tiny" style={{ minHeight: 0, padding: 0 }} onClick={() => { setEditing(p.id); setContact({ phone: p.phone ?? '', channels: p.notify_channels?.length ? p.notify_channels : ['email'] }); }}>შეცვლა</button></>}</div>
                      )}
                    </td>
                    <td>
                      <label className="sr-only" htmlFor={'role-' + p.id}>როლი: {p.full_name}</label>
                      <select id={'role-' + p.id} className="select" style={{ width: 'auto', minHeight: 40 }} value={p.role} disabled={me}
                        onChange={(e) => {
                          const role = e.target.value as Role;
                          if (window.confirm(`${p.full_name} გახდეს ${ROLE_NAMES[role]}?`)) act({ action: 'set_role', profile_id: p.id, role }, `${p.full_name} ახლა ${ROLE_NAMES[role]}ა.`);
                        }}>
                        {(['kam', 'treasury', 'manager', 'admin'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}
                      </select>
                    </td>
                    <td><span className={'pill ' + st.cls}>{st.text}</span></td>
                    <td className="muted">{p.last_sign_in_at ? fmtDateTime(p.last_sign_in_at) : 'არასდროს'}</td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                        {me && <span className="small muted">ეს თქვენ ხართ</span>}
                        {needsLink && <button type="button" className="btn btn-dark" style={{ minHeight: 40 }} disabled={copyingId === p.id || resettingId === p.id} onClick={() => copyInvite(p)}>{copyingId === p.id ? 'ბმული მზადდება…' : 'მოწვევის ბმულის კოპირება'}</button>}
                        {!me && !p.has_login && <button type="button" className="btn btn-quiet" style={{ minHeight: 40 }} onClick={() => { setInviting(true); setInv({ full_name: p.full_name.includes('@') ? '' : p.full_name, email: p.email, role: p.role, phone: '', channels: ['email'] }); }}>მოწვევა</button>}
                        {!me && p.has_login && p.active && <button type="button" className="btn btn-dark" style={{ minHeight: 40 }} disabled={copyingId === p.id || resettingId === p.id} onClick={() => copyReset(p)}>{resettingId === p.id ? 'ბმული მზადდება…' : 'აღდგენის ბმულის კოპირება'}</button>}
                        {!me && p.has_login && p.active && <button type="button" className="btn btn-quiet" style={{ minHeight: 40 }} onClick={() => act({ action: 'send_password_reset', profile_id: p.id }, `პაროლის აღდგენის ბმული გაიგზავნა ${p.email}-ზე.`)}>{p.password_set ? 'პაროლის აღდგენის გაგზავნა' : 'მოწვევის ხელახლა გაგზავნა'}</button>}
                        {!me && p.has_login && (p.active
                          ? <button type="button" className="btn btn-danger" style={{ minHeight: 40 }} onClick={() => window.confirm(`გამოვრთოთ ${p.full_name}-ის შესვლა? წარსული მოთხოვნები ანგარიშებში რჩება.`) && act({ action: 'deactivate', profile_id: p.id }, `${p.full_name}-ის შესვლა გამორთულია.`)}>გამორთვა</button>
                          : <button type="button" className="btn" style={{ minHeight: 40 }} onClick={() => act({ action: 'reactivate', profile_id: p.id }, `${p.full_name}-ს კვლავ შეუძლია შესვლა.`)}>ჩართვა</button>)}
                      </div>
                    </td>
                  </tr>
                  {shown?.id === p.id && (
                    <tr ref={shownRow}>
                      <td colSpan={5}>
                        <div role="status" style={{ margin: '4px 0 8px', padding: 20, borderRadius: 12, background: 'var(--ok-bg)' }}>
                          <h3 style={{ fontSize: 18 }}>{shown.kind === 'reset' ? `აღდგენის ბმული მზადაა: ${shown.name}` : `მოწვევა მზადაა: ${shown.name}`}</h3>
                          <p className="small" style={{ margin: '8px 0 12px', color: 'var(--ink-2)' }}>
                            {shown.kind === 'reset'
                              ? 'დააკოპირეთ ბმული და გაუგზავნეთ. ისინი გახსნიან და ახალ პაროლს აირჩევენ. ბმული ერთხელ მუშაობს. ელფოსტით არ გაგზავნილა.'
                              : 'დააკოპირეთ ბმული და გაუგზავნეთ. ისინი გახსნიან და თავად აირჩევენ პაროლს. ბმული ერთხელ მუშაობს. ელფოსტით არ გაგზავნილა.'}
                          </p>
                          <div className="field">
                            <label htmlFor={(shown.kind === 'reset' ? 'reset-link-' : 'invite-link-') + p.id}>ბმული</label>
                            <textarea id={(shown.kind === 'reset' ? 'reset-link-' : 'invite-link-') + p.id} className="input" readOnly rows={3} value={shown.link} onFocus={(e) => e.currentTarget.select()} />
                          </div>
                          <div className="row" style={{ marginTop: 12 }}>
                            <button type="button" className="btn btn-dark" onClick={() => copyText(shown.link, setShownCopied)}>{shownCopied ? 'დაკოპირდა' : 'ბმულის კოპირება'}</button>
                            <button type="button" className="btn btn-quiet" onClick={() => setShown(null)}>მზადაა</button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
