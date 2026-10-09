/**
 * Reads the first worksheet of an xlsx file row by row.
 * The file bytes are unzipped one entry at a time. Rows are handed onward
 * and not kept, so a million-row sheet never becomes one cell object.
 */

const MAX_COLUMNS = 96;

export class XlsxReadError extends Error {
  readonly code: 'range-too-wide' | 'unreadable';

  constructor(code: 'range-too-wide' | 'unreadable') {
    super(code);
    this.name = 'XlsxReadError';
    this.code = code;
  }
}

function columnIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function decodeXml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function localTag(chunk: string, name: string): string | null {
  const match = chunk.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*)>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i'));
  return match ? match[2] : null;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  dataOffset: number;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= start; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
  }
  return -1;
}

function readEntries(bytes: Uint8Array): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new XlsxReadError('unreadable');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder('utf-8');
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new XlsxReadError('unreadable');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    entries.push({
      name,
      method,
      compressedSize,
      dataOffset: localOffset + 30 + localNameLen + localExtraLen,
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflate(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method !== 8 || typeof DecompressionStream === 'undefined') throw new XlsxReadError('unreadable');
  const raw = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(raw).set(compressed);
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function entryText(bytes: Uint8Array, entries: ZipEntry[], name: string): Promise<string | null> {
  const entry = entries.find((item) => item.name === name);
  if (!entry) return Promise.resolve(null);
  return inflate(bytes, entry).then((raw) => new TextDecoder('utf-8').decode(raw));
}

function sharedStringsFrom(xml: string): string[] {
  const out: string[] = [];
  const parts = xml.split(/<(?:[\w-]+:)?si\b/i);
  for (let i = 1; i < parts.length; i++) {
    const body = (parts[i].split(/<\/si>/i)[0] ?? '').replace(/<(?:[\w-]+:)?rPh\b[\s\S]*?<\/(?:[\w-]+:)?rPh>/gi, '');
    const texts = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/gi) ?? [];
    const value = texts.map((tag) => decodeXml(tag.replace(/^<t\b[^>]*>/i, '').replace(/<\/t>$/i, ''))).join('');
    out.push(value);
  }
  return out;
}

function firstSheetPath(workbookXml: string, relsXml: string): string {
  const sheet = workbookXml.match(/<(?:[\w-]+:)?sheet\b[^>]*r:id="([^"]+)"/i);
  const id = sheet?.[1] ?? 'rId1';
  const rel = relsXml.match(new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`, 'i'))
    ?? relsXml.match(/Target="([^"]*worksheets\/[^"]+)"/i);
  let target = rel?.[1] ?? 'worksheets/sheet1.xml';
  if (target.startsWith('/')) target = target.slice(1);
  if (!target.startsWith('xl/')) target = `xl/${target.replace(/^\//, '')}`;
  return target;
}

function cellValue(cell: string, strings: string[]): unknown {
  const ref = cell.match(/\br="([A-Z]+)\d+"/i)?.[1] ?? '';
  const kind = cell.match(/\bt="([^"]+)"/i)?.[1] ?? 'n';
  const column = columnIndex(ref);
  if (column >= MAX_COLUMNS) throw new XlsxReadError('range-too-wide');
  let value: unknown = '';
  if (kind === 'inlineStr') {
    const inline = localTag(cell, 'is') ?? cell;
    const texts = inline.match(/<t\b[^>]*>([\s\S]*?)<\/t>/gi) ?? [];
    value = texts.map((tag) => decodeXml(tag.replace(/^<t\b[^>]*>/i, '').replace(/<\/t>$/i, ''))).join('');
  } else {
    const raw = localTag(cell, 'v');
    if (raw == null) value = '';
    else if (kind === 's') value = strings[Number(raw)] ?? '';
    else if (kind === 'b') value = raw === '1';
    else if (kind === 'str' || kind === 'd') value = decodeXml(raw);
    else {
      const n = Number(raw);
      value = Number.isFinite(n) ? n : decodeXml(raw);
    }
  }
  return { column, value };
}

function rowValues(rowXml: string, strings: string[]): unknown[] {
  const cells = rowXml.match(/<(?:[\w-]+:)?c\b[\s\S]*?(?:\/>|<\/(?:[\w-]+:)?c>)/gi) ?? [];
  const values: unknown[] = [];
  for (const cell of cells) {
    const parsed = cellValue(cell, strings) as { column: number; value: unknown };
    if (parsed.column < 0) continue;
    while (values.length <= parsed.column) values.push('');
    values[parsed.column] = parsed.value;
  }
  return values;
}

export async function* xlsxRows(file: File): AsyncGenerator<unknown[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = readEntries(bytes);
  const workbook = await entryText(bytes, entries, 'xl/workbook.xml');
  const rels = await entryText(bytes, entries, 'xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new XlsxReadError('unreadable');
  const sheetName = firstSheetPath(workbook, rels);
  const stringsXml = await entryText(bytes, entries, 'xl/sharedStrings.xml');
  const strings = stringsXml ? sharedStringsFrom(stringsXml) : [];
  const sheetEntry = entries.find((item) => item.name === sheetName);
  if (!sheetEntry) throw new XlsxReadError('unreadable');
  const sheet = new TextDecoder('utf-8').decode(await inflate(bytes, sheetEntry));
  const rowEnd = /<\/(?:[\w-]+:)?row>/gi;
  let cursor = 0;
  let end: RegExpExecArray | null;
  while ((end = rowEnd.exec(sheet))) {
    const piece = sheet.slice(cursor, end.index);
    cursor = rowEnd.lastIndex;
    const start = piece.search(/<(?:[\w-]+:)?row\b/i);
    if (start < 0) continue;
    const values = rowValues(piece.slice(start), strings);
    if (values.length) yield values;
  }
}
