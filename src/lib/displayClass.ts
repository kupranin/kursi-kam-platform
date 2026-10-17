export type DisplayClass = 'won' | 'lost' | 'open';

/** Imported workbook rows, including an agreement key on any source. */
export function isHistoricalRequest(row: {
  source?: string | null;
  import_key?: string | null;
}): boolean {
  return row.source === 'import' || (row.import_key ?? '').startsWith('agreement:');
}

/**
 * Client-facing won / lost / open.
 * Historical imports are never open: two completed file statuses are won,
 * and every other legacy status, including blank and unknown, is lost.
 * A new platform row follows the V1 rule: won only with rate_written_at,
 * lost only on an explicit decline or loss mark, otherwise open.
 * This does not write rate_written_at or payment_confirmed_at.
 */
export function displayClass(row: {
  source?: string | null;
  import_key?: string | null;
  legacy_status?: string | null;
  rate_written_at?: string | null;
  marked_lost_at?: string | null;
  loss_reason?: string | null;
  client_reply?: string | null;
  quote_status?: string | null;
}): DisplayClass {
  if (isHistoricalRequest(row)) {
    const status = (row.legacy_status ?? '').trim();
    if (status === 'შესრულდა' || status === 'შესრულდა ნაწილობრივ') return 'won';
    return 'lost';
  }
  if (row.rate_written_at) return 'won';
  if (
    row.marked_lost_at
    || (row.loss_reason ?? '').trim()
    || row.client_reply === 'declined'
    || row.quote_status === 'declined'
  ) return 'lost';
  return 'open';
}
