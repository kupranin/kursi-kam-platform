/**
 * All-time client owner.
 *
 * private.owners(p_from, p_to) is a different rule: the month window,
 * highest count, and a tie goes to the latest requested_at. monthWindowOwner
 * copies that tie-break so tests can tell the two apart. It is not the
 * client owner on screen.
 *
 * allTimeClientOwner counts every request, all sources, all time. The
 * highest count wins. A tie for that count is unresolved. assigned_kam_id,
 * when set, wins over the count, including on a tie. Clearing it restores
 * the counted owner. Neither function writes requests.kam_id.
 */

export const ALL_TIME_OWNER_RULE = 'all-time-count' as const;
export const MONTH_WINDOW_OWNER_RULE = 'private.owners' as const;

export interface KamCount {
  kamId: string | null | undefined;
  count: number;
}

export interface AllTimeOwner {
  rule: typeof ALL_TIME_OWNER_RULE;
  kind: 'override' | 'computed' | 'unresolved';
  kamId: string | null;
}

export interface MonthRequest {
  kamId: string | null | undefined;
  requestedAt: string;
}

export type OwnerState = 'named' | 'deleted' | 'unresolved' | 'none';
export type OwnerSource = 'override' | 'computed' | 'unresolved';
export type Lang = 'ka' | 'en';

export interface EffectiveOwner {
  clientId: string;
  ownerId: string | null;
  ownerName: string | null;
  state: 'named' | 'deleted' | 'unresolved';
  source: OwnerSource;
  overrideId: string | null;
}

function cleanId(value: string | null | undefined): string | null {
  const id = value?.trim() ?? '';
  return id || null;
}

/** Highest all-time request count. A tie stays unresolved. An override wins. */
export function allTimeClientOwner(input: {
  assignedKamId: string | null | undefined;
  counts: KamCount[];
}): AllTimeOwner {
  const assigned = cleanId(input.assignedKamId);
  if (assigned) return { rule: ALL_TIME_OWNER_RULE, kind: 'override', kamId: assigned };

  const totals = new Map<string, number>();
  for (const row of input.counts) {
    const id = cleanId(row.kamId);
    if (!id || !(row.count > 0)) continue;
    totals.set(id, (totals.get(id) ?? 0) + row.count);
  }

  let top = 0;
  for (const count of totals.values()) if (count > top) top = count;
  const leaders = [...totals.entries()].filter(([, count]) => count === top);
  if (top === 0 || leaders.length !== 1) {
    return { rule: ALL_TIME_OWNER_RULE, kind: 'unresolved', kamId: null };
  }
  return { rule: ALL_TIME_OWNER_RULE, kind: 'computed', kamId: leaders[0][0] };
}

/**
 * Month-window owner, the rule inside private.owners(p_from, p_to).
 * Highest count in the rows you pass, and a tie goes to the latest requested_at.
 * This is not allTimeClientOwner and it is not labeled as the client owner.
 */
export function monthWindowOwner(rows: MonthRequest[]): string | null {
  const totals = new Map<string, { count: number; last: string }>();
  for (const row of rows) {
    const id = cleanId(row.kamId);
    if (!id) continue;
    const current = totals.get(id);
    if (!current) totals.set(id, { count: 1, last: row.requestedAt });
    else {
      current.count += 1;
      if (row.requestedAt > current.last) current.last = row.requestedAt;
    }
  }
  let best: { kamId: string; count: number; last: string } | null = null;
  for (const [kamId, info] of totals) {
    if (!best || info.count > best.count || (info.count === best.count && info.last > best.last)) {
      best = { kamId, count: info.count, last: info.last };
    }
  }
  return best?.kamId ?? null;
}

/** Month portfolio rows only. A zero client count is not a request-performance row. */
export function monthPortfolioRows<T extends { clients: number | string | null }>(rows: T[]): T[] {
  return rows.filter((row) => Number(row.clients) > 0);
}

/** Request-KAM wins. These counts are not the month portfolio client count. */
export function requestKamRows<T extends { requests_judged: number | string | null; requests_won: number | string | null }>(rows: T[]): T[] {
  return rows.filter((row) => Number(row.requests_judged) > 0 || Number(row.requests_won) > 0);
}

/**
 * Database edit_request, delete_request, and the KAM update trigger use this
 * same split: a KAM only when requests.kam_id is theirs, otherwise only an admin.
 * Manager, treasury, and analyst are not the admin exception.
 */
