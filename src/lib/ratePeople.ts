import { supabase } from './supabase';

export interface RatePeopleNames {
  quoted_by_name: string | null;
  written_by_name: string | null;
}

const EMPTY: RatePeopleNames = { quoted_by_name: null, written_by_name: null };

/** Names for who gave the rate and who wrote it. Empty until that list exists. */
export async function loadRatePeople(ids: number[]): Promise<Map<number, RatePeopleNames>> {
  const map = new Map<number, RatePeopleNames>();
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id)))];
  if (!unique.length) return map;
  const { data, error } = await supabase
    .from('request_rate_names')
    .select('id, quoted_by_name, written_by_name')
    .in('id', unique);
  if (error || !data) return map;
  for (const row of data as { id: number; quoted_by_name: string | null; written_by_name: string | null }[]) {
    map.set(row.id, {
      quoted_by_name: row.quoted_by_name,
      written_by_name: row.written_by_name,
    });
  }
  return map;
}

export function ratePeopleFor(people: Map<number, RatePeopleNames>, id: number): RatePeopleNames {
  return people.get(id) ?? EMPTY;
}

export function applyRatePeople<T extends { id: number }>(rows: T[], people: Map<number, RatePeopleNames>): T[] {
  return rows.map((row) => {
    const names = people.get(row.id);
    if (!names) return row;
    return { ...row, quoted_by_name: names.quoted_by_name, written_by_name: names.written_by_name };
  });
}
