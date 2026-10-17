import { rpc } from './supabase';

/** Server aggregate from analytics_request_kpis. Money is already rounded to tetri. */
export interface ReasonStat {
  label: string;
  count: number;
  lostAbsGel: number | null;
  absUnavailable: number;
  absPending: number;
}

export interface KamKpi {
  kamId: string | null;
  name: string | null;
  state: 'named' | 'unassigned' | 'deleted';
  total: number;
  won: number;
  lost: number;
  open: number;
  absGel: number | null;
  absUnavailable: number;
  absPending: number;
  wonAbsGel: number | null;
  wonAbsUnavailable: number;
  wonAbsPending: number;
  lostAbsGel: number | null;
  lostAbsUnavailable: number;
  lostAbsPending: number;
}

export interface RequestKpis {
  total: number;
  won: number;
  lost: number;
  open: number;
  absGel: number | null;
  absUnavailable: number;
  absPending: number;
  wonAbsGel: number | null;
  wonAbsUnavailable: number;
  wonAbsPending: number;
  lostAbsGel: number | null;
  lostAbsUnavailable: number;
  lostAbsPending: number;
  reasons: ReasonStat[];
  kams: KamKpi[];
}

export interface AbsValuation {
  id: number;
  requestAbsGel: number | null;
  valuationCurrency: string | null;
  valuationRate: number | null;
  valuationTimestamp: string | null;
  valuationSource: string | null;
  valuationStatus: string | null;
}

export interface ClientBriefData {
  status: 'ok' | 'new_client' | 'invalid_id';
  clientId: string;
  clientName: string | null;
  assignedKamName: string | null;
  assignedKamState: 'named' | 'none' | 'deleted';
  total: number;
  won: number;
  lost: number;
  open: number;
  lastRequestDate: string | null;
  lossWarning: 'none' | 'last_lost' | 'last_three';
  lossReasons: string[];
  inactiveDays: number | null;
  inactive: boolean;
}

export interface ClientHistoryRow {
  id: number;
  requestDate: string;
  sellsCurrency: string | null;
  getsCurrency: string | null;
  receivedAmount: number | null;
  requestAbsGel: number | null;
  valuationStatus: string | null;
  kpiClass: string;
  lossReason: string | null;
  kamName: string | null;
  ownerName: string | null;
  legacyStatus: string | null;
}

