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
