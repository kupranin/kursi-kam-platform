import { supabase, rpc } from './supabase';

function missingBlocked(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42883' || code === '42703') return true;
  const message = (error.message ?? '').toLowerCase();
  return message.includes('could not find')
    || message.includes('does not exist')
    || message.includes('schema cache')
    || (message.includes('blocked') && message.includes('column'));
}

/** Client ids marked blocked, among the ids this screen already shows. */
export async function loadBlockedClientIds(ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (!unique.length) return new Set();

  const flagged = await supabase.rpc('client_blocked_ids', { p_ids: unique });
  if (!flagged.error) {
    const rows = (flagged.data ?? []) as { client_id?: string }[];
    return new Set(rows.map((row) => row.client_id).filter((id): id is string => !!id));
  }
  if (!missingBlocked(flagged.error)) return new Set();

  const direct = await supabase.from('clients').select('client_id').in('client_id', unique).eq('blocked', true);
  if (direct.error) return new Set();
  return new Set((direct.data ?? []).map((row) => row.client_id as string));
}

/** Treasury or an admin. On and off. Other deals are left as they are. */
export function setClientBlocked(clientId: string, blocked: boolean): Promise<void> {
  return rpc('set_client_blocked', { p_client_id: clientId, p_blocked: blocked });
}
