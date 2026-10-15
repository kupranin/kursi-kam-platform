import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, rpc } from './supabase';
import type { Profile } from './types';

interface AuthState {
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  /** True when the profile lookup failed (database down, timeout, network). False when the lookup succeeded, even if no active profile came back. */
  profileUnavailable: boolean;
  needsSecondFactor: boolean;
  recovering: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileUnavailable, setProfileUnavailable] = useState(false);
  const [needsSecondFactor, setNeedsSecondFactor] = useState(false);
  const [recovering, setRecovering] = useState(false);

  const load = useCallback(async (s: Session | null) => {
    setSession(s);
    if (!s) {
      setProfile(null);
      setProfileUnavailable(false);
      setNeedsSecondFactor(false);
      setLoading(false);
      return;
    }
    try {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      setNeedsSecondFactor(Boolean(aal && aal.currentLevel === 'aal1' && aal.nextLevel === 'aal2'));
      const rows = await rpc<Profile[]>('my_profile');
      setProfile(rows && rows.length ? rows[0] : null);
      setProfileUnavailable(false);
    } catch {
      // A failed lookup is not the same as a missing or switched-off account.
      setProfile(null);
      setProfileUnavailable(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => load(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      if (event === 'TOKEN_REFRESHED') {
        setSession(s);
        return;
      }
      // run outside the callback, as Supabase recommends
      setTimeout(() => load(s), 0);
    });
    return () => sub.subscription.unsubscribe();
  }, [load]);

  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    await load(data.session);
  }, [load]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setRecovering(false);
  }, []);

  return (
    <AuthContext.Provider value={{ loading, session, profile, profileUnavailable, needsSecondFactor, recovering, refresh, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

/** Fixture sign-in for a local phone preview. Not used by the app. */
export function PreviewAuth({ children }: { children: ReactNode }) {
  const value: AuthState = {
    loading: false,
    session: { user: { id: 'preview-kam' } } as Session,
    profile: { id: 'preview-kam', full_name: 'ნინო ბერიძე', email: 'nino@kursi.ge', role: 'kam' },
    profileUnavailable: false,
    needsSecondFactor: false,
    recovering: false,
    refresh: async () => {},
    signOut: async () => {},
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
