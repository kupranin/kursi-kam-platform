import { deferredIds } from '../../lib/deferWrite';
import { supabase, rpc } from '../../lib/supabase';
import { todayTbilisi } from '../../lib/format';
import { isMissingRead } from '../../lib/missingRead';
import { dealLeftOpen } from '../../lib/requestStatus';
import { bankList, type QueueRow } from '../../lib/types';

/** Same distance check the desktop rate card uses before sending. */
export const FAR_PCT = 3;

export const DECLINE_REASONS = [
  'Amount too large',
  'Market moving too fast',
  'Need more details',
] as const;

/** A client reply the desk already loads. Not a new row shape. */
export interface TreasuryReply {
  request_id: number;
  kam_name: string;
  client_id: string;
  client_name: string | null;
  sells_currency: string;
  gets_currency: string;
  amount: number | null;
  gets_amount: number | null;
  rate: number | null;
  client_reply: 'approved' | 'better' | 'declined';
  approved_rate: number | null;
  wanted_rate: number | null;
  better_decision: 'accepted' | 'corrected' | null;
  given_rate: number | null;
  client_decline_reason: string | null;
  client_replied_at: string | null;
  note: string | null;
}

/**
 * Written, paid, or lost rows. Same lookup the desktop desk uses, so a
 * closed deal leaves the phone queues too. A failed lookup leaves them up.
 */
async function closedIds(ids: number[]): Promise<Set<number>> {
  const closed = new Set<number>();
  if (!ids.length) return closed;
  const full = await supabase.from('request_outcomes')
    .select('id, rate_written_at, payment_confirmed_at, went_through, loss_open, loss_reason, loss_approved_at, outcome')
    .in('id', ids);
  const marks = full.error
    ? await supabase.from('requests').select('id, rate_written_at').in('id', ids)
    : full;
  if (marks.error || !marks.data) return closed;
  for (const row of marks.data as {
    id: number;
    rate_written_at?: string | null;
    payment_confirmed_at?: string | null;
    went_through?: boolean | null;
    loss_open?: boolean | null;
    loss_reason?: string | null;
    loss_approved_at?: string | null;
    outcome?: string | null;
  }[]) {
    if (dealLeftOpen(row)) closed.add(row.id);
  }
  return closed;
}

/** Waiting for an initial rate. `treasury_queue` is already oldest first. */
export async function loadWaitingQueue(): Promise<QueueRow[]> {
  const q = await rpc<QueueRow[]>('treasury_queue');
  const queueRows = q ?? [];
  const closed = await closedIds(queueRows.map((row) => row.request_id));
  return queueRows.filter((row) => !closed.has(row.request_id));
}

function byOldestReply(a: TreasuryReply, b: TreasuryReply): number {
  const am = a.client_replied_at ? new Date(a.client_replied_at).getTime() : Number.POSITIVE_INFINITY;
  const bm = b.client_replied_at ? new Date(b.client_replied_at).getTime() : Number.POSITIVE_INFINITY;
  if (am !== bm) return am - bm;
  return a.request_id - b.request_id;
}

/**
 * Better-rate replies and accepted rates still to write.
 * Same `treasury_client_replies` read and the same short approved slice
 * the desktop desk uses. Not the day table and not the market grid.
 */
