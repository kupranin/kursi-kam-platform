import type { EffectiveOwner } from './clientOwnership';
import { supabase } from './supabase';

interface RawOwner {
  client_id?: string | null;
  owner_id?: string | null;
  owner_name?: string | null;
  owner_state?: string | null;
  owner_source?: string | null;
  override_id?: string | null;
}

export type OwnerLoad =
  | { status: 'ok'; owners: Map<string, EffectiveOwner> }
  | { status: 'missing' }
  | { status: 'failed' };

function missingFunction(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  if (code === 'PGRST202' || code === '42883') return true;
  const message = (error.message ?? '').toLowerCase();
  const absent = message.includes('could not find') || message.includes('does not exist') || message.includes('schema cache');
  return absent && message.includes('client_effective_owners');
}

function asOwner(row: RawOwner): EffectiveOwner | null {
  const clientId = String(row.client_id ?? '');
  if (!clientId) return null;
  const state = row.owner_state === 'named' || row.owner_state === 'deleted' || row.owner_state === 'unresolved'
    ? row.owner_state
    : 'unresolved';
  const source = row.owner_source === 'override' || row.owner_source === 'computed' || row.owner_source === 'unresolved'
    ? row.owner_source
    : 'unresolved';
  return {
    clientId,
    ownerId: row.owner_id ?? null,
    ownerName: row.owner_name ?? null,
    state,
    source,
    overrideId: row.override_id ?? null,
  };
}

export interface AssignedOwnerName {
  name: string | null;
  state: 'named' | 'deleted' | 'none';
}

interface RawAssigned {
  client_id?: string | null;
  owner_name?: string | null;
  owner_state?: string | null;
}

/**
 * assigned_kam_id display name from client_owner_names.
 * Used only when client_effective_owners is not installed. Does not write.
 */
export async function loadAssignedOwnerNames(ids: string[]): Promise<Map<string, AssignedOwnerName>> {
  const names = new Map<string, AssignedOwnerName>();
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (!unique.length) return names;
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await supabase.rpc('client_owner_names', { p_client_ids: unique.slice(i, i + 100) });
    if (error) return names;
    for (const row of (data ?? []) as RawAssigned[]) {
      const clientId = String(row.client_id ?? '');
      if (!clientId) continue;
      const state = row.owner_state === 'named' || row.owner_state === 'deleted' ? row.owner_state : 'none';
      names.set(clientId, { name: row.owner_name ?? null, state });
    }
  }
  return names;
}

/** All-time owner for clients this account can already open. Does not write. */
export async function loadEffectiveOwners(ids: string[]): Promise<OwnerLoad> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const owners = new Map<string, EffectiveOwner>();
  if (!unique.length) return { status: 'ok', owners };
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await supabase.rpc('client_effective_owners', { p_client_ids: unique.slice(i, i + 100) });
    if (error) {
      if (missingFunction(error)) return { status: 'missing' };
      return { status: 'failed' };
    }
    for (const row of (data ?? []) as RawOwner[]) {
      const owner = asOwner(row);
      if (owner) owners.set(owner.clientId, owner);
    }
  }
  return { status: 'ok', owners };
}
