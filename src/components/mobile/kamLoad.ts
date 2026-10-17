import { ACTIVE_COLUMNS, applyMatchedSuccess, decorateActiveRow, splitKamRequests, type ActiveSource } from '../../lib/activeRequest';
import { withClientContext } from '../../lib/requestContext';
import { appendDeferredOpen, deferFlags, deferredOpenIds } from '../../lib/deferWrite';
import { isMissingRead } from '../../lib/missingRead';
import { applyRatePeople, loadRatePeople } from '../../lib/ratePeople';
import { rpc, supabase } from '../../lib/supabase';
import { tbilisiDay, tbilisiDayStart, todayTbilisi } from '../../lib/format';
import { groupKamRows, type KamGroups } from '../../lib/kamWorkspace';
import type { RequestRow } from '../../lib/types';

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

const EMPTY: KamDeskData = {
  awaitingClient: [],
  awaitingTreasury: [],
  held: [],
  followUp: [],
  stillOpen: [],
  writtenToday: [],
  paidToday: [],
  lostToday: [],
  loaded: false,
};

function quoteStamp(start: string): string {
  return `"${start}"`;
}

/** Rates written, payments, declines, and the 7-day follow-up list. Reads only. */
export async function loadKamWorkspaceExtras(profileId: string, today: string): Promise<{ activity: RequestRow[]; followUp: RequestRow[] }> {
  const since = quoteStamp(tbilisiDayStart(today));
  const activityQuery = await supabase
    .from('request_active')
    .select(ACTIVE_COLUMNS)
    .eq('kam_id', profileId)
    .or([
      `rate_written_at.gte.${since}`,
      `payment_confirmed_at.gte.${since}`,
      `marked_lost_at.gte.${since}`,
      `loss_reason_at.gte.${since}`,
      `and(client_reply.eq.declined,client_replied_at.gte.${since})`,
      `and(quote_status.eq.declined,quoted_at.gte.${since})`,
    ].join(','));

  let activity: RequestRow[] = [];
  if (!activityQuery.error && activityQuery.data) {
    const fetched = activityQuery.data as unknown as ActiveSource[];
    activity = await withClientContext(await withPeople(fetched.map((row) => decorateActiveRow(row, ''))));
  }

  const follow = await supabase
    .from('request_outcomes')
    .select('*')
    .eq('kam_id', profileId)
    .eq('outcome', 'did_not_go_through')
    .is('loss_reason', null)
    .gte('request_date', todayTbilisi(-7))
    .order('request_date', { ascending: false });
  const followUp = follow.error
    ? []
    : await withClientContext(await withPeople((follow.data ?? []) as RequestRow[]));
  return { activity, followUp };
}

/**
 * The KAM phone home. Same active read as the desktop list, plus today's
 * activity and the 7-day follow-up list. It does not page through the full history.
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
  const extras = await loadKamWorkspaceExtras(profileId, today);
  const groups = groupKamRows(
    await withClientContext(split.open),
    await withClientContext([...openRows, ...extras.activity]),
    extras.followUp,
    today,
  );
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
    const [ready] = await withClientContext([{ ...withName, rate_write_deferred: flag === true }]);
    return ready ?? null;
  }
  const outcome = await supabase.from('request_outcomes').select('*').eq('id', id).maybeSingle();
  if (outcome.error || !outcome.data) return null;
  const [withName] = await withPeople([outcome.data as RequestRow]);
  if (!withName) return null;
  const flag = (await deferFlags([id])).get(id);
  const [ready] = await withClientContext([{ ...withName, rate_write_deferred: flag === true }]);
  return ready ?? null;
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
  const raw = await withClientContext(await withPeople((data ?? []) as RequestRow[]));
  return { rows: raw.filter((row) => !held.has(row.id)), done: raw.length < limit };
}
