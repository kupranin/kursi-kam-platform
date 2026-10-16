import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { NAV, PHONE_NAV, type PhoneBadge } from '../lib/nav';
import { ScreenTitleContext } from '../lib/screenTitle';
import { usePhone, usePhoneKeyboard } from '../lib/usePhone';
import TabIcon from './mobile/TabIcon';
import { countPendingLosses } from '../lib/pendingLoss';
import {
  loadChatNames,
  loadIncomingChats,
  onChatOpen,
  onChatRead,
  openChatPartner,
  readChatMarks,
} from '../lib/chatNotice';
import { supabase } from '../lib/supabase';
import { todayTbilisi } from '../lib/format';
import { deferWriteReady } from '../lib/deferWrite';
import { useToast } from '../lib/toast';
import { useLive } from '../lib/useLive';
import { useViewAs } from '../lib/viewAs';
import { ensurePushWorker, listenForPushOpen, syncPushLang } from '../lib/push';
import LangSwitch from './LangSwitch';
import NotificationBell from './NotificationBell';
import ViewSwitch from './ViewSwitch';

export default function Layout({ children }: { children: ReactNode }) {
  const { profile, signOut } = useAuth();
  const { role, realRole } = useViewAs();
  const { t, lang, roleName } = useI18n();
  const toast = useToast();
  const location = useLocation();
  const [titleOverride, setTitleOverride] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<PhoneBadge, number>>({ followups: 0, queue: 0, losses: 0, chat: 0, action: 0 });
  const chatReady = useRef(false);
  const toasted = useRef<Set<number>>(new Set());
  const chatNames = useRef<Map<string, string>>(new Map());
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  usePhoneKeyboard(phone);
  const items = phone ? PHONE_NAV[role] : NAV[role];
  const headerRef = useRef<HTMLElement>(null);
  const tabRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!phone) {
      root.style.removeProperty('--tabbar-h');
      root.style.removeProperty('--header-h');
      return;
    }
    const publish = () => {
      const header = headerRef.current;
      const tab = tabRef.current;
      const keyboard = root.classList.contains('kb-open');
      const tabHeight = !keyboard && tab ? tab.getBoundingClientRect().height : 0;
      const headerHeight = header ? header.getBoundingClientRect().height : 0;
      root.style.setProperty('--tabbar-h', Math.ceil(tabHeight) + 'px');
      root.style.setProperty('--header-h', Math.ceil(headerHeight) + 'px');
    };
    publish();
    const observed = new ResizeObserver(publish);
    const box = { box: 'border-box' } as const;
    if (headerRef.current) observed.observe(headerRef.current, box);
    if (tabRef.current) observed.observe(tabRef.current, box);
    const classes = new MutationObserver(publish);
    classes.observe(root, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', publish);
    return () => {
      observed.disconnect();
      classes.disconnect();
      window.removeEventListener('resize', publish);
    };
  }, [phone, role]);

  const loadCounts = useCallback(async () => {
    try {
      if (items.some((i) => i.badge === 'queue')) {
        const holdOff = await deferWriteReady();
        const approved = holdOff
          ? 'and(client_reply.eq.approved,rate_write_deferred.eq.false)'
          : 'client_reply.eq.approved';
        const queueCount = supabase.from('requests').select('id', { count: 'exact', head: true })
          .eq('source', 'app')
          .is('rate_written_at', null)
          .is('payment_confirmed_at', null)
          .or(`quote_status.eq.asking,and(client_reply.eq.better,better_decision.is.null),${approved}`);
        const withLost = await queueCount.is('marked_lost_at', null);
        const counted = withLost.error
          ? await supabase.from('requests').select('id', { count: 'exact', head: true })
            .eq('source', 'app')
            .is('rate_written_at', null)
            .is('payment_confirmed_at', null)
            .or(`quote_status.eq.asking,and(client_reply.eq.better,better_decision.is.null),${approved}`)
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
      if (items.some((i) => i.badge === 'action') && profile) {
        const { count, error } = await supabase.from('request_active').select('id', { count: 'exact', head: true })
          .eq('kam_id', profile.id)
          .eq('quote_status', 'quoted')
          .is('client_reply', null)
          .is('marked_lost_at', null)
          .gt('rate_valid_until', new Date().toISOString());
        if (!error) setCounts((c) => ({ ...c, action: count ?? 0 }));
      }
    } catch {
      /* the header keeps its last values */
    }
  }, [items, profile, phone]);

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

  useEffect(() => {
    void ensurePushWorker();
    return listenForPushOpen();
  }, []);
  useEffect(() => { void syncPushLang(lang); }, [lang]);
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
  const screenTitle = titleOverride || phoneScreenTitle(location.pathname, role, t);

  return (
    <ScreenTitleContext.Provider value={setTitleOverride}>
      <header ref={headerRef} className={'topbar' + (role === 'treasury' ? ' treasury' : '')}>
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <span className="brand-mark">K</span>
            <span className="brand-full">kursi business</span>
            <span className="brand-short">kursi</span>
            {role !== 'admin' && realRole === 'admin' && <span className="role-tag">{roleName(role)}</span>}
            {role === 'treasury' && realRole === 'treasury' && <span className="role-tag">{t('ხაზინა', 'Treasury')}</span>}
          </Link>
          {phone && screenTitle && <p className="phone-title">{screenTitle}</p>}
          {!phone && (
            <nav className="nav" aria-label={t('მთავარი', 'Main')}>
              {items.map((i) => (
                <NavLink key={i.to} to={i.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                  {t(i.ka, i.en)}
                  {i.badge && counts[i.badge] > 0 && <span className="badge">{counts[i.badge]}</span>}
                </NavLink>
              ))}
            </nav>
          )}
          <div className="topbar-right">
            {!phone && <ViewSwitch />}
            {!phone && <LangSwitch />}
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
                  {phone && (
                    <div className="menu-lang" role="none">
                      <LangSwitch onPage />
                    </div>
                  )}
                  <Link to="/security" role="menuitem" onClick={() => setMenuOpen(false)}>{t('პაროლი და შესვლა', 'Password and sign-in')}</Link>
                  <button type="button" role="menuitem" onClick={signOut}>{t('გასვლა', 'Sign out')}</button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>
      <main className="page">{children}</main>
      {phone && PHONE_NAV[role].length > 0 && (
        <nav ref={tabRef} className="tabbar" aria-label={t('მთავარი', 'Main')}>
          {PHONE_NAV[role].map((i) => {
            const on = tabSelected(i.to, location.pathname);
            return (
              <Link key={i.to} to={i.to} className={on ? 'active' : ''} aria-current={on ? 'page' : undefined}>
                {i.icon && <TabIcon name={i.icon} />}
                <span className="tabbar-label">{t(i.ka, i.en)}</span>
                {i.badge && counts[i.badge] > 0 && <span className="badge">{counts[i.badge]}</span>}
              </Link>
            );
          })}
        </nav>
      )}
    </ScreenTitleContext.Provider>
  );
}

function tabSelected(to: string, path: string): boolean {
  if (to === '/requests/new') return path === '/requests/new';
  if (to === '/requests') return path === '/requests' || path === '/requests/history' || /^\/requests\/\d+$/.test(path);
  if (to === '/rate-desk') return path === '/rate-desk' || path.startsWith('/rate-desk/');
  if (to === '/more') {
    return path === '/more'
      || path === '/rates'
      || path === '/clients'
      || path === '/follow-ups'
      || path === '/lost-requests'
      || path === '/quoted-progress'
      || path === '/desk-history'
      || path === '/log'
      || path === '/security';
  }
  return path === to;
}

function phoneScreenTitle(path: string, role: string, t: (ka: string, en: string) => string): string {
  if (path === '/security') return t('პაროლი და შესვლა', 'Password and sign-in');
  if (path.startsWith('/rate-desk/')) return t('მაგიდა', 'Desk');
  if (role === 'kam') {
    if (path === '/requests/new') return t('ახალი მოთხოვნა', 'New request');
    if (path === '/requests/history') return t('წინა მოთხოვნები', 'Earlier requests');
    if (path === '/requests' || /^\/requests\/\d+$/.test(path)) return t('საქმე', 'Home');
    if (path === '/more') return t('სხვა', 'More');
    if (path === '/chat') return t('ჩატი', 'Chat');
    if (path === '/rates') return t('კურსები', 'Rates');
    if (path === '/clients') return t('კლიენტები', 'Clients');
    if (path === '/follow-ups') return t('დაბრუნება', 'Follow-ups');
  }
  const phoneItem = PHONE_NAV[role as keyof typeof PHONE_NAV]?.find((entry) => entry.to === path);
  if (phoneItem) return t(phoneItem.ka, phoneItem.en);
  const deskItem = NAV[role as keyof typeof NAV]?.find((entry) => entry.to === path);
  return deskItem ? t(deskItem.ka, deskItem.en) : '';
}
