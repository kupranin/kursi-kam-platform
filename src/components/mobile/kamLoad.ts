import { ACTIVE_COLUMNS, applyMatchedSuccess, decorateActiveRow, splitKamRequests, type ActiveSource } from '../../lib/activeRequest';
import { appendDeferredOpen, deferFlags, deferredOpenIds } from '../../lib/deferWrite';
import { isMissingRead } from '../../lib/missingRead';
import { applyRatePeople, loadRatePeople } from '../../lib/ratePeople';
import { rpc, supabase } from '../../lib/supabase';
import { tbilisiDay, todayTbilisi } from '../../lib/format';
import type { RequestRow } from '../../lib/types';
import { groupKamRows, type KamGroups } from './kamBuckets';

/** One quiet report per failure streak. A later success arms it again. */
let matchedFailureLogged = false;

async function matchedSuccessIds(ids: number[]): Promise<Set<number> | null> {
  if (!ids.length) return new Set();
  const listed = await supabase.rpc('request_went_through_ids', { p_ids: ids });
  if (!listed.error) {
    matchedFailureLogged = false;
    const data = Array.isArray(listed.data) ? listed.data : [];
    return new Set(data.map((row: { id: number }) => Number(row.id)));
  }
  if (isMissingRead(listed.error)) {
    const narrow = await supabase.from('request_outcomes').select('id').in('id', ids).eq('went_through', true);
    if (!narrow.error) return new Set((narrow.data ?? []).map((row) => row.id));
  }
  if (!matchedFailureLogged) {
    matchedFailureLogged = true;
    console.error('request_went_through_ids failed; keeping the last reconciled list', listed.error.message);
  }
  return null;
}

async function withPeople(rows: RequestRow[]): Promise<RequestRow[]> {
  return applyRatePeople(rows, await loadRatePeople(rows.map((row) => row.id)));
}

export interface KamDeskData extends KamGroups {
  loaded: boolean;
}

const EMPTY: KamDeskData = { action: [], waiting: [], active: [], recent: [], loaded: false };

/**
 * The KAM phone home. Same active read as the desktop list, plus a short
 * recent slice. It does not page through the full history.
 */
export async function loadKamDesk(profileId: string, previous: KamDeskData | null): Promise<KamDeskData> {
  const today = todayTbilisi();
  const keep = previous ?? EMPTY;
  let openRows: RequestRow[] | null = null;
  let doneRows: RequestRow[] = [];

  const active = await supabase
    .from('request_active')
    .select(ACTIVE_COLUMNS)
    .eq('kam_id', profileId)
    .or(`request_date.eq.${today},quote_status.eq.asking`)
    .order('asked_at', { ascending: false });

  if (active.error && isMissingRead(active.error)) {
    const { data, error } = await supabase
      .from('request_outcomes')
      .select('*')
      .eq('kam_id', profileId)
      .or(`request_date.eq.${today},quote_status.eq.asking`)
      .order('asked_at', { ascending: false });
    if (!error) {
      const next = await appendDeferredOpen(profileId, await withPeople((data ?? []) as RequestRow[]), async (ids) => {
        const more = await supabase.from('request_outcomes').select('*').in('id', ids);
        if (more.error || !more.data) return [];
        return withPeople(more.data as RequestRow[]);
      });
      openRows = next;
      doneRows = next.filter((row) => row.went_through && row.request_date === today);
    }
  } else if (!active.error) {
    const fetched = (active.data ?? []) as unknown as ActiveSource[];
    const matched = await matchedSuccessIds(fetched.map((row) => row.id));
    if (matched) {
      let freshnessDay = '';
      try {
        const iso = await rpc<string | null>('data_freshness');
        freshnessDay = iso ? tbilisiDay(iso) : '';
      } catch {
        freshnessDay = '';
      }
      openRows = await appendDeferredOpen(
        profileId,
        await withPeople(fetched.map((row) => applyMatchedSuccess(decorateActiveRow(row, freshnessDay), matched))),
        async (ids) => {
          const more = await supabase.from('request_active').select(ACTIVE_COLUMNS).in('id', ids);
          if (more.error || !more.data) return [];
          const extra = more.data as unknown as ActiveSource[];
          const extraMatched = await matchedSuccessIds(extra.map((row) => row.id));
          if (!extraMatched) return [];
          return withPeople(extra.map((row) => applyMatchedSuccess(decorateActiveRow(row, freshnessDay), extraMatched)));
        },
      );
      doneRows = [];
    }
  }

  if (!openRows) {
    return { ...keep, loaded: true };
  }

  const split = splitKamRequests(openRows, doneRows, today);
  let older: RequestRow[] = keep.recent;
  const recent = await supabase
    .from('request_outcomes')
    .select('*')
    .eq('kam_id', profileId)
    .order('request_date', { ascending: false })
    .order('requested_at', { ascending: false })
    .limit(8);
  if (!recent.error) {
    const held = new Set(await deferredOpenIds(profileId));
    older = ((recent.data ?? []) as RequestRow[]).filter((row) => !held.has(row.id));
  }

  const groups = groupKamRows(split.open, split.done, older);
  return { ...groups, loaded: true };
}

export async function loadKamRequest(id: number): Promise<RequestRow | null> {
  const active = await supabase.from('request_active').select(ACTIVE_COLUMNS).eq('id', id).maybeSingle();
  if (!active.error && active.data) {
    const source = active.data as unknown as ActiveSource;
    const matched = await matchedSuccessIds([id]);
    let freshnessDay = '';
    try {
      const iso = await rpc<string | null>('data_freshness');
      freshnessDay = iso ? tbilisiDay(iso) : '';
    } catch {
      freshnessDay = '';
    }
    const row = decorateActiveRow(source, freshnessDay);
    const [withName] = await withPeople([matched ? applyMatchedSuccess(row, matched) : row]);
    if (!withName) return null;
    const flag = (await deferFlags([id])).get(id);
    return { ...withName, rate_write_deferred: flag === true };
  }
  const outcome = await supabase.from('request_outcomes').select('*').eq('id', id).maybeSingle();
  if (outcome.error || !outcome.data) return null;
  const [withName] = await withPeople([outcome.data as RequestRow]);
  if (!withName) return null;
  const flag = (await deferFlags([id])).get(id);
  return { ...withName, rate_write_deferred: flag === true };
}

export async function loadKamEarlier(profileId: string, limit: number): Promise<{ rows: RequestRow[]; done: boolean }> {
  const today = todayTbilisi();
  const { data, error } = await supabase
    .from('request_outcomes')
    .select('*')
    .eq('kam_id', profileId)
    .or(`request_date.lt.${today},and(source.eq.import,went_through.eq.false)`)
    .order('request_date', { ascending: false })
    .order('requested_at', { ascending: false })
    .range(0, limit - 1);
  if (error) throw new Error(error.message);
  const held = new Set(await deferredOpenIds(profileId));
  const raw = await withPeople((data ?? []) as RequestRow[]);
  return { rows: raw.filter((row) => !held.has(row.id)), done: raw.length < limit };
}
