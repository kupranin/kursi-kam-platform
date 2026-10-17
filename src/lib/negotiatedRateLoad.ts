// Read-only load for the negotiated-adjustment warning.
// A missing function or table hides the warning. It never blocks a request.

import { supabase } from './supabase';
import {
  negotiatedSourceFromRpc,
  selectActiveNegotiated,
  type NegotiatedView,
} from './negotiatedRates';

/** True when setup 46 has not been pasted, or the function's table is absent. */
export function isMissingNegotiated(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42703' || code === '42883') return true;
  const message = (error.message ?? '').toLowerCase();
  const missing = message.includes('could not find') || message.includes('does not exist') || message.includes('schema cache');
  const name = message.includes('dynamic_active_negotiated') || message.includes('negotiated_rate');
  return missing && name;
}

/** One client's active rows. Empty when the id is not 9 or 11 digits, or the read fails. */
export async function loadDynamicActiveNegotiatedRates(clientId: string): Promise<NegotiatedView[]> {
  const id = clientId.trim();
  if (!/^(\d{9}|\d{11})$/.test(id)) return [];
  const { data, error } = await supabase.rpc('dynamic_active_negotiated_rates_for_client', { p_client_id: id });
  // A missing function and any other read error both hide the warning.
  if (error || isMissingNegotiated(error)) return [];
  const source = (Array.isArray(data) ? data : [])
    .map((row) => negotiatedSourceFromRpc(row as Record<string, unknown>))
    .filter((row): row is NonNullable<typeof row> => row != null);
  return selectActiveNegotiated(source);
}
