import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { NAV } from '../lib/nav';
import { countPendingLosses } from '../lib/pendingLoss';
import {
  loadChatNames,
  loadIncomingChats,
  onChatOpen,
  onChatRead,
  openChatPartner,
  readChatMarks,
} from '../lib/chatNotice';
import { rpc, supabase } from '../lib/supabase';
import { fmtDateTime, todayTbilisi } from '../lib/format';
import { useToast } from '../lib/toast';
import { useLive } from '../lib/useLive';
import { useViewAs } from '../lib/viewAs';
import LangSwitch from './LangSwitch';
import NotificationBell from './NotificationBell';
import ViewSwitch from './ViewSwitch';

export default function Layout({ children }: { children: ReactNode }) {
  const { profile, signOut } = useAuth();
  const { role, realRole } = useViewAs();
  const { t, roleName } = useI18n();
  const toast = useToast();
  const [fresh, setFresh] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ followups: number; queue: number; losses: number; chat: number }>({ followups: 0, queue: 0, losses: 0, chat: 0 });
  const chatReady = useRef(false);
  const toasted = useRef<Set<number>>(new Set());
  const chatNames = useRef<Map<string, string>>(new Map());
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const items = NAV[role];

  const loadCounts = useCallback(async () => {
    try {
      setFresh(await rpc<string | null>('data_freshness'));
      if (items.some((i) => i.badge === 'queue')) {
        const queueCount = supabase.from('requests').select('id', { count: 'exact', head: true })
          .eq('source', 'app')
          .is('rate_written_at', null)
          .is('payment_confirmed_at', null)
          .or('quote_status.eq.asking,and(client_reply.eq.better,better_decision.is.null),client_reply.eq.approved');
        const withLost = await queueCount.is('marked_lost_at', null);
        const counted = withLost.error
          ? await supabase.from('requests').select('id', { count: 'exact', head: true })
            .eq('source', 'app')
            .is('rate_written_at', null)
            .is('payment_confirmed_at', null)
            .or('quote_status.eq.asking,and(client_reply.eq.better,better_decision.is.null),client_reply.eq.approved')
          : withLost;
        setCounts((c) => ({ ...c, queue: counted.count ?? 0 }));
      }
      if (items.some((i) => i.badge === 'losses')) {
        const losses = await countPendingLosses();
        setCounts((c) => ({ ...c, losses }));
      }
      if (items.some((i) => i.badge === 'followups')) {
        const { count } = await supabase.from('request_outcomes').select('id', { count: 'exact', head: true })
          .eq('kam_id', profile!.id).eq('outcome', 'did_not_go_through').is('loss_reason', null)
          .gte('request_date', todayTbilisi(-7));
        setCounts((c) => ({ ...c, followups: count ?? 0 }));
      }
    } catch {
      /* the header keeps its last values */
    }
  }, [items, profile]);

  const loadChat = useCallback(async () => {
    if (!profile || !items.some((item) => item.badge === 'chat')) return;
    try {
      const incoming = await loadIncomingChats(profile.id);
      if (chatNames.current.size === 0) {
        try { chatNames.current = await loadChatNames(); } catch { /* the toast can say “a colleague” */ }
      }
      const marks = readChatMarks(profile.id);
      const open = openChatPartner();
      const unread = incoming.filter((message) => {
        if (open && message.sender_id === open) return false;
        return message.id > (marks[message.sender_id] ?? 0);
      });
      setCounts((current) => ({ ...current, chat: unread.length }));
      if (!chatReady.current) {
        incoming.forEach((message) => toasted.current.add(message.id));
        chatReady.current = true;
        return;
      }
      const freshMessages = unread.filter((message) => !toasted.current.has(message.id));
      freshMessages.forEach((message) => toasted.current.add(message.id));
      if (freshMessages.length === 1) {
        const message = freshMessages[0];
        const who = chatNames.current.get(message.sender_id) ?? t('კოლეგა', 'A colleague');
        const text = message.body.replace(/\s+/g, ' ').trim();
        const preview = text.length > 80 ? text.slice(0, 79) + '…' : text;
        toast(t('{name} გწერთ: {text}', '{name} wrote to you: {text}', { name: who, text: preview }));
      } else if (freshMessages.length > 1) {
        toast(t('{n} ახალი შეტყობინება ჩატში', '{n} new chat messages', { n: freshMessages.length }));
      }
    } catch {
      /* the chat badge keeps its last count */
    }
  }, [items, profile, t, toast]);

  useEffect(() => { loadCounts(); }, [loadCounts]);
  useEffect(() => { loadChat(); }, [loadChat]);
  useEffect(() => onChatRead(() => { void loadChat(); }), [loadChat]);
  useEffect(() => onChatOpen(() => { void loadChat(); }), [loadChat]);
  // Badge counts stay on a slow poll. They do not run on every requests change.
  // The waiting list itself stays on the rate desk's own 3-second check.
  useLive(['requests'], loadCounts, 60000, { realtime: false });
  useLive(['staff_messages'], loadChat, 10000);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const initials = profile!.full_name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  return (
    <>
      <header className={'topbar' + (role === 'treasury' ? ' treasury' : '')}>
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <span className="brand-mark">K</span>
            <span>kursi business</span>
            {role !== 'admin' && realRole === 'admin' && <span className="role-tag">{roleName(role)}</span>}
            {role === 'treasury' && realRole === 'treasury' && <span className="role-tag">{t('ხაზინა', 'Treasury')}</span>}
          </Link>
          <nav className="nav" aria-label={t('მთავარი', 'Main')}>
            {items.map((i) => (
              <NavLink key={i.to} to={i.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                {t(i.ka, i.en)}
                {i.badge && counts[i.badge] > 0 && <span className="badge">{counts[i.badge]}</span>}
              </NavLink>
            ))}
          </nav>
          <div className="topbar-right">
            <ViewSwitch />
            <LangSwitch />
            <span className="freshness">{fresh ? t('ტრანზაქციები განახლდა {when}', 'Transactions updated {when}', { when: fmtDateTime(fresh) }) : t('ტრანზაქციები ჯერ არ არის სინქრონიზებული', 'Transactions are not synced yet')}</span>
            <NotificationBell />
            <div className="user-menu" ref={menuRef}>
              <button type="button" className="avatar" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t('შესული ხართ: {name}', 'Signed in as {name}', { name: profile!.full_name })} onClick={() => setMenuOpen((o) => !o)}>
                {initials}
              </button>
              {menuOpen && (
                <div className="menu" role="menu">
                  <div className="menu-head">
                    <div className="strong">{profile!.full_name}</div>
                    <div className="tiny muted">{realRole === 'admin' && role !== 'admin' ? t('ადმინი, ახლა {view}', 'Admin, now {view}', { view: roleName(role) }) : roleName(realRole)}, {profile!.email}</div>
                  </div>
                  <Link to="/security" role="menuitem" onClick={() => setMenuOpen(false)}>{t('პაროლი და შესვლა', 'Password and sign-in')}</Link>
                  <button type="button" role="menuitem" onClick={signOut}>{t('გასვლა', 'Sign out')}</button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
