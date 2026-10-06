import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { rpc, supabase } from '../lib/supabase';
import { fmtDateTime, todayTbilisi } from '../lib/format';
import { useLive } from '../lib/useLive';
import { ROLE_NAMES, type Role } from '../lib/types';

const NAV: Record<Role, { to: string; label: string; badge?: 'followups' | 'queue' }[]> = {
  kam: [
    { to: '/requests', label: 'Requests' },
    { to: '/follow-ups', label: 'Follow-ups', badge: 'followups' },
    { to: '/clients', label: 'My clients' },
    { to: '/team', label: 'My numbers' },
  ],
  treasury: [{ to: '/rate-desk', label: 'Rate desk', badge: 'queue' }],
  admin: [
    { to: '/team', label: 'Team' },
    { to: '/rate-desk', label: 'Rate desk', badge: 'queue' },
    { to: '/follow-ups', label: 'Follow-ups' },
    { to: '/clients', label: 'Clients' },
    { to: '/analytics', label: 'Analytics' },
    { to: '/admin', label: 'Admin' },
  ],
  manager: [
    { to: '/team', label: 'Team' },
    { to: '/follow-ups', label: 'Follow-ups' },
    { to: '/clients', label: 'Clients' },
    { to: '/analytics', label: 'Analytics' },
  ],
};

export default function Layout({ children }: { children: ReactNode }) {
  const { profile, signOut } = useAuth();
  const [fresh, setFresh] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ followups: number; queue: number }>({ followups: 0, queue: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const role = profile!.role;
  const items = NAV[role];

  const loadCounts = useCallback(async () => {
    try {
      setFresh(await rpc<string | null>('data_freshness'));
      if (items.some((i) => i.badge === 'queue')) {
        const { count } = await supabase.from('requests').select('id', { count: 'exact', head: true }).eq('quote_status', 'asking');
        setCounts((c) => ({ ...c, queue: count ?? 0 }));
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
            {role === 'treasury' && <span className="role-tag">Treasury</span>}
          </Link>
          <nav className="nav" aria-label="Main">
            {items.map((i) => (
              <NavLink key={i.to} to={i.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                {i.label}
                {i.badge && counts[i.badge] > 0 && <span className="badge">{counts[i.badge]}</span>}
              </NavLink>
            ))}
          </nav>
          <div className="topbar-right">
            <span className="freshness">{fresh ? 'Transactions updated ' + fmtDateTime(fresh) : 'Transactions not synced yet'}</span>
            <div className="user-menu" ref={menuRef}>
              <button type="button" className="avatar" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={'Signed in as ' + profile!.full_name} onClick={() => setMenuOpen((o) => !o)}>
                {initials}
              </button>
              {menuOpen && (
                <div className="menu" role="menu">
                  <div className="menu-head">
                    <div className="strong">{profile!.full_name}</div>
                    <div className="tiny muted">{ROLE_NAMES[role]}, {profile!.email}</div>
                  </div>
                  <Link to="/security" role="menuitem" onClick={() => setMenuOpen(false)}>Password and sign-in</Link>
                  <button type="button" role="menuitem" onClick={signOut}>Sign out</button>
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
