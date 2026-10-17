import { loadEffectiveOwners } from './clientOwners';
import { displayClass, type DisplayClass } from './displayClass';
import { supabase } from './supabase';
import type { RequestRow } from './types';

const FACTS = 'id, source, import_key, legacy_status, rate_written_at, payment_confirmed_at, marked_lost_at, loss_reason, client_reply, quote_status';

interface Fact {
  id: number;
  source?: string | null;
  import_key?: string | null;
  legacy_status?: string | null;
  rate_written_at?: string | null;
  payment_confirmed_at?: string | null;
  marked_lost_at?: string | null;
  loss_reason?: string | null;
  client_reply?: string | null;
  quote_status?: string | null;
}

interface LegacyOwner {
  client_id?: string | null;
  owner_name?: string | null;
  owner_state?: string | null;
}

function legacyState(value: string | null | undefined): RequestRow['owner_state'] {
  if (value === 'named' || value === 'none' || value === 'deleted') return value;
  return undefined;
}

async function loadFacts(ids: number[]): Promise<Map<number, Fact>> {
  const map = new Map<number, Fact>();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { data, error } = await supabase.from('requests').select(FACTS).in('id', slice);
    if (error || !data) continue;
    for (const row of data as Fact[]) map.set(Number(row.id), row);
  }
  return map;
}

async function loadLegacyOwners(ids: string[]): Promise<Map<string, { name: string | null; state: RequestRow['owner_state'] }>> {
  const map = new Map<string, { name: string | null; state: RequestRow['owner_state'] }>();
  const { data, error } = await supabase.rpc('client_owner_names', { p_client_ids: ids });
  if (error || !data) return map;
  for (const row of data as LegacyOwner[]) {
    if (!row.client_id) continue;
    map.set(row.client_id, { name: row.owner_name ?? null, state: legacyState(row.owner_state) });
  }
  return map;
}

async function loadOwners(ids: string[]): Promise<Map<string, { name: string | null; state: RequestRow['owner_state']; source?: RequestRow['owner_source'] }>> {
  const map = new Map<string, { name: string | null; state: RequestRow['owner_state']; source?: RequestRow['owner_source'] }>();
  if (!ids.length) return map;
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 200) {
    const slice = unique.slice(i, i + 200);
    try {
      const loaded = await loadEffectiveOwners(slice);
      if (loaded.status === 'missing') {
        const legacy = await loadLegacyOwners(slice);
        for (const [id, owner] of legacy) map.set(id, owner);
        continue;
      }
      if (loaded.status !== 'ok') continue;
      for (const [id, owner] of loaded.owners) {
        map.set(id, { name: owner.ownerName, state: owner.state, source: owner.source });
      }
    } catch {
      /* owner names appear after setup 49 is pasted; 45 remains the fallback above */
    }
  }
  return map;
}

/** Owner name and the display class for rows this account can already read. */
export async function withClientContext(rows: RequestRow[]): Promise<RequestRow[]> {
  if (!rows.length) return rows;
  const ids = [...new Set(rows.map((row) => row.id))];
  const clientIds = [...new Set(rows.map((row) => row.client_id).filter(Boolean))];
  const [facts, owners] = await Promise.all([loadFacts(ids), loadOwners(clientIds)]);
  return rows.map((row) => {
    const fact = facts.get(row.id);
    const owner = owners.get(row.client_id);
    const merged: RequestRow = {
      ...row,
      ...(fact
        ? {
          source: (fact.source === 'import' || fact.source === 'app' ? fact.source : row.source) as RequestRow['source'],
          import_key: fact.import_key ?? row.import_key ?? null,
          legacy_status: fact.legacy_status ?? null,
          rate_written_at: fact.rate_written_at ?? row.rate_written_at ?? null,
          payment_confirmed_at: fact.payment_confirmed_at ?? row.payment_confirmed_at ?? null,
          marked_lost_at: fact.marked_lost_at ?? row.marked_lost_at ?? null,
          loss_reason: fact.loss_reason ?? row.loss_reason,
          client_reply: (fact.client_reply ?? row.client_reply) as RequestRow['client_reply'],
          quote_status: (fact.quote_status ?? row.quote_status) as RequestRow['quote_status'],
        }
        : {}),
      owner_name: owner?.name ?? row.owner_name ?? null,
      owner_state: owner?.state ?? row.owner_state,
      owner_source: owner?.source ?? row.owner_source,
    };
    const display_class: DisplayClass | undefined = fact ? displayClass(merged) : row.display_class;
    return { ...merged, display_class };
  });
}
