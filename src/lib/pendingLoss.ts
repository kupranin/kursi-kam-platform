import { supabase } from './supabase';
import { ACTIVE_COLUMNS, decorateActiveRow, type ActiveSource } from './activeRequest';
import { isMissingRead } from './missingRead';
import type { RequestRow } from './types';

/**
 * Unapproved KAM losses for treasury, an admin, and a manager.
 *
 * The old list read request_outcomes and required went_through = false.
 * That flag is true when any successful payment for the client on the
 * request day matches, so a mark stored as marked_lost_at disappeared
 * before anyone approved it. loss_open on that view also treats every
 * stale day as a loss, and the rate desk only keeps today. This list
 * reads the stored mark, with no day cutoff and no payment match.
 * Approving sets loss_approved_at and the row leaves. It is not deleted.
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

function pendingFilter(query: LossFilter): LossFilter {
  return query
    .eq('source', 'app')
    .is('rate_written_at', null)
    .is('payment_confirmed_at', null)
    .is('loss_approved_at', null)
    .or(PENDING_LOSS_MARK);
}

function asPending(row: ActiveSource): RequestRow {
  const decorated = decorateActiveRow({ ...row, source: 'app' }, '');
  return {
    ...decorated,
    went_through: false,
    outcome: 'waiting',
    loss_open: true,
  };
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

/** One page of KAM losses still waiting. No today cutoff. */
export async function loadPendingLossPage(shown: number): Promise<{ rows: RequestRow[]; total: number } | { error: true }> {
  const active = supabase.from('request_active') as unknown as LossQuery;
  let result = await pendingFilter(active.select(ACTIVE_COLUMNS, { count: 'exact' }))
    .order('marked_lost_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(0, Math.max(0, shown - 1));

  let named = true;
  if (result.error && isMissingRead(result.error)) {
    named = false;
    const requests = supabase.from('requests') as unknown as LossQuery;
    result = await pendingFilter(requests.select(REQUEST_COLUMNS, { count: 'exact' }))
      .order('marked_lost_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .range(0, Math.max(0, shown - 1));
  }
  if (result.error) return { error: true };

  let source = (result.data ?? []) as ActiveSource[];
  if (!named) source = await attachClientNames(source);
  const rows = source.map(asPending);
  return { rows, total: result.count ?? rows.length };
}

/** Badge count for the same list. */
export async function countPendingLosses(): Promise<number> {
  const active = supabase.from('request_active') as unknown as LossQuery;
  let result = await pendingFilter(active.select('id', { count: 'exact', head: true }));
  if (result.error && isMissingRead(result.error)) {
    const requests = supabase.from('requests') as unknown as LossQuery;
    result = await pendingFilter(requests.select('id', { count: 'exact', head: true }));
  }
  if (result.error) throw new Error(result.error.message ?? 'lost count');
  return result.count ?? 0;
}
