import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { rpc, supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { useLive } from '../lib/useLive';
import { fmtDateTime } from '../lib/format';
import type { StaffMessage, StaffPerson } from '../lib/types';

const MAX_BODY = 2000;

function preview(body: string): string {
  const one = body.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? one.slice(0, 79) + '…' : one;
}

export default function Chat() {
  const { profile } = useAuth();
  const { role } = useViewAs();
  const { t, roleName } = useI18n();
  const me = profile!.id;
  // Same split as private.can_see_all(): admin and manager. An admin's chosen view follows that split.
  const canSeeAll = role === 'admin' || role === 'manager';

  const [view, setView] = useState<'chat' | 'log'>('chat');
  const [people, setPeople] = useState<StaffPerson[]>([]);
  const [messages, setMessages] = useState<StaffMessage[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const seen = useRef(false);

  const load = useCallback(async () => {
    try {
      const directory = await rpc<StaffPerson[]>('staff_directory');
      const { data, error } = await supabase
        .from('staff_messages')
        .select('id, sender_id, recipient_id, body, created_at')
        .order('created_at', { ascending: true });
      if (error) throw error;
      setPeople(directory ?? []);
      setMessages((data ?? []) as StaffMessage[]);
      setLoadError('');
      seen.current = true;
    } catch {
      if (!seen.current) setLoadError('შეტყობინებები ვერ ჩაიტვირთა.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useLive(['staff_messages'], load);

  const byId = useMemo(() => {
    const map = new Map<string, StaffPerson>();
    people.forEach((p) => map.set(p.id, p));
    return map;
  }, [people]);
  const nameOf = useCallback((id: string) => byId.get(id)?.full_name ?? 'ყოფილი კოლეგა', [byId]);

  const choices = useMemo(
    () => people.filter((p) => p.active && p.id !== me),
    [people, me],
  );

  const partners = useMemo(() => {
    const last = new Map<string, StaffMessage>();
    for (const m of messages) {
      if (m.sender_id !== me && m.recipient_id !== me) continue;
      const other = m.sender_id === me ? m.recipient_id : m.sender_id;
      const prev = last.get(other);
      if (!prev || prev.created_at < m.created_at) last.set(other, m);
    }
    return [...last.entries()].sort((a, b) => (a[1].created_at < b[1].created_at ? 1 : -1));
  }, [messages, me]);

  const conversations = useMemo(() => {
    const last = new Map<string, { key: string; a: string; b: string; last: StaffMessage }>();
    for (const m of messages) {
      const [a, b] = m.sender_id < m.recipient_id
        ? [m.sender_id, m.recipient_id]
        : [m.recipient_id, m.sender_id];
      const key = a + '|' + b;
      const prev = last.get(key);
      if (!prev || prev.last.created_at < m.created_at) last.set(key, { key, a, b, last: m });
    }
    return [...last.values()].sort((a, b) => (a.last.created_at < b.last.created_at ? 1 : -1));
  }, [messages]);

  const showingLog = canSeeAll && view === 'log';
  const thread = useMemo(() => {
    if (!selected) return [];
    if (showingLog) {
      const [a, b] = selected.split('|');
      return messages.filter((m) =>
        (m.sender_id === a && m.recipient_id === b) || (m.sender_id === b && m.recipient_id === a));
    }
    return messages.filter((m) =>
      (m.sender_id === me && m.recipient_id === selected) || (m.sender_id === selected && m.recipient_id === me));
  }, [messages, selected, showingLog, me]);

  const threadEnd = thread.length ? thread[thread.length - 1].id : 0;
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [threadEnd, selected, showingLog]);

  function openChat(id: string) {
    setSelected(id);
    setDraft('');
    setSendError('');
  }

  function switchView(next: 'chat' | 'log') {
    setView(next);
    setSelected(null);
    setDraft('');
    setSendError('');
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || text.length > MAX_BODY || !selected || showingLog || sending) return;
    setSending(true);
    setSendError('');
    const { error } = await supabase.from('staff_messages').insert({
      sender_id: me,
      recipient_id: selected,
      body: text,
    });
    setSending(false);
    if (error) {
      setSendError('შეტყობინება არ გაიგზავნა.');
      return;
    }
    setDraft('');
    await load();
  }

  const person = selected && !showingLog ? byId.get(selected) : undefined;
  const canSend = Boolean(person?.active);
  const logPair = showingLog && selected ? conversations.find((c) => c.key === selected) : undefined;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{showingLog ? t('შეტყობინებების ჟურნალი', 'Message log') : t('ჩატი', 'Chat')}</h1>
          <p>{showingLog
            ? 'ყველა შეტყობინება, რომელიც პლატფორმაზე გაიგზავნა. ეს ჩანაწერია.'
            : 'გაუგზავნეთ შეტყობინება გუნდის წევრს.'}</p>
        </div>
      </div>

      {canSeeAll && (
        <nav className="page-links" aria-label="ჩატი">
          <button type="button" className={view === 'chat' ? 'active' : ''} onClick={() => switchView('chat')}>თქვენი ჩატები</button>
          <button type="button" className={view === 'log' ? 'active' : ''} onClick={() => switchView('log')}>შეტყობინებების ჟურნალი</button>
        </nav>
      )}

      {!loaded && <p className="muted">იტვირთება…</p>}
      {loaded && loadError && !people.length && <p className="alert-box" role="alert">{loadError}</p>}

      {loaded && !loadError && showingLog && (
        <div className="chat-layout">
          <section className="card flush chat-people" aria-labelledby="log-list-title">
            <div className="card-head">
              <h2 id="log-list-title">საუბრები</h2>
            </div>
            {!conversations.length && <p className="empty">შეტყობინება ჯერ არ არის.</p>}
            <div className="chat-people-list">
              {conversations.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={selected === c.key ? 'person active' : 'person'}
                  aria-pressed={selected === c.key}
                  onClick={() => setSelected(c.key)}
                >
                  <span className="strong">{nameOf(c.a)} და {nameOf(c.b)}</span>
                  <span className="chat-preview">{nameOf(c.last.sender_id)}: {preview(c.last.body)}</span>
                  <time className="tiny muted" dateTime={c.last.created_at}>{fmtDateTime(c.last.created_at)}</time>
                </button>
              ))}
            </div>
          </section>

          <section className="card" aria-label="შეტყობინებების ჟურნალი">
            {!logPair && <p className="empty">{conversations.length ? 'გახსენით საუბარი წასაკითხად.' : 'შეტყობინება ჯერ არ არის.'}</p>}
            {logPair && (
              <>
                <div className="card-head">
                  <div>
                    <h2>{nameOf(logPair.a)} და {nameOf(logPair.b)}</h2>
                    <p className="small muted">ეს ჩანაწერია. შეტყობინებები ისე რჩება, როგორც გაიგზავნა.</p>
                  </div>
                </div>
                <div className="chat-stream" ref={streamRef} role="log" aria-label="შეტყობინებები">
                  {thread.map((m) => (
                    <div key={m.id} className="chat-line">
                      <div className="row-between">
                        <span className="strong">{nameOf(m.sender_id)}</span>
                        <time className="tiny muted" dateTime={m.created_at}>{fmtDateTime(m.created_at)}</time>
                      </div>
                      <p className="chat-body">{m.body}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {loaded && !loadError && !showingLog && (
        <div className="chat-layout">
          <section className="card flush chat-people" aria-labelledby="chat-with">
            <div className="card-head">
              <h2 id="chat-with">ხალხი</h2>
            </div>
            <div className="chat-pick">
              {!choices.length && <p className="small muted" style={{ margin: 0 }}>ჯერ სხვა არავინაა, ვისაც მისწერთ.</p>}
              {choices.length > 0 && (
                <div className="field">
                  <label htmlFor="chat-to">ახალი შეტყობინება</label>
                  <select
                    id="chat-to"
                    className="select"
                    value={choices.some((c) => c.id === selected) ? selected! : ''}
                    onChange={(e) => { if (e.target.value) openChat(e.target.value); }}
                  >
                    <option value="">აირჩიეთ ადამიანი</option>
                    {choices.map((p) => (
                      <option key={p.id} value={p.id}>{p.full_name} ({roleName(p.role)})</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {!partners.length && choices.length > 0 && <p className="empty">საუბარი ჯერ არ არის.</p>}
            <div className="chat-people-list">
              {partners.map(([id, last]) => (
                <button
                  key={id}
                  type="button"
                  className={selected === id ? 'person active' : 'person'}
                  aria-pressed={selected === id}
                  onClick={() => openChat(id)}
                >
                  <span className="strong">{nameOf(id)}</span>
                  <span className="chat-preview">{preview(last.body)}</span>
                  <time className="tiny muted" dateTime={last.created_at}>{fmtDateTime(last.created_at)}</time>
                </button>
              ))}
            </div>
          </section>

          <section className="card" aria-label="საუბარი">
            {!selected && <p className="empty">აირჩიეთ ადამიანი საუბრის დასაწყებად.</p>}
            {selected && (
              <>
                <div className="card-head">
                  <div>
                    <h2>{nameOf(selected)}</h2>
                    {person && <p className="small muted">{roleName(person.role)}{person.active ? '' : ' · აღარ არის აქტიური'}</p>}
                  </div>
                </div>
                <div className="chat-stream" ref={streamRef} role="log" aria-label="შეტყობინებები">
                  {!thread.length && <p className="empty">შეტყობინება ჯერ არ არის.</p>}
                  {thread.map((m) => (
                    <div key={m.id} className={'chat-msg' + (m.sender_id === me ? ' mine' : '')}>
                      <div className="row-between">
                        <span className="strong">{nameOf(m.sender_id)}</span>
                        <time className="tiny muted" dateTime={m.created_at}>{fmtDateTime(m.created_at)}</time>
                      </div>
                      <p className="chat-body">{m.body}</p>
                    </div>
                  ))}
                </div>
                {canSend ? (
                  <form onSubmit={send}>
                    <div className="chat-compose">
                      <div className="field">
                        <label htmlFor="chat-body">შეტყობინება</label>
                        <textarea
                          id="chat-body"
                          className="input"
                          rows={3}
                          maxLength={MAX_BODY}
                          value={draft}
                          placeholder="დაწერეთ შეტყობინება"
                          onChange={(e) => { setDraft(e.target.value); setSendError(''); }}
                        />
                      </div>
                      <button type="submit" className="btn btn-primary" disabled={sending || draft.trim() === ''}>
                        {sending ? 'იგზავნება…' : 'გაგზავნა'}
                      </button>
                    </div>
                    {sendError && <p className="alert-box" role="alert">{sendError}</p>}
                  </form>
                ) : (
                  <p className="small muted">ამ ადამიანს შეტყობინება ვერ მიუვა.</p>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
