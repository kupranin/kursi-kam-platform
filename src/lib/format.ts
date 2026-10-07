import { getLang } from './lang';

const TZ = 'Asia/Tbilisi';

function locale(): string {
  return getLang() === 'en' ? 'en-GB' : 'ka-GE';
}

const amountFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const wholeFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const fmtAmount = (n: number | null | undefined) => (n == null ? '' : amountFmt.format(Number(n)));
export const fmtWhole = (n: number | null | undefined) => (n == null ? '' : wholeFmt.format(Number(n)));
export const fmtRate = (n: number | null | undefined) => (n == null ? '' : Number(n).toFixed(4));

/** 83,300,000 -> "83.3 მლნ", 22,158 -> "22,158" */
export function fmtShort(n: number | null | undefined): string {
  if (n == null) return '';
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1) + (getLang() === 'en' ? ' m' : ' მლნ');
  return wholeFmt.format(v);
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('ka-GE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
}

/** "2026-10-06" -> "6 Oct" */
export function fmtDay(day: string | null | undefined): string {
  if (!day) return '';
  return new Date(day + 'T00:00:00Z').toLocaleDateString(locale(), { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
  const label = day === todayTbilisi() ? (getLang() === 'en' ? 'Today' : 'დღეს') : fmtDay(day);
  return label + ' ' + fmtTime(iso);
}

/** Today's date in Tbilisi as YYYY-MM-DD */
export function todayTbilisi(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

export function longToday(): string {
  return new Date().toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
}

export function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

export function ago(iso: string): string {
  const m = minutesSince(iso);
  if (getLang() === 'en') {
    if (m < 1) return 'Just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    return h + ' h ' + (m % 60) + ' min ago';
  }
  if (m < 1) return 'ახლახან';
  if (m < 60) return m + ' წთ წინ';
  const h = Math.floor(m / 60);
  return h + ' სთ ' + (m % 60) + ' წთ წინ';
}

/** "120 000", "120,000.50" -> 120000.5 ; returns NaN when not a number */
export function parseAmount(text: string): number {
  const clean = text.replace(/[\s,]/g, '');
  if (!/^\d+(\.\d+)?$/.test(clean)) return NaN;
  return Number(clean);
}

export function describeDeal(
  sells: string | null,
  amount: number | null,
  gets: string | null,
  getsAmount?: number | null,
): string {
  if (!sells || !gets) return getLang() === 'en' ? 'Imported request' : 'იმპორტირებული მოთხოვნა';
  const sellSide = amount != null ? `${sells} ${fmtAmount(amount)}` : sells;
  const getSide = getsAmount != null ? `${gets} ${fmtAmount(getsAmount)}` : gets;
  return getLang() === 'en' ? `Sells ${sellSide}, gets ${getSide}` : `ყიდის ${sellSide}, იღებს ${getSide}`;
}

/** "USD 10,000" or just "USD" when that side's amount was left blank. */
export function sideAmount(currency: string | null, amount: number | null | undefined): string {
  if (!currency) return '';
  return amount != null ? `${currency} ${fmtAmount(amount)}` : currency;
}

export function rateUnit(sells: string, gets: string): string {
  const base = sells !== 'GEL' && gets !== 'GEL' ? sells : (sells === 'GEL' ? gets : sells);
  const quote = sells !== 'GEL' && gets !== 'GEL' ? gets : 'GEL';
  return getLang() === 'en' ? `${quote} per 1 ${base}` : `1 ${base}-ზე ${quote}`;
}

export function monthOptions(count = 6): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const today = todayTbilisi();
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  for (let i = 0; i < count; i++) {
    const value = `${y}-${String(m).padStart(2, '0')}-01`;
    const label = new Date(value + 'T00:00:00Z').toLocaleDateString(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const soFar = getLang() === 'en' ? ', so far' : ', ჯერჯერობით';
    out.push({ value, label: i === 0 ? label + soFar : label });
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

export function downloadCsv(filename: string, rows: (string | number | null)[][]) {
  const csv = rows
    .map((r) => r.map((v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','))
    .join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
