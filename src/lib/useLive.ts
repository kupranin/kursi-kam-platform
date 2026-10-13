import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

/** Wait this long so a burst of changes becomes one reload. */
const COALESCE_MS = 500;
/** A continuous burst still reloads by this time, so the screen cannot stall. */
const MAX_WAIT_MS = 2000;

type Fan = Set<() => void>;

const channels = new Map<string, { channel: ReturnType<typeof supabase.channel>; fans: Fan }>();

/** One Supabase channel per table list. A second caller joins it instead of opening another. */
function retainRealtime(tablesKey: string, onChange: () => void): () => void {
  const tables = tablesKey.split(',').filter(Boolean);
  let entry = channels.get(tablesKey);
  if (!entry) {
    const fans: Fan = new Set();
    const channel = supabase.channel('live-' + tablesKey);
    const notify = () => { fans.forEach((fn) => fn()); };
    for (const table of tables) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, notify);
    }
    channel.subscribe();
    entry = { channel, fans };
    channels.set(tablesKey, entry);
  }
  entry.fans.add(onChange);
  return () => {
    const current = channels.get(tablesKey);
    if (!current) return;
    current.fans.delete(onChange);
    if (current.fans.size === 0) {
      void supabase.removeChannel(current.channel);
      channels.delete(tablesKey);
    }
  };
}

export type LiveOptions = { realtime?: boolean };

/**
 * Calls `reload` when rows change in the given tables (Supabase Realtime),
 * and also every `pollMs`, when the window gets focus, and when the tab
 * becomes visible again, as a safety net.
 *
 * A burst of those signals becomes one reload, and a reload already in
 * flight is followed by at most one more. Pass `{ realtime: false }` to
 * keep the poll, focus, and visibility refresh without a subscription.
 */
export function useLive(
  tables: string[],
  reload: () => void | Promise<unknown>,
  pollMs = 20000,
  options?: LiveOptions,
) {
  const ref = useRef(reload);
  ref.current = reload;
  const key = tables.join(',');
  const realtime = options?.realtime !== false;

  useEffect(() => {
    let alive = true;
    let coalesceTimer: number | null = null;
    let firstEventAt = 0;
    let running = false;
    let queued = false;

    const run = () => {
      if (!alive) return;
      if (running) {
        queued = true;
        return;
      }
      running = true;
      queued = false;
      Promise.resolve()
        .then(() => ref.current())
        .finally(() => {
          running = false;
          if (!alive) return;
          if (queued) {
            queued = false;
            run();
          }
        });
    };

    const schedule = () => {
      const now = Date.now();
      if (!firstEventAt) firstEventAt = now;
      const due = now - firstEventAt >= MAX_WAIT_MS ? 0 : COALESCE_MS;
      if (coalesceTimer != null) window.clearTimeout(coalesceTimer);
      coalesceTimer = window.setTimeout(() => {
        coalesceTimer = null;
        firstEventAt = 0;
        run();
      }, due);
    };

    const release = realtime && key ? retainRealtime(key, schedule) : () => {};
    const poll = window.setInterval(schedule, pollMs);
    const onFocus = () => schedule();
    const onVisible = () => {
      if (document.visibilityState === 'visible') schedule();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      if (coalesceTimer != null) window.clearTimeout(coalesceTimer);
      window.clearInterval(poll);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      release();
    };
  }, [key, pollMs, realtime]);
}

/** Re-renders every `ms` so "x min ago" and expiry times stay current. */
export function useTick(ms = 15000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setN((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [ms]);
}
