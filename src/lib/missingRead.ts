/** True when this select or RPC is missing because setup 33 has not been pasted yet. */
export function isMissingRead(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42883') return true;
  const message = (error.message ?? '').toLowerCase();
  const missing = message.includes('could not find') || message.includes('does not exist') || message.includes('schema cache');
  const name = message.includes('request_active') || message.includes('desk_day_rows') || message.includes('request_went_through_ids');
  return missing && name;
}
