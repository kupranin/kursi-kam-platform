import * as XLSX from 'xlsx';

export interface UploadRow {
  tx_id: string;
  tx_date: string;
  client_id: string;
  client_name: string | null;
  segment: string | null;
  operation_type: string | null;
  payment_status: string;
  abs_gel: number;
  cross_gel: number;
  total_income: number;
  spread_income: number | null;
  revaluation: number | null;
}

const SKIP_OPS = new Set(['position-close-in-bank', 'fastoo', 'bitnet', 'unipay']);

function headerKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function pick(row: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (name in row && row[name] !== '' && row[name] != null) return row[name];
  }
  return undefined;
}

function textId(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.round(value));
  return String(value ?? '').trim().replace(/\.0$/, '');
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  let s = String(value).trim().replace(/\s/g, '');
  if (!s || s.toUpperCase() === 'N/N') return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function numberOrZero(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

/** Calendar date as YYYY-MM-DD. The business export uses month/day/year. */
export function toIsoDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    const m = String(parsed.m).padStart(2, '0');
    const d = String(parsed.d).padStart(2, '0');
    return `${parsed.y}-${m}-${d}`;
  }
  const s = String(value ?? '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parts = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (!parts) return null;
  let month = Number(parts[1]);
  let day = Number(parts[2]);
  let year = Number(parts[3]);
  if (year < 100) year += 2000;
  if (month > 12 && day <= 12) {
    const swap = month;
    month = day;
    day = swap;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeId(raw: string): string {
  const v = raw.replace(/\s/g, '').replace(/\.0+$/, '');
  return /^\d{10}$/.test(v) ? '0' + v : v;
}

export function rowsFromSheet(records: Record<string, unknown>[]): { rows: UploadRow[]; skipped: number } {
  const rows: UploadRow[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const record of records) {
    const keyed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) keyed[headerKey(key)] = value;
    const txId = textId(pick(keyed, ['transaction_id', 'tx_id', 'id']));
    const txDate = toIsoDate(pick(keyed, ['created at', 'created_at', 'date', 'tx_date']));
    const clientId = normalizeId(textId(pick(keyed, ['sender id', 'sender_id', 'client_id', 'client id'])));
    const status = textId(pick(keyed, ['payment status', 'payment_status'])).toUpperCase();
    const operation = textId(pick(keyed, ['operation type', 'operation_type'])) || null;
    if (!txId || !txDate || !clientId || !status || (operation && SKIP_OPS.has(operation.toLowerCase())) || seen.has(txId)) {
      skipped += 1;
      continue;
    }
    seen.add(txId);
    const name = textId(pick(keyed, ['sender name', 'sender_name', 'client name', 'name']));
    rows.push({
      tx_id: txId,
      tx_date: txDate,
      client_id: clientId,
      client_name: name && name.toLowerCase() !== 'null' ? name.slice(0, 200) : null,
      segment: textId(pick(keyed, ['client_type', 'client type', 'segment'])) || null,
      operation_type: operation,
      payment_status: status,
      abs_gel: numberOrZero(pick(keyed, ['abs_gel'])),
      cross_gel: numberOrZero(pick(keyed, ['cross_gel'])),
      total_income: numberOrZero(pick(keyed, ['total_income'])),
      spread_income: numberOrNull(pick(keyed, ['spread_income'])),
      revaluation: numberOrNull(pick(keyed, ['revaluation income/(loss)', 'revaluation', 'revaluation_income'])),
    });
  }
  return { rows, skipped };
}

export async function readTransactionFile(file: File): Promise<{ rows: UploadRow[]; skipped: number }> {
  const book = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const sheet = book.Sheets[book.SheetNames[0]];
  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: true });
  return rowsFromSheet(records);
}
