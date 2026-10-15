import { CURRENCIES } from './types';

/**
 * KAM request search on request_outcomes.
 * Same authenticated select the desktop history already pages, with the
 * signed-in session. kam_id is always that KAM. RLS still applies.
 * One page is 25 rows. No service role, no new SQL.
 */
export const SEARCH_PAGE = 25;

/** Days before today so the window is 30 calendar days, including today. */
const LAST_30_BACK = 29;

export const SEARCH_STATUSES = ['all', 'waiting', 'quoted', 'better', 'accepted', 'completed', 'lost'] as const;
export type SearchStatus = (typeof SEARCH_STATUSES)[number];
export type SearchDates = '30' | 'all';

export type SearchStep =
  | { op: 'eq'; column: string; value: string | boolean }
  | { op: 'neq'; column: string; value: string }
  | { op: 'is'; column: string; value: null }
  | { op: 'gte'; column: string; value: string }
  | { op: 'lte'; column: string; value: string }
  | { op: 'or'; filters: string };

export interface SearchPlan {
  steps: SearchStep[];
  offset: number;
  limit: number;
}

export interface SearchChain {
  eq(column: string, value: string | boolean): SearchChain;
  neq(column: string, value: string): SearchChain;
  is(column: string, value: null): SearchChain;
  gte(column: string, value: string): SearchChain;
  lte(column: string, value: string): SearchChain;
  or(filters: string): SearchChain;
  order(column: string, options: { ascending: boolean }): SearchChain;
  range(from: number, to: number): PromiseLike<SearchPageResult>;
}

interface SearchPageResult {
  data: unknown[] | null;
  error: { message: string } | null;
  count: number | null;
}

export interface SearchInput {
  kamId: string;
  text: string;
  status: SearchStatus;
  dates: SearchDates;
  pair: string;
  offset: number;
  today: string;
}

const NOT_COMPLETED: SearchStep[] = [
  { op: 'eq', column: 'went_through', value: false },
  { op: 'is', column: 'rate_written_at', value: null },
  { op: 'is', column: 'payment_confirmed_at', value: null },
  { op: 'neq', column: 'outcome', value: 'went_through' },
];

const NOT_LOSS_MARK: SearchStep[] = [
  { op: 'is', column: 'loss_reason', value: null },
  { op: 'is', column: 'loss_approved_at', value: null },
];

/** Nullable quote columns: neq alone would drop SQL nulls. */
const NOT_QUOTE_DECLINE: SearchStep[] = [
  { op: 'or', filters: 'quote_status.is.null,quote_status.neq.declined' },
  { op: 'or', filters: 'quote_state.is.null,quote_state.neq.declined' },
  { op: 'eq', column: 'loss_open', value: false },
  { op: 'neq', column: 'outcome', value: 'did_not_go_through' },
];

/**
 * Letters, numbers, spaces, and hyphens only, so a typed value cannot
 * break out of the PostgREST or() filter.
 */
export function searchNeedle(raw: string): string {
  return raw.trim().slice(0, 80).replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, ' ').trim();
}

export function daysBefore(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() - days);
  const year = dt.getUTCFullYear();
  const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function pairParts(pair: string): { sells: string; gets: string } | null {
  const match = /^([A-Z]{3})\/([A-Z]{3})$/.exec(pair);
  if (!match || match[1] === match[2]) return null;
  const known = CURRENCIES as readonly string[];
  if (!known.includes(match[1]) || !known.includes(match[2])) return null;
  return { sells: match[1], gets: match[2] };
}

export function currencyPairOptions(): string[] {
  const out: string[] = [];
  for (const sells of CURRENCIES) {
    for (const gets of CURRENCIES) {
      if (sells !== gets) out.push(`${sells}/${gets}`);
    }
  }
  return out;
}

export function searchEngaged(input: { text: string; status: SearchStatus; dates: SearchDates; pair: string }): boolean {
  return searchNeedle(input.text).length > 0 || input.status !== 'all' || input.dates !== '30' || pairParts(input.pair) != null;
}

export function textOrFilter(needle: string): string | null {
  if (!needle) return null;
  const quoted = `"*${needle}*"`;
  const parts = [`client_name.ilike.${quoted}`, `client_id.ilike.${quoted}`];
  if (/^\d{1,18}$/.test(needle)) parts.push(`id.eq.${needle}`);
  return parts.join(',');
}

/**
 * History list order, then the open desk.
 * Completed wins. A loss mark, an open loss, a decline, or
 * did_not_go_through is lost. What remains is accepted, a better-rate
 * ask, a quote (including an expired one), or waiting.
 */
export function searchStatusOf(row: {
  went_through?: boolean | null;
  outcome?: string | null;
  rate_written_at?: string | null;
  payment_confirmed_at?: string | null;
  loss_approved_at?: string | null;
  loss_reason?: string | null;
  client_reply?: string | null;
  quote_status?: string | null;
  quote_state?: string | null;
  loss_open?: boolean | null;
  better_decision?: string | null;
}): Exclude<SearchStatus, 'all'> {
  if (row.went_through || row.outcome === 'went_through' || row.rate_written_at || row.payment_confirmed_at) return 'completed';
  if (
    row.loss_approved_at
    || (row.loss_reason ?? '').trim()
    || row.loss_open
    || row.outcome === 'did_not_go_through'
    || row.client_reply === 'declined'
    || row.quote_status === 'declined'
    || row.quote_state === 'declined'
  ) return 'lost';
  if (row.client_reply === 'approved') return 'accepted';
  if (row.client_reply === 'better' && !row.better_decision) return 'better';
  if (row.quote_status === 'quoted' || row.quote_state === 'quoted' || row.quote_state === 'expired') return 'quoted';
  return 'waiting';
}

