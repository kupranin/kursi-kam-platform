import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * Invite and password-reset links arrive with "type=invite" or "type=recovery"
 * in the address. Read it before the client clears the address.
 */
export const arrivedFrom = new URLSearchParams(window.location.hash.slice(1)).get('type');

/** False until the two environment variables are set (see .env.example). */
export const isConfigured = Boolean(url && key);

export const supabase = createClient(url || 'http://localhost:54321', key || 'not-configured', {
  auth: {
    // invite and password-reset links put the session in the address; pick it up
    flowType: 'implicit',
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
  },
});

/** Calls a database function and throws its message as a plain Error. */
export async function rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Calls the admin-users edge function and returns its JSON, or throws its error text. */
export async function adminUsers<T = unknown>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('admin-users', { body });
  if (error) {
    let message = error.message;
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const parsed = await ctx.json();
        if (parsed?.error) message = parsed.error;
      } catch {
        /* keep the generic message */
      }
    }
    throw new Error(message);
  }
  return data as T;
}
