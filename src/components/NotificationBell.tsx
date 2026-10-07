import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useLive } from '../lib/useLive';
import { fmtDateTime } from '../lib/format';

interface Note {
  id: number;
  audience: string;
  profile_id: string | null;
  event_type: string;
  request_id: number | null;
  title_ka: string;
  title_en: string;
  body_ka: string;
  body_en: string;
  created_at: string;
}

export default function NotificationBell() {
  const { profile } = useAuth();
  const { lang, t } = useI18n();
  const me = profile!.id;
  const role = profile!.role;
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [read, setRead] = useState<Set<number>>(new Set());
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('user_notifications')
      .select('id, audience, profile_id, event_type, request_id, title_ka, title_en, body_ka, body_en, created_at')
      .order('created_at', { ascending: false })
      .limit(40);
    if (error) return;
    const rows = (data ?? []) as Note[];
    const visible = rows.filter((n) => {
      if (role === 'admin') return true;
      if (role === 'manager') return n.audience === 'manager' || n.profile_id === me;
      return true;
    });
    setNotes(visible);
    const { data: marks } = await supabase
      .from('user_notification_reads')
      .select('notification_id')
      .eq('profile_id', me);
    setRead(new Set((marks ?? []).map((m: { notification_id: number }) => m.notification_id)));
  }, [me, role]);

  useEffect(() => { load(); }, [load]);
  useLive(['user_notifications'], load, 30000);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  async function mark(id: number) {
    setRead((prev) => new Set(prev).add(id));
    await supabase.from('user_notification_reads').upsert({
      notification_id: id,
      profile_id: me,
      read_at: new Date().toISOString(),
    }, { onConflict: 'notification_id,profile_id' });
  }

  async function markAll() {
    const unread = notes.filter((n) => !read.has(n.id));
    if (!unread.length) return;
    setRead(new Set(notes.map((n) => n.id)));
    await supabase.from('user_notification_reads').upsert(
      unread.map((n) => ({ notification_id: n.id, profile_id: me, read_at: new Date().toISOString() })),
      { onConflict: 'notification_id,profile_id' },
    );
  }

  const unread = notes.filter((n) => !read.has(n.id)).length;
  const href = (n: Note) => {
    if (role === 'kam') return '/requests';
    if (role === 'treasury') return '/rate-desk';
    if (n.event_type === 'client.approved') return '/requests';
    return '/log';
  };

  return (
    <div className="bell" ref={box}>
      <button type="button" className="bell-btn" aria-expanded={open} aria-label={t('შეტყობინებები', 'Notifications')} onClick={() => setOpen((v) => !v)}>
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M6 9a6 6 0 1 1 12 0c0 7 3 7 3 7H3s3 0 3-7" />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </svg>
        {unread > 0 && <span className="badge">{unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="menu">
          <div className="menu-head row-between">
            <span className="strong">{t('შეტყობინებები', 'Notifications')}</span>
            {unread > 0 && <button type="button" className="link" onClick={markAll}>{t('ყველას წაკითხვა', 'Mark all read')}</button>}
          </div>
          {!notes.length && <p className="empty">{t('შეტყობინება ჯერ არ არის.', 'No notifications yet.')}</p>}
          {notes.map((n) => (
            <Link key={n.id} to={href(n)} className={'bell-item' + (read.has(n.id) ? '' : ' unread')} onClick={() => { mark(n.id); setOpen(false); }}>
              <span className="strong">{lang === 'en' ? n.title_en : n.title_ka}</span>
              <span className="small">{lang === 'en' ? n.body_en : n.body_ka}</span>
              <time className="tiny muted" dateTime={n.created_at}>{fmtDateTime(n.created_at)}</time>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