export function searchPair(row: { sells_currency?: string | null; gets_currency?: string | null }): string {
  if (!row.sells_currency || !row.gets_currency) return '';
  return `${row.sells_currency} / ${row.gets_currency}`;
}

function statusSteps(status: SearchStatus): SearchStep[] {
  if (status === 'all') return [];
  if (status === 'completed') {
    return [{ op: 'or', filters: 'went_through.eq.true,outcome.eq.went_through,rate_written_at.not.is.null,payment_confirmed_at.not.is.null' }];
  }
  if (status === 'lost') {
    return [
      ...NOT_COMPLETED,
      { op: 'or', filters: 'loss_reason.not.is.null,loss_approved_at.not.is.null,loss_open.eq.true,outcome.eq.did_not_go_through,client_reply.eq.declined,quote_status.eq.declined,quote_state.eq.declined' },
    ];
  }
  if (status === 'accepted') {
    return [
      ...NOT_COMPLETED,
      ...NOT_LOSS_MARK,
      ...NOT_QUOTE_DECLINE,
      { op: 'eq', column: 'client_reply', value: 'approved' },
    ];
  }
  if (status === 'better') {
    return [
      ...NOT_COMPLETED,
      ...NOT_LOSS_MARK,
      ...NOT_QUOTE_DECLINE,
      { op: 'eq', column: 'client_reply', value: 'better' },
      { op: 'is', column: 'better_decision', value: null },
    ];
  }
  if (status === 'quoted') {
    return [
      ...NOT_COMPLETED,
      ...NOT_LOSS_MARK,
      ...NOT_QUOTE_DECLINE,
      { op: 'or', filters: 'quote_status.eq.quoted,quote_state.eq.quoted,quote_state.eq.expired' },
      { op: 'or', filters: 'client_reply.is.null,and(client_reply.eq.better,better_decision.not.is.null)' },
    ];
  }
  return [
    ...NOT_COMPLETED,
    ...NOT_LOSS_MARK,
    ...NOT_QUOTE_DECLINE,
    { op: 'is', column: 'client_reply', value: null },
    { op: 'or', filters: 'quote_status.is.null,quote_status.eq.asking' },
    { op: 'or', filters: 'quote_state.is.null,quote_state.eq.asking' },
  ];
}

export function searchPlan(input: SearchInput): SearchPlan {
  const steps: SearchStep[] = [{ op: 'eq', column: 'kam_id', value: input.kamId }];
  if (input.dates !== 'all') {
    steps.push({ op: 'gte', column: 'request_date', value: daysBefore(input.today, LAST_30_BACK) });
    steps.push({ op: 'lte', column: 'request_date', value: input.today });
  }
  const textOr = textOrFilter(searchNeedle(input.text));
  if (textOr) steps.push({ op: 'or', filters: textOr });
  steps.push(...statusSteps(input.status));
  const pair = pairParts(input.pair);
  if (pair) {
    steps.push({ op: 'eq', column: 'sells_currency', value: pair.sells });
    steps.push({ op: 'eq', column: 'gets_currency', value: pair.gets });
  }
  return {
    steps,
    offset: Math.max(0, Math.floor(input.offset)),
    limit: SEARCH_PAGE,
  };
}

export function applySearchFilters(query: SearchChain, plan: SearchPlan): SearchChain {
  return plan.steps.reduce((current, step) => {
    if (step.op === 'eq') return current.eq(step.column, step.value);
    if (step.op === 'neq') return current.neq(step.column, step.value);
    if (step.op === 'is') return current.is(step.column, step.value);
    if (step.op === 'gte') return current.gte(step.column, step.value);
    if (step.op === 'lte') return current.lte(step.column, step.value);
    return current.or(step.filters);
  }, query);
}

export function readSearchState(params: URLSearchParams): { text: string; status: SearchStatus; dates: SearchDates; pair: string } {
  const statusRaw = params.get('st') ?? '';
  const status = (SEARCH_STATUSES as readonly string[]).includes(statusRaw) && statusRaw !== 'all'
    ? statusRaw as SearchStatus
    : 'all';
  const dates: SearchDates = params.get('dt') === 'all' ? 'all' : '30';
  const pairRaw = params.get('pair') ?? '';
  const pair = pairParts(pairRaw) ? pairRaw : 'all';
  return { text: (params.get('q') ?? '').slice(0, 80), status, dates, pair };
}

export function writeSearchParams(
  current: URLSearchParams,
  state: { text: string; status: SearchStatus; dates: SearchDates; pair: string },
): URLSearchParams {
  const next = new URLSearchParams(current);
  const text = state.text.trim().slice(0, 80);
  if (text) next.set('q', text);
  else next.delete('q');
  if (state.status !== 'all') next.set('st', state.status);
  else next.delete('st');
  if (state.dates === 'all') next.set('dt', 'all');
  else next.delete('dt');
  if (pairParts(state.pair)) next.set('pair', state.pair);
  else next.delete('pair');
  return next;
}
