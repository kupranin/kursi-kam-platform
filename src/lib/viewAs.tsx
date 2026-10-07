import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useAuth } from './auth';
import type { Role } from './types';

const KEY = 'kursi-view-as';
const VIEWS: Role[] = ['admin', 'treasury', 'kam', 'manager'];

interface ViewAs {
  /** Screens and actions follow this role. For an admin it can differ from the database role. */
  role: Role;
  realRole: Role;
  setView: (next: Role) => void;
}

const Ctx = createContext<ViewAs | null>(null);

function readStored(): Role {
  try {
    const value = sessionStorage.getItem(KEY);
    if (value && VIEWS.includes(value as Role)) return value as Role;
  } catch {
    /* sessionStorage can be blocked */
  }
  return 'admin';
}

export function ViewAsProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const [picked, setPicked] = useState<Role>(readStored);
  const realRole: Role = profile?.role ?? 'kam';
  const role: Role = profile?.role === 'admin' ? picked : realRole;

  const setView = useCallback((next: Role) => {
    if (profile?.role !== 'admin' || !VIEWS.includes(next)) return;
    setPicked(next);
    try { sessionStorage.setItem(KEY, next); } catch { /* keep the choice for this render */ }
  }, [profile?.role]);

  return <Ctx.Provider value={{ role, realRole, setView }}>{children}</Ctx.Provider>;
}

export function useViewAs() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useViewAs outside ViewAsProvider');
  return ctx;
}
