export type LogCode =
  | 'agreed'
  | 'client_declined'
  | 'treasury_declined'
  | 'waiting_treasury'
  | 'waiting_kam'
  | 'expired'
  | 'went_through'
  | 'did_not'
  | 'waiting';

export interface StatusInput {
  client_reply?: string | null;
  quote_status?: string | null;
  quote_state?: string | null;
  better_decision?: string | null;
  outcome?: string | null;
  rate_valid_until?: string | null;
  decline_reason?: string | null;
  client_decline_reason?: string | null;
  went_through?: boolean;
}

/**
 * Earlier deals stay under a request that is still open, so treasury can use
 * them while quoting. They drop off once the case is finished.
 * Success: a written rate, a matched payment, or the KAM “transaction went
 * through” mark. Closed: a loss (including one treasury has not approved),
 * a client decline, or a treasury decline.
 */
export function hideEarlierDeals(row: {
  went_through?: boolean | null;
  rate_written_at?: string | null;
  payment_confirmed_at?: string | null;
  outcome?: string | null;
  loss_open?: boolean | null;
  quote_status?: string | null;
  quote_state?: string | null;
  client_reply?: string | null;
}): boolean {
  if (row.went_through || row.rate_written_at || row.payment_confirmed_at) return true;
  if (row.outcome === 'did_not_go_through' || row.loss_open) return true;
  if (row.quote_status === 'declined' || row.quote_state === 'declined') return true;
  if (row.client_reply === 'declined') return true;
  return false;
}

export function classifyRequest(row: StatusInput): { code: LogCode; reason: string | null } {
  if (row.client_reply === 'approved') return { code: 'agreed', reason: null };
  if (row.client_reply === 'declined') return { code: 'client_declined', reason: row.client_decline_reason ?? null };
  if (row.quote_status === 'declined' || row.quote_state === 'declined') {
    return { code: 'treasury_declined', reason: row.decline_reason ?? null };
  }
  if (row.client_reply === 'better' && !row.better_decision) return { code: 'waiting_treasury', reason: null };
  if (row.quote_status === 'asking' || row.quote_state === 'asking') return { code: 'waiting_treasury', reason: null };
  const expired = row.quote_state === 'expired'
    || (row.quote_status === 'quoted' && !!row.rate_valid_until && new Date(row.rate_valid_until).getTime() < Date.now());
  if (expired) return { code: 'expired', reason: null };
  if (row.quote_status === 'quoted' || row.quote_state === 'quoted') return { code: 'waiting_kam', reason: null };
  if (row.went_through || row.outcome === 'went_through') return { code: 'went_through', reason: null };
  if (row.outcome === 'did_not_go_through') return { code: 'did_not', reason: null };
  return { code: 'waiting', reason: null };
}

const TREASURY_REASONS: Record<string, [string, string]> = {
  'Amount too large': ['თანხა ძალიან დიდია', 'Amount too large'],
  'Market moving too fast': ['ბაზარი ძალიან სწრაფად იცვლება', 'Market moving too fast'],
  'Need more details': ['მეტი დეტალია საჭირო', 'Need more details'],
};

export function treasuryReason(reason: string | null | undefined, lang: 'ka' | 'en'): string {
  if (!reason) return '';
  const pair = TREASURY_REASONS[reason];
  if (!pair) return reason;
  return lang === 'en' ? pair[1] : pair[0];
}
