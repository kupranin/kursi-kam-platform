import { parseAmount } from '../../lib/format';

/** Same checks as the desktop request form. Blank is allowed. */
export function readAmount(text: string): { ok: boolean; value: number | null } {
  if (!text.trim()) return { ok: true, value: null };
  const n = parseAmount(text);
  return n > 0 ? { ok: true, value: n } : { ok: false, value: null };
}

/** Same checks as the desktop request form. A comma is a decimal point. */
export function readRate(text: string): { ok: boolean; value: number | null } {
  const clean = text.trim().replace(',', '.');
  if (!clean) return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(clean)) return { ok: false, value: null };
  const n = Number(clean);
  return n > 0 ? { ok: true, value: n } : { ok: false, value: null };
}