export async function loadActionReplies(): Promise<{ better: TreasuryReply[]; write: TreasuryReply[] }> {
  const list = (await rpc<TreasuryReply[]>('treasury_client_replies')) ?? [];
  const olderCols = 'id, kam_name, client_id, client_name, sells_currency, gets_currency, amount, gets_amount, rate, approved_rate, client_reply, note';
  const olderActive = await supabase
    .from('request_active')
    .select(olderCols)
    .eq('source', 'app')
    .eq('client_reply', 'approved')
    .gte('request_date', todayTbilisi(-14))
    .order('requested_at', { ascending: false })
    .limit(40);
  const olderRes = olderActive.error && isMissingRead(olderActive.error)
    ? await supabase
      .from('request_outcomes')
      .select(olderCols)
      .eq('source', 'app')
      .eq('client_reply', 'approved')
      .gte('request_date', todayTbilisi(-14))
      .order('requested_at', { ascending: false })
      .limit(40)
    : olderActive;
  const older = olderRes.data;
  const extras: TreasuryReply[] = ((older ?? []) as {
    id: number; kam_name: string | null; client_id: string; client_name: string | null;
    sells_currency: string | null; gets_currency: string | null; amount: number | null; gets_amount: number | null;
    rate: number | null; approved_rate: number | null; note: string | null;
  }[])
    .filter((row) => row.approved_rate != null && !list.some((item) => item.request_id === row.id))
    .map((row) => ({
      request_id: row.id,
      kam_name: row.kam_name ?? '',
      client_id: row.client_id,
      client_name: row.client_name,
      sells_currency: row.sells_currency ?? '',
      gets_currency: row.gets_currency ?? '',
      amount: row.amount,
      gets_amount: row.gets_amount,
      rate: row.rate,
      client_reply: 'approved',
      approved_rate: row.approved_rate,
      wanted_rate: null,
      better_decision: null,
      given_rate: null,
      client_decline_reason: null,
      client_replied_at: null,
      note: row.note,
    }));
  const ids = [...list.map((row) => row.request_id), ...extras.map((row) => row.request_id)];
  const closed = await closedIds(ids);
  const held = await deferredIds(ids);
  const stillHere = (row: TreasuryReply) => !closed.has(row.request_id) && !held.has(row.request_id) && row.client_reply !== 'declined';
  const open = list.filter(stillHere);
  const better = open
    .filter((row) => row.client_reply === 'better' && !row.better_decision)
    .sort(byOldestReply);
  const betterIds = new Set(better.map((row) => row.request_id));
  const write = [
    ...open.filter((row) => row.client_reply === 'approved' && !betterIds.has(row.request_id)),
    ...extras.filter((row) => !closed.has(row.request_id) && !held.has(row.request_id) && !betterIds.has(row.request_id)),
  ].sort(byOldestReply);
  return { better, write };
}

/** Banks already shown on the desktop card. One lookup for the visible ids. */
export async function loadRequestBanks(ids: number[]): Promise<Record<number, string[]>> {
  const next: Record<number, string[]> = {};
  if (!ids.length) return next;
  const withSet = await supabase.from('requests').select('id, bank, banks').in('id', ids);
  const res = withSet.error
    ? await supabase.from('requests').select('id, bank').in('id', ids)
    : withSet;
  if (res.error || !res.data) return next;
  for (const row of res.data as { id: number; bank: string | null; banks?: string[] | string | null }[]) {
    const fromSet = bankList(row.banks);
    const picked = fromSet.length ? fromSet : bankList(row.bank);
    if (picked.length) next[row.id] = picked;
  }
  return next;
}

/** The desk's default validity. Falls back to 15, same as the desktop card. */
export async function loadDefaultValid(): Promise<number> {
  const { data } = await supabase.from('rules').select('default_quote_minutes').single();
  const minutes = data?.default_quote_minutes;
  return minutes === 5 || minutes === 15 || minutes === 30 ? minutes : 15;
}

/** A waiting row drops out of the other two sections, and a better-rate row is not also "to write". */
export function placeQueues(waiting: QueueRow[], better: TreasuryReply[], write: TreasuryReply[]): {
  waiting: QueueRow[];
  better: TreasuryReply[];
  write: TreasuryReply[];
} {
  const writeIds = new Set(write.map((row) => row.request_id));
  const betterOnly = better.filter((row) => !writeIds.has(row.request_id));
  const later = new Set([...betterOnly.map((row) => row.request_id), ...writeIds]);
  return {
    waiting: waiting.filter((row) => !later.has(row.request_id)),
    better: betterOnly,
    write: write.filter((row) => !betterOnly.some((row2) => row2.request_id === row.request_id)),
  };
}