function num(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function whole(value: unknown): number {
  return num(value) ?? 0;
}

function nextMonth(start: string): string {
  const [y, m] = start.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

interface RawKam {
  kam_id?: string | null;
  name?: string | null;
  state?: string | null;
  total?: number | string | null;
  won?: number | string | null;
  lost?: number | string | null;
  open?: number | string | null;
  abs_gel?: number | string | null;
  abs_unavailable?: number | string | null;
  abs_pending?: number | string | null;
  won_abs_gel?: number | string | null;
  won_abs_unavailable?: number | string | null;
  won_abs_pending?: number | string | null;
  lost_abs_gel?: number | string | null;
  lost_abs_unavailable?: number | string | null;
  lost_abs_pending?: number | string | null;
}

interface RawReason {
  label?: string | null;
  count?: number | string | null;
  lost_abs_gel?: number | string | null;
  abs_unavailable?: number | string | null;
  abs_pending?: number | string | null;
}

function asKpis(raw: Record<string, unknown> | null): RequestKpis {
  const reasons = Array.isArray(raw?.reasons) ? raw.reasons as RawReason[] : [];
  const kams = Array.isArray(raw?.kams) ? raw.kams as RawKam[] : [];
  return {
    total: whole(raw?.total),
    won: whole(raw?.won),
    lost: whole(raw?.lost),
    open: whole(raw?.open),
    absGel: num(raw?.abs_gel),
    absUnavailable: whole(raw?.abs_unavailable),
    absPending: whole(raw?.abs_pending),
    wonAbsGel: num(raw?.won_abs_gel),
    wonAbsUnavailable: whole(raw?.won_abs_unavailable),
    wonAbsPending: whole(raw?.won_abs_pending),
    lostAbsGel: num(raw?.lost_abs_gel),
    lostAbsUnavailable: whole(raw?.lost_abs_unavailable),
    lostAbsPending: whole(raw?.lost_abs_pending),
    reasons: reasons.map((row) => ({
      label: row.label ?? '',
      count: whole(row.count),
      lostAbsGel: num(row.lost_abs_gel),
      absUnavailable: whole(row.abs_unavailable),
      absPending: whole(row.abs_pending),
    })),
    kams: kams.map((row) => ({
      kamId: row.kam_id ?? null,
      name: row.name ?? null,
      state: row.state === 'unassigned' || row.state === 'deleted' ? row.state : 'named',
      total: whole(row.total),
      won: whole(row.won),
      lost: whole(row.lost),
      open: whole(row.open),
      absGel: num(row.abs_gel),
      absUnavailable: whole(row.abs_unavailable),
      absPending: whole(row.abs_pending),
      wonAbsGel: num(row.won_abs_gel),
      wonAbsUnavailable: whole(row.won_abs_unavailable),
      wonAbsPending: whole(row.won_abs_pending),
      lostAbsGel: num(row.lost_abs_gel),
      lostAbsUnavailable: whole(row.lost_abs_unavailable),
      lostAbsPending: whole(row.lost_abs_pending),
    })),
  };
}

/** p_to is the first day after the month. All time sends no dates. */
export async function loadRequestKpis(month: string, kamId: string | null): Promise<RequestKpis> {
  const args: Record<string, unknown> = {};
  if (month !== 'all') {
    args.p_from = month;
    args.p_to = nextMonth(month);
  }
  if (kamId) args.p_kam_id = kamId;
  const data = await rpc<Record<string, unknown> | null>('analytics_request_kpis', args);
  return asKpis(data);
}

export async function loadAbsValuations(ids: number[]): Promise<AbsValuation[]> {
  if (!ids.length) return [];
  const data = await rpc<Record<string, unknown>[]>('request_abs_valuations', { p_ids: ids });
  return (data ?? []).map((row) => ({
    id: whole(row.id),
    requestAbsGel: num(row.request_abs_gel),
    valuationCurrency: (row.valuation_currency as string | null) ?? null,
    valuationRate: num(row.valuation_rate),
    valuationTimestamp: (row.valuation_timestamp as string | null) ?? null,
    valuationSource: (row.valuation_source as string | null) ?? null,
    valuationStatus: (row.valuation_status as string | null) ?? null,
  }));
}

export async function loadClientBrief(clientId: string): Promise<ClientBriefData> {
  const raw = await rpc<Record<string, unknown>>('client_request_brief', { p_client_id: clientId });
  const status = raw?.status === 'new_client' || raw?.status === 'invalid_id' ? raw.status : 'ok';
  const reasons = Array.isArray(raw?.loss_reasons) ? raw.loss_reasons.map((item) => String(item ?? '')) : [];
  const warning = raw?.loss_warning === 'last_three' || raw?.loss_warning === 'last_lost' ? raw.loss_warning : 'none';
  const assigned = raw?.assigned_kam_state === 'named' || raw?.assigned_kam_state === 'deleted' ? raw.assigned_kam_state : 'none';
  return {
    status,
    clientId: String(raw?.client_id ?? clientId),
    clientName: (raw?.client_name as string | null) ?? null,
    assignedKamName: (raw?.assigned_kam_name as string | null) ?? null,
    assignedKamState: assigned,
    total: whole(raw?.total),
    won: whole(raw?.won),
    lost: whole(raw?.lost),
    open: whole(raw?.open),
    lastRequestDate: (raw?.last_request_date as string | null) ?? null,
    lossWarning: warning,
    lossReasons: reasons,
    inactiveDays: num(raw?.inactive_days),
    inactive: raw?.inactive === true,
  };
}

export async function loadClientHistory(clientId: string, offset: number): Promise<ClientHistoryRow[]> {
  const data = await rpc<Record<string, unknown>[]>('client_request_history', {
    p_client_id: clientId,
    p_offset: offset,
    p_limit: 21,
  });
  return (data ?? []).map((row) => ({
    id: whole(row.id),
    requestDate: String(row.request_date ?? ''),
    sellsCurrency: (row.sells_currency as string | null) ?? null,
    getsCurrency: (row.gets_currency as string | null) ?? null,
    receivedAmount: num(row.received_amount),
    requestAbsGel: num(row.request_abs_gel),
    valuationStatus: (row.valuation_status as string | null) ?? null,
    kpiClass: String(row.kpi_class ?? 'open'),
    lossReason: (row.loss_reason as string | null) ?? null,
    kamName: (row.kam_name as string | null) ?? null,
    ownerName: (row.owner_name as string | null) ?? null,
    legacyStatus: (row.legacy_status as string | null) ?? null,
  }));
}
