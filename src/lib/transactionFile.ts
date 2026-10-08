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

/** Server import_transactions rejects lists longer than this. */
const BATCH_SIZE = 1000;

/** Columns we will actually read. Excel's last column is XFD (16384). */
const MAX_SHEET_COLUMNS = 64;
const TALL_SHEET_ROWS = 100_000;
const EMPTY_ROW_STREAK = 5_000;

const TX_ID_HEADERS = ['transaction_id', 'transaction id', 'tx_id', 'tx id', 'id'];
const DATE_HEADERS = ['created at', 'created_at', 'date', 'tx_date'];
/** Used only after a real transaction id column has been found. sender + date is not an id. */
const CREATED_DATE_HEADERS = ['created_date', 'created date'];

export class TransactionFileError extends Error {
  readonly code: 'missing-tx-id' | 'range-too-wide';

  constructor(code: 'missing-tx-id' | 'range-too-wide') {
    super(code);
    this.name = 'TransactionFileError';
    this.code = code;
  }
}

function headerKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function pick(row: Record<string, unknown>, names: readonly string[]): unknown {
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

/** 9-digit company id stays. 11-digit person id stays. 10 digits get a leading 0. */
function normalizeId(raw: string): string {
  const v = raw.replace(/\s/g, '').replace(/\.0+$/, '');
  return /^\d{10}$/.test(v) ? '0' + v : v;
}

function hasTxIdHeader(headers: string[]): boolean {
  const keys = new Set(headers.map(headerKey));
  return TX_ID_HEADERS.some((name) => keys.has(headerKey(name)));
}

function oneRow(headers: string[], values: unknown[], seen: Set<string>, dateNames: readonly string[]): UploadRow | null {
  const keyed: Record<string, unknown> = {};
  for (let i = 0; i < headers.length; i++) {
    const key = headerKey(headers[i] ?? '');
    if (!key || Object.prototype.hasOwnProperty.call(keyed, key)) continue;
    const value = values[i];
    if (value == null || value === '') continue;
    keyed[key] = value;
  }
  const txId = textId(pick(keyed, TX_ID_HEADERS));
  const txDate = toIsoDate(pick(keyed, dateNames));
  const clientId = normalizeId(textId(pick(keyed, ['sender id', 'sender_id', 'client_id', 'client id'])));
  const status = textId(pick(keyed, ['payment status', 'payment_status'])).toUpperCase();
  const operation = textId(pick(keyed, ['operation type', 'operation_type'])) || null;
  if (!txId || !txDate || !clientId || !status || (operation && SKIP_OPS.has(operation.toLowerCase())) || seen.has(txId)) {
    return null;
  }
  seen.add(txId);
  const name = textId(pick(keyed, ['sender name', 'sender_name', 'client name', 'name']));
  return {
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
  };
}

export function rowsFromSheet(records: Record<string, unknown>[]): { rows: UploadRow[]; skipped: number } {
  if (!records.length) return { rows: [], skipped: 0 };
  let sample: string[];
  try {
    sample = Object.keys(records[0]);
  } catch (err) {
    if (err instanceof RangeError) throw new TransactionFileError('range-too-wide');
    throw err;
  }
  if (!hasTxIdHeader(sample)) throw new TransactionFileError('missing-tx-id');
  const dates = [...DATE_HEADERS, ...CREATED_DATE_HEADERS];
  const seen = new Set<string>();
  const rows: UploadRow[] = [];
  let skipped = 0;
  for (const record of records) {
    const headers = Object.keys(record);
    const row = oneRow(headers, headers.map((key) => record[key]), seen, dates);
    if (!row) skipped += 1;
    else rows.push(row);
  }
  return { rows, skipped };
}

function headerTexts(values: unknown[]): string[] {
  return values.map((value, index) => {
    const text = String(value ?? '').trim();
    return index === 0 ? text.replace(/^\uFEFF/, '') : text;
  });
}

async function consumeRows(
  source: AsyncIterable<unknown[]>,
  onBatch: (rows: UploadRow[]) => Promise<void>,
): Promise<{ skipped: number; sent: number }> {
  const iter = source[Symbol.asyncIterator]();
  let skipped = 0;
  let sent = 0;
  try {
    const first = await iter.next();
    if (first.done) throw new TransactionFileError('missing-tx-id');
    const headers = headerTexts(first.value);
    if (!hasTxIdHeader(headers)) throw new TransactionFileError('missing-tx-id');
    const dates = [...DATE_HEADERS, ...CREATED_DATE_HEADERS];
    const seen = new Set<string>();
    let batch: UploadRow[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const rows = batch;
      batch = [];
      sent += rows.length;
      await onBatch(rows);
    };
    while (true) {
      const step = await iter.next();
      if (step.done) break;
      const values = step.value;
      if (values.every((value) => value == null || String(value).trim() === '')) continue;
      const row = oneRow(headers, values, seen, dates);
      if (!row) {
        skipped += 1;
        continue;
      }
      batch.push(row);
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
    return { skipped, sent };
  } finally {
    await iter.return?.();
  }
}

function detectSep(line: string): string {
  let commas = 0;
  let semis = 0;
  let tabs = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (c === ',') commas += 1;
      else if (c === ';') semis += 1;
      else if (c === '\t') tabs += 1;
    }
  }
  if (semis > commas && semis >= tabs) return ';';
  if (tabs > commas && tabs > semis) return '\t';
  return ',';
}

function indexOfHeaderEnd(text: string): number {
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (!inQuotes && (c === '\n' || c === '\r')) return i;
  }
  return -1;
}

class FieldParser {
  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  private pendingCR = false;
  private sep: string;

  constructor(sep: string) {
    this.sep = sep;
  }

