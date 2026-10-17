/**
 * Older client-side request counts. The analytics page no longer calls this.
 * KPIs come from public.analytics_request_kpis.
 */
import { displayClass } from './displayClass';
import { lossReasonLabel } from './requestStatus';
import { asAmount, requestGel } from './requestGel';
import { supabase } from './supabase';

/** One analysis row, only the fields the KAM breakdown counts. */
export interface DealSlice {
  kam_name: string | null;
  status: string | null;
  loss_reason: string | null;
  amount_gel: number | string | null;
}

export interface ReasonCount {
  /** Empty when the lost row has no reason text. */
  label: string;
  count: number;
}

export interface KamStat {
  name: string;
  total: number;
  success: number;
  lost: number;
  open: number;
  /** Lari amount on successful requests. A blank GEL cell adds nothing. */
  gel: number;
  reasons: ReasonCount[];
}

export interface KamBreakdown {
  total: number;
  success: number;
  lost: number;
  open: number;
  gel: number;
  reasons: ReasonCount[];
  kams: KamStat[];
}

/** The reason name, without the note that follows it. */
export function reasonLabel(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  if (!text) return '';
  const head = text.split('. ')[0]?.trim();
  return head || text;
}

function gelOf(value: number | string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function reasonsOf(map: Map<string, number>): ReasonCount[] {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ka'));
}

/** Totals, lost reasons, and the same figures for each KAM. */
export function summarizeKamDeals(rows: readonly DealSlice[]): KamBreakdown {
  const byKam = new Map<string, KamStat & { reasonMap: Map<string, number> }>();
  const allReasons = new Map<string, number>();
  let total = 0;
  let success = 0;
  let lost = 0;
  let open = 0;
  let gel = 0;

  for (const row of rows) {
    const name = (row.kam_name ?? '').trim() || '—';
    let bucket = byKam.get(name);
    if (!bucket) {
      bucket = { name, total: 0, success: 0, lost: 0, open: 0, gel: 0, reasons: [], reasonMap: new Map() };
      byKam.set(name, bucket);
    }
    bucket.total += 1;
    total += 1;
    if (row.status === 'success') {
      bucket.success += 1;
      success += 1;
      const amount = gelOf(row.amount_gel);
      bucket.gel += amount;
      gel += amount;
    } else if (row.status === 'lost') {
      bucket.lost += 1;
      lost += 1;
      const label = reasonLabel(row.loss_reason);
      bucket.reasonMap.set(label, (bucket.reasonMap.get(label) ?? 0) + 1);
      allReasons.set(label, (allReasons.get(label) ?? 0) + 1);
    } else {
      bucket.open += 1;
      open += 1;
    }
  }

  const kams = [...byKam.values()]
    .map((bucket) => ({
      name: bucket.name,
      total: bucket.total,
      success: bucket.success,
      lost: bucket.lost,
      open: bucket.open,
      gel: bucket.gel,
      reasons: reasonsOf(bucket.reasonMap),
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ka'));

  return { total, success, lost, open, gel, reasons: reasonsOf(allReasons), kams };
}

function nextMonth(start: string): string {
  const [y, m] = start.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** Every analysis row in the period. Pages until the list ends. */
export async function loadKamDeals(month: string): Promise<DealSlice[]> {
  const rows: DealSlice[] = [];
  for (let start = 0; ; start += 1000) {
    let query = supabase
      .from('analyst_deals')
      .select('kam_name, status, loss_reason, amount_gel, request_date')
      .order('id', { ascending: true });
    if (month !== 'all') {
      query = query.gte('request_date', month).lt('request_date', nextMonth(month));
    }
    const { data, error } = await query.range(start, start + 999);
    if (error) throw error;
    const page = (data ?? []) as DealSlice[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

interface OwnRow {
  id: number;
  request_date: string;
  kam_name: string | null;
  went_through: boolean | null;
  outcome: string | null;
  loss_open: boolean | null;
  loss_reason: string | null;
  loss_reason_note: string | null;
  source?: string | null;
  import_key?: string | null;
  legacy_status?: string | null;
  rate_written_at?: string | null;
  marked_lost_at?: string | null;
  client_reply?: string | null;
  quote_status?: string | null;
  client_decline_reason: string | null;
  decline_reason: string | null;
  sells_currency: string | null;
  gets_currency: string | null;
  amount: number | string | null;
  gets_amount: number | string | null;
  rate: number | string | null;
  approved_rate: number | string | null;
}

const OWN_COLUMNS = 'id, request_date, kam_name, went_through, outcome, loss_open, loss_reason, loss_reason_note, client_decline_reason, decline_reason, sells_currency, gets_currency, amount, gets_amount, rate, approved_rate';

function ownStatus(row: OwnRow): 'success' | 'lost' | 'open' {
  const klass = displayClass(row);
  if (klass === 'won') return 'success';
  if (klass === 'lost') return 'lost';
  return 'open';
}

function ownReason(row: OwnRow): string {
  const parts = [
    lossReasonLabel(row.loss_reason, 'ka'),
    (row.loss_reason_note ?? '').trim(),
    (row.client_decline_reason ?? '').trim(),
    (row.decline_reason ?? '').trim(),
  ].filter(Boolean);
  return parts.join('. ');
}

/**
 * This KAM's requests only, from request_outcomes (their RLS).
 * Does not read analyst_deals. GEL is the request lari figure on success,
 * or requests.gel_amount when an admin has typed one. A blank lari adds nothing.
 */
export async function loadOwnKamDeals(month: string, kamId: string): Promise<DealSlice[]> {
  const raw: OwnRow[] = [];
  for (let start = 0; ; start += 1000) {
    let query = supabase
      .from('request_outcomes')
      .select(OWN_COLUMNS)
      .eq('kam_id', kamId)
      .order('id', { ascending: true });
    if (month !== 'all') {
      query = query.gte('request_date', month).lt('request_date', nextMonth(month));
    }
    const { data, error } = await query.range(start, start + 999);
    if (error) throw error;
    const page = (data ?? []) as OwnRow[];
    raw.push(...page);
    if (page.length < 1000) break;
  }

  const typed = new Map<number, number>();
  const facts = new Map<number, OwnRow>();
  for (let i = 0; i < raw.length; i += 200) {
    const slice = raw.slice(i, i + 200).map((row) => row.id);
    const { data, error } = await supabase.from('requests').select('id, gel_amount, source, import_key, legacy_status, rate_written_at, marked_lost_at, loss_reason, client_reply, quote_status').in('id', slice);
    if (error || !data) continue;
    for (const row of data as { id: number; gel_amount?: number | string | null; source?: string | null; import_key?: string | null; legacy_status?: string | null; rate_written_at?: string | null; marked_lost_at?: string | null; loss_reason?: string | null; client_reply?: string | null; quote_status?: string | null }[]) {
      const n = asAmount(row.gel_amount);
      if (n != null) typed.set(Number(row.id), n);
      facts.set(Number(row.id), row as OwnRow);
    }
  }
  const classified = raw.map((row) => ({ ...row, ...facts.get(row.id) }));

  return classified.map((row) => {
    const status = ownStatus(row);
    const typedGel = typed.get(row.id);
    const gel = status === 'success'
      ? (typedGel != null
        ? typedGel
        : requestGel(
          row.sells_currency,
          row.gets_currency,
          asAmount(row.amount),
          asAmount(row.gets_amount),
          asAmount(row.approved_rate) ?? asAmount(row.rate),
        ))
      : null;
    return {
      kam_name: row.kam_name,
      status,
      loss_reason: status === 'lost' ? ownReason(row) : null,
      amount_gel: gel,
    };
  });
}
