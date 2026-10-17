import { withClientContext } from './requestContext';
import type { RequestRow } from './types';
import { supabase } from './supabase';
import { applySearchFilters, searchPlan, type SearchChain, type SearchInput } from './requestSearch';

const SEARCH_COLUMNS = [
  'id',
  'kam_id',
  'kam_name',
  'client_id',
  'client_name',
  'client_kind',
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
  'loss_reason_note',
  'source',
  'went_through',
  'outcome',
  'asked_at',
  'quote_status',
  'rate_valid_until',
  'quoted_at',
  'decline_reason',
  'quote_state',
  'client_reply',
  'approved_rate',
  'wanted_rate',
  'better_decision',
  'given_rate',
  'client_decline_reason',
  'client_replied_at',
  'bank',
  'rate_written_at',
  'loss_approved_at',
  'loss_approval_comment',
  'loss_open',
  'payment_confirmed_at',
].join(', ');

function missingSearchView(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const message = (error.message ?? '').toLowerCase();
  return message.includes('request_search_rows')
    || error.code === 'PGRST205'
    || error.code === '42P01';
}

async function searchTable(table: 'request_search_rows' | 'request_outcomes', columns: string, input: SearchInput) {
  const plan = searchPlan(input);
  const head = supabase.from(table) as unknown as {
    select(cols: string, options: { count: 'exact' }): SearchChain;
  };
  const filtered = applySearchFilters(head.select(columns, { count: 'exact' }), plan)
    .order('request_date', { ascending: false })
    .order('requested_at', { ascending: false })
    .order('id', { ascending: false });
  return filtered.range(plan.offset, plan.offset + plan.limit - 1);
}

/** One page of this KAM's requests. Does not download the rest of the history. */
export async function searchKamRequests(input: SearchInput): Promise<{ rows: RequestRow[]; total: number }> {
  if (!input.kamId) throw new Error('Missing KAM');
  const rich = `${SEARCH_COLUMNS}, import_key, legacy_status, marked_lost_at, display_class`;
  let result = await searchTable('request_search_rows', rich, { ...input, displayClass: true });
  if (result.error && missingSearchView(result.error)) {
    result = await searchTable('request_outcomes', SEARCH_COLUMNS, { ...input, displayClass: false });
  }
  if (result.error) throw new Error(result.error.message);
  const rows = await withClientContext((result.data ?? []) as RequestRow[]);
  return { rows, total: result.count ?? 0 };
}
