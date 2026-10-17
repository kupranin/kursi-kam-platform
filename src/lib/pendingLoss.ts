import { supabase } from './supabase';
import { decorateActiveRow, lossOpenWithoutPaymentMatch, type ActiveSource } from './activeRequest';
import { todayTbilisi } from './format';
import type { RequestRow } from './types';

/**
 * Deals treasury still has to approve.
 *
 * A KAM mark, a client or treasury decline, and an app request from before
 * today all count, matching lossOpenWithoutPaymentMatch. The list reads
 * public.requests directly so it does not depend on request_active (that
 * view joins clients and returned no rows for this queue). A payment match
 * does not hide a stored mark. Approving sets loss_approved_at and the row
 * leaves. It is not deleted.
 */
export const PENDING_LOSS_MARK = 'marked_lost_at.not.is.null,loss_reason.not.is.null';

const REQUEST_COLUMNS = [
  'id',
  'kam_id',
  'client_id',
  'requested_at',
  'request_date',
  'sells_currency',
  'gets_currency',
  'amount',
  'gets_amount',
  'client_rate',
  'rate',
  'note',
  'loss_reason',
  'loss_reason_at',
  'loss_reason_note',
  'source',
  'asked_at',
  'quote_status',
  'rate_valid_until',
  'quoted_at',
  'decline_reason',
  'client_reply',
  'approved_rate',
  'better_decision',
  'client_decline_reason',
  'client_replied_at',
  'rate_written_at',
  'payment_confirmed_at',
  'loss_approved_at',
  'loss_approval_comment',
  'marked_lost_at',
].join(', ');

type LossQuery = {
  select: (columns: string, options?: { count?: 'exact'; head?: boolean }) => LossFilter;
};

type LossFilter = {
  eq: (column: string, value: string) => LossFilter;
  is: (column: string, value: null) => LossFilter;
  or: (filters: string) => LossFilter;
  order: (column: string, options: { ascending: boolean; nullsFirst?: boolean }) => LossFilter;
  range: (from: number, to: number) => PromiseLike<LossResult>;
  then: PromiseLike<LossResult>['then'];
};

interface LossResult {
  data: unknown[] | null;
  error: { code?: string; message?: string } | null;
  count: number | null;
}

function pendingFilter(query: LossFilter, today: string): LossFilter {
  const openLoss = `or(${PENDING_LOSS_MARK},client_reply.eq.declined,quote_status.eq.declined,request_date.lt.${today})`;
  return query
    .eq('source', 'app')
    .is('payment_confirmed_at', null)
    .is('loss_approved_at', null)
    .or(`and(rate_written_at.is.null,${openLoss}),and(rate_written_at.not.is.null,or(${PENDING_LOSS_MARK}))`);
}

function asPending(row: ActiveSource, today: string): RequestRow | null {
  const decorated = decorateActiveRow(row, today);
  if (!lossOpenWithoutPaymentMatch(row, today)) return null;
  if (decorated.went_through) return null;
  return { ...decorated, outcome: 'waiting', loss_open: true };
}

async function attachKamNames(rows: ActiveSource[]): Promise<ActiveSource[]> {
  const ids = rows.map((row) => row.id);
  const kamIds = [...new Set(rows.map((row) => row.kam_id).filter((id): id is string => !!id))];
  const byRequest = new Map<number, string>();
  const byKam = new Map<string, string>();
  const [deals, profiles] = await Promise.all([
    ids.length
      ? supabase.from('analyst_deals').select('id, kam_name').in('id', ids)
      : Promise.resolve({ data: [] as { id: number; kam_name: string | null }[] }),
    kamIds.length
      ? supabase.from('profiles').select('id, full_name').in('id', kamIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
  ]);
  for (const row of deals.data ?? []) {
    const name = (row.kam_name as string | null)?.trim();
    if (name) byRequest.set(row.id as number, name);
  }
  for (const row of profiles.data ?? []) {
    const name = (row.full_name as string | null)?.trim();
    if (name) byKam.set(row.id as string, name);
  }
  return rows.map((row) => ({
    ...row,
    kam_name: byRequest.get(row.id) ?? (row.kam_id ? byKam.get(row.kam_id) : null) ?? row.kam_name ?? null,
  }));
}

async function attachClientNames(rows: ActiveSource[]): Promise<ActiveSource[]> {
  const ids = [...new Set(rows.map((row) => row.client_id).filter(Boolean))];
  if (!ids.length) return rows;
  const { data } = await supabase.from('clients').select('client_id, name, kind').in('client_id', ids);
  const names = new Map((data ?? []).map((row) => [row.client_id as string, row]));
  return rows.map((row) => {
    const client = names.get(row.client_id);
    if (!client) return row;
    return {
      ...row,
      client_name: (client.name as string | null) ?? row.client_name ?? null,
      client_kind: (client.kind as string | null) ?? row.client_kind ?? '',
    };
  });
}

/** One page of losses still waiting for treasury. No today cutoff. */
export async function loadPendingLossPage(shown: number): Promise<{ rows: RequestRow[]; total: number } | { error: true }> {
  const today = todayTbilisi();
  const requests = supabase.from('requests') as unknown as LossQuery;
  const result = await pendingFilter(requests.select(REQUEST_COLUMNS, { count: 'exact' }), today)
    .order('marked_lost_at', { ascending: false, nullsFirst: false })
    .order('request_date', { ascending: false })
    .order('id', { ascending: false })
    .range(0, 1999);
  if (result.error) return { error: true };

  const source = await attachKamNames(await attachClientNames((result.data ?? []) as ActiveSource[]));
  const waiting = source
    .map((row) => asPending(row, today))
    .filter((row): row is RequestRow => row != null);
  return { rows: waiting.slice(0, Math.max(0, shown)), total: waiting.length };
}

/** Badge count for the same list. */
export async function countPendingLosses(): Promise<number> {
  const page = await loadPendingLossPage(1);
  if ('error' in page) throw new Error('lost count');
  return page.total;
}