  push(text: string, flush: boolean): string[][] {
    const out: string[][] = [];
    const finish = () => {
      this.row.push(this.field);
      this.field = '';
      if (this.row.some((cell) => cell !== '')) out.push(this.row);
      this.row = [];
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (this.pendingCR) {
        this.pendingCR = false;
        if (c === '\n') continue;
      }
      if (this.inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            this.field += '"';
            i += 1;
          } else this.inQuotes = false;
        } else this.field += c;
        continue;
      }
      if (c === '"' && this.field === '') {
        this.inQuotes = true;
        continue;
      }
      if (c === this.sep) {
        this.row.push(this.field);
        this.field = '';
        continue;
      }
      if (c === '\n') {
        finish();
        continue;
      }
      if (c === '\r') {
        finish();
        this.pendingCR = true;
        continue;
      }
      this.field += c;
    }
    if (flush && (this.field.length > 0 || this.row.length > 0)) finish();
    return out;
  }
}

function sniffEncoding(bytes: Uint8Array): { decoder: TextDecoder; skip: number } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { decoder: new TextDecoder('utf-8'), skip: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { decoder: new TextDecoder('utf-16le'), skip: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { decoder: new TextDecoder('utf-16be'), skip: 2 };
  }
  return { decoder: new TextDecoder('utf-8'), skip: 0 };
}

async function* csvRows(file: File): AsyncGenerator<string[]> {
  const reader = file.stream().getReader();
  let decoder = new TextDecoder('utf-8');
  let pending = '';
  let sawBytes = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value && !sawBytes) {
        const sniffed = sniffEncoding(value);
        decoder = sniffed.decoder;
        pending += decoder.decode(value.subarray(sniffed.skip), { stream: !done });
        sawBytes = true;
      } else if (value) {
        pending += decoder.decode(value, { stream: !done });
      }
      const end = indexOfHeaderEnd(pending);
      if (end < 0 && !done && pending.length < 262144) continue;
      const headerText = (end < 0 ? pending : pending.slice(0, end)).replace(/^\uFEFF/, '');
      const sep = detectSep(headerText);
      const parser = new FieldParser(sep);
      const headerRows = parser.push(headerText + '\n', false);
      yield headerRows[0] ?? [headerText];
      const rest = end < 0 ? '' : pending.slice(end);
      pending = '';
      for (const row of parser.push(rest, done)) yield row;
      if (done) return;
      while (true) {
        const next = await reader.read();
        const text = next.value ? decoder.decode(next.value, { stream: !next.done }) : decoder.decode();
        for (const row of parser.push(text, next.done)) yield row;
        if (next.done) return;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

type SheetCell = { t?: string; v?: unknown };

function cellGetter(sheet: XLSX.WorkSheet): (r: number, c: number) => unknown {
  if (Array.isArray(sheet)) {
    const rows = sheet as unknown as Array<Array<SheetCell | undefined> | undefined>;
    return (r, c) => {
      const cell = rows[r]?.[c];
      if (!cell || cell.t === 'z' || cell.v == null || cell.v === '') return undefined;
      return cell.v;
    };
  }
  return (r, c) => {
    const cell = sheet[XLSX.utils.encode_cell({ r, c })] as SheetCell | undefined;
    if (!cell || cell.t === 'z' || cell.v == null || cell.v === '') return undefined;
    return cell.v;
  };
}

async function* sheetRows(file: File): AsyncGenerator<unknown[]> {
  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true, dense: true });
  } catch (err) {
    if (err instanceof RangeError) throw new TransactionFileError('range-too-wide');
    throw err;
  }
  const sheet = book.Sheets[book.SheetNames[0]];
  const ref = sheet?.['!ref'];
  if (!sheet || !ref) return;
  let range: XLSX.Range;
  try {
    range = XLSX.utils.decode_range(ref);
  } catch {
    throw new TransactionFileError('range-too-wide');
  }
  const get = cellGetter(sheet);
  const scanEnd = Math.min(range.e.c, range.s.c + 16383);
  let endCol = range.e.c;
  if (range.e.c - range.s.c + 1 > MAX_SHEET_COLUMNS || range.e.c > scanEnd) {
    let last = range.s.c - 1;
    let far = range.e.c > scanEnd;
    for (let c = range.s.c; c <= scanEnd; c++) {
      const value = get(range.s.r, c);
      if (value == null || String(value).trim() === '') continue;
      if (c >= range.s.c + MAX_SHEET_COLUMNS) {
        far = true;
        break;
      }
      last = c;
    }
    if (far || last < range.s.c) throw new TransactionFileError('range-too-wide');
    endCol = last;
  }
  const headers: unknown[] = [];
  for (let c = range.s.c; c <= endCol; c++) headers.push(get(range.s.r, c) ?? '');
  yield headers;

  const tall = range.e.r - range.s.r > TALL_SHEET_ROWS;
  let empty = 0;
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const values: unknown[] = [];
    let any = false;
    for (let c = range.s.c; c <= endCol; c++) {
      const value = get(r, c);
      values.push(value ?? '');
      if (value != null && String(value).trim() !== '') any = true;
    }
    if (!any) {
      empty += 1;
      if (tall && empty >= EMPTY_ROW_STREAK) return;
      continue;
    }
    empty = 0;
    yield values;
  }
}

async function isCsvFile(file: File): Promise<boolean> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || file.type === 'text/csv') return true;
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) return false;
  if (head[0] === 0xd0 && head[1] === 0xcf) return false;
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return false;
  return true;
}

export async function readTransactionFile(
  file: File,
  onBatch: (rows: UploadRow[]) => Promise<void>,
): Promise<{ skipped: number; sent: number }> {
  const csv = await isCsvFile(file);
  return consumeRows(csv ? csvRows(file) : sheetRows(file), onBatch);
}