export function kamMayEditRequest(
  realRole: string,
  profileId: string | null | undefined,
  requestKamId: string | null | undefined,
): boolean {
  if (realRole === 'admin') return true;
  return realRole === 'kam' && !!profileId && !!requestKamId && requestKamId === profileId;
}

/** Same digits private.normalize_client_id keeps: strip spaces and a trailing .0, and restore a 10-digit leading zero. */
export function normalizeClientId(raw: string | null | undefined): string {
  const v = String(raw ?? '').replace(/\s/g, '').replace(/\.0+$/, '');
  return /^[0-9]{10}$/.test(v) ? `0${v}` : v;
}

/**
 * Ids client_special_rates will read. Distinct normalized ids, lowest text first, at most 100.
 * A different input order cannot drop a different id.
 */
export function cappedClientIds(ids: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const raw of ids) {
    const id = normalizeClientId(raw);
    if (/^([0-9]{9}|[0-9]{11})$/.test(id)) unique.add(id);
  }
  return [...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 100);
}

/** Read follows clients the caller can already open. Ownership is not required. */
export function kamMayReadSpecialRates(input: { role: string; canViewClient: boolean }): boolean {
  if (!input.canViewClient) return false;
  return input.role === 'admin' || input.role === 'manager' || input.role === 'treasury' || input.role === 'kam';
}

/** Write stays admin, treasury, or a KAM for a client already in their book. */
export function kamMayWriteSpecialRates(input: { role: string; isMyClient: boolean }): boolean {
  if (input.role === 'admin' || input.role === 'treasury') return true;
  return input.role === 'kam' && input.isMyClient;
}

/** UI gate. The database gate is private.is_admin() on clients_admin_update. */
export function maySetOwnerOverride(realRole: string, viewedRole: string): boolean {
  return realRole === 'admin' && viewedRole === 'admin';
}

export function ownerDisplayText(
  state: OwnerState | 'missing' | undefined,
  name: string | null | undefined,
  lang: Lang,
): string {
  const ka = lang !== 'en';
  if (state === 'deleted') return ka ? 'წაშლილი პროფილი' : 'Deleted profile';
  if (state === 'unresolved') return ka ? 'განუსაზღვრელია' : 'Unresolved';
  if (state === 'named') return name?.trim() || (ka ? 'სახელი არ არის' : 'No name');
  if (state === 'none') return ka ? 'არ არის მინიჭებული' : 'Not assigned';
  return ka ? 'მფლობელი ვერ ჩაიტვირთა' : 'The owner could not be loaded';
}

export function ownerSourceCaption(source: OwnerSource, lang: Lang): string {
  const ka = lang !== 'en';
  if (source === 'override') return ka ? 'ადმინის გადაფარვა.' : 'Admin override.';
  if (source === 'computed') {
    return ka
      ? 'გადაფარვა არ არის. მფლობელი მოთხოვნების რაოდენობით ითვლება.'
      : 'No override. The owner is the highest request count.';
  }
  return ka
    ? 'გადაფარვა არ არის და ერთი გამარჯვებული არ არის.'
    : 'No override and no single winner.';
}

function personName(id: unknown, names: Record<string, string>): string {
  const key = String(id ?? '');
  return names[key]?.trim() || 'წაშლილი პროფილი';
}

/** Activity line for a clients audit row. Names the old and new override. */
export function describeClientAudit(
  action: string,
  rowKey: string | null,
  oldData: Record<string, unknown> | null,
  newData: Record<string, unknown> | null,
  names: Record<string, string>,
): string {
  const previous = oldData ?? {};
  const next = newData ?? {};
  const id = String(next.client_id ?? previous.client_id ?? rowKey ?? '');
  if (action === 'insert') {
    const base = `დაემატა კლიენტი ${id}${next.name ? ' (' + String(next.name) + ')' : ''}`;
    if (next.assigned_kam_id) return `${base}. კლიენტის მფლობელი: ${personName(next.assigned_kam_id, names)}`;
    return base;
  }
  if (action === 'update') {
    const oldId = previous.assigned_kam_id ?? null;
    const newId = next.assigned_kam_id ?? null;
    if (String(oldId ?? '') !== String(newId ?? '')) {
      const oldName = oldId ? personName(oldId, names) : 'გადაფარვა არ იყო';
      const newName = newId ? personName(newId, names) : 'გადაფარვა მოხსნილია';
      return `კლიენტის მფლობელი შეიცვალა ${rowKey ?? id}: ${oldName} → ${newName}`;
    }
  }
  return `შეიცვალა კლიენტი ${rowKey ?? id}`;
}
