import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

/**
 * Calls `reload` when rows change in the given tables (Supabase Realtime),
 * and also every `pollMs` and when the window gets focus, as a safety net.
 */
export function useLive(tables: string[], reload: () => void, pollMs = 20000) {
  const ref = useRef(reload);
  ref.current = reload;
  const key = tables.join(',');

  useEffect(() => {
    const channel = supabase.channel('live-' + key + '-' + Math.random().toString(36).slice(2));
    for (const table of key.split(',')) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => ref.current());
    }
    channel.subscribe();
    const timer = window.setInterval(() => ref.current(), pollMs);
    const onFocus = () => ref.current();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      supabase.removeChannel(channel);
    };
  }, [key, pollMs]);
}

/** Re-renders every `ms` so "x min ago" and expiry times stay current. */
export function useTick(ms = 15000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setN((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [ms]);
}
