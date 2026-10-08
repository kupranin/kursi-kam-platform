import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { NAV } from '../lib/nav';
import { rpc, supabase } from '../lib/supabase';
import { fmtDateTime, todayTbilisi } from '../lib/format';
import { useLive } from '../lib/useLive';
import { useViewAs } from '../lib/viewAs';
import LangSwitch from './LangSwitch';
import NotificationBell from './NotificationBell';
import ViewSwitch from './ViewSwitch';

export default function Layout({ children }: { children: ReactNode }) {
  const { profile, signOut } = useAuth();
  const { role, realRole } = useViewAs();
  const { t, roleName } = useI18n();
  const [fresh, setFresh] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ followups: number; queue: number; losses: number }>({ followups: 0, queue: 0, losses: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const items = NAV[role];

  const loadCounts = useCallback(async () => {
    try {
      setFresh(await rpc<string | null>('data_freshness'));
      if (items.some((i) => i.badge === 'queue')) {
        const { count } = await supabase.from('requests').select('id', { count: 'exact', head: true })
          .or('quote_status.eq.asking,and(client_reply.eq.better,better_decision.is.null)');
        setCounts((c) => ({ ...c, queue: count ?? 0 }));
      }
      if (items.some((i) => i.badge === 'losses')) {
        const { count } = await supabase.from('request_outcomes').select('id', { count: 'exact', head: true })
          .eq('loss_open', true);
        setCounts((c) => ({ ...c, losses: count ?? 0 }));
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

  useEffect(() => { loadCounts(); }, [loadCounts]);
  useLive(['requests'], loadCounts, 60000);

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
            {role === 'treasury' && realRole === 'treasury' && <span className="role-tag">{t('სახაზინო', 'Treasury')}</span>}
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
