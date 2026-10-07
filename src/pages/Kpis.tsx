import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { todayTbilisi } from '../lib/format';

type Segment = 'business' | 'kam' | 'retail';
type Metric = 'turnover' | 'active_users' | 'new_users' | 'registrations';
type Field = 'plan_value' | 'planned_pct' | 'actual_value' | 'margin_pct';

interface PlanRow {
  year: number;
  month: number;
  segment: Segment;
  metric: Metric;
  plan_value: number | null;
  planned_pct: number | null;
  actual_value: number | null;
  margin_pct: number | null;
}

interface HistoryRow {
  segment: 'retail' | 'business';
  year: number;
  month: number;
  amount: number | null;
}

const SECTIONS: { segment: Segment; title: string; metrics: [Metric, string][] }[] = [
  { segment: 'business', title: 'ბიზნესი', metrics: [['turnover', 'ბრუნვა'], ['active_users', 'აქტიური მომხმარებლები'], ['new_users', 'ახალი მომხმარებლები'], ['registrations', 'რეგისტრაციები']] },
  { segment: 'kam', title: 'KAM', metrics: [['turnover', 'ბრუნვა']] },
  { segment: 'retail', title: 'საცალო', metrics: [['turnover', 'ბრუნვა'], ['active_users', 'აქტიური მომხმარებლები'], ['new_users', 'ახალი მომხმარებლები'], ['registrations', 'რეგისტრაციები']] },
];

const MONTHS = ['იან', 'თებ', 'მარ', 'აპრ', 'მაი', 'ივნ', 'ივლ', 'აგვ', 'სექ', 'ოქტ', 'ნოე', 'დეკ'];
const MONTH_NAME = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];

const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function keyOf(segment: string, metric: string): string {
  return segment + ':' + metric;
}

function historyKey(segment: string, year: number, month: number): string {
  return segment + ':' + year + ':' + month;
}

function asNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtCount(n: number | null): string {
  if (n == null) return '';
  return Number.isInteger(n) ? whole.format(n) : decimal.format(n);
}

function fmtPct(fraction: number | null): string {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return (fraction * 100).toFixed(1) + '%';
}

function parseAmount(text: string): number | null {
  const cleaned = text.replace(/,/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error('შეიყვანეთ რიცხვი');
  return n;
}

function parsePercent(text: string): number | null {
  const n = parseAmount(text.replace(/%/g, ''));
  return n == null ? null : n / 100;
}

export default function Kpis() {
  const toast = useToast();
  const today = todayTbilisi();
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [month, setMonth] = useState(Number(today.slice(5, 7)));
  const [plans, setPlans] = useState<Record<string, PlanRow>>({});
  const [history, setHistory] = useState<Record<string, number | null>>({});
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [planRes, histRes] = await Promise.all([
      supabase.from('kpi_plans').select('year, month, segment, metric, plan_value, planned_pct, actual_value, margin_pct').eq('year', year).eq('month', month),
      supabase.from('kpi_history').select('segment, year, month, amount'),
    ]);
    if (planRes.error) throw new Error(planRes.error.message);
    if (histRes.error) throw new Error(histRes.error.message);
    const next: Record<string, PlanRow> = {};
    for (const row of (planRes.data ?? []) as PlanRow[]) {
      next[keyOf(row.segment, row.metric)] = {
        ...row,
        plan_value: asNumber(row.plan_value),
        planned_pct: asNumber(row.planned_pct),
        actual_value: asNumber(row.actual_value),
        margin_pct: asNumber(row.margin_pct),
      };
    }
    const hist: Record<string, number | null> = {};
    for (const row of (histRes.data ?? []) as HistoryRow[]) hist[historyKey(row.segment, row.year, row.month)] = asNumber(row.amount);
    setPlans(next);
    setHistory(hist);
  }, [year, month]);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    load().then(() => { if (live) setLoaded(true); }).catch((err: Error) => { if (live) toast(err.message, 'error'); });
    return () => { live = false; };
  }, [load, toast]);

  async function savePlan(segment: Segment, metric: Metric, field: Field, value: number | null) {
    const current = plans[keyOf(segment, metric)] ?? {
      year, month, segment, metric, plan_value: null, planned_pct: null, actual_value: null, margin_pct: null,
    };
    const next = { ...current, year, month, [field]: value, updated_at: new Date().toISOString() };
    const { error } = await supabase.from('kpi_plans').upsert(next, { onConflict: 'year,month,segment,metric' });
    if (error) throw new Error(error.message);
    setPlans((all) => ({ ...all, [keyOf(segment, metric)]: next }));
  }

  async function saveHistory(segment: 'retail' | 'business', histYear: number, histMonth: number, amount: number | null) {
    const { error } = await supabase.from('kpi_history').upsert({
      segment, year: histYear, month: histMonth, amount, updated_at: new Date().toISOString(),
    }, { onConflict: 'segment,year,month' });
    if (error) throw new Error(error.message);
    setHistory((all) => ({ ...all, [historyKey(segment, histYear, histMonth)]: amount }));
  }

  const businessActual = plans[keyOf('business', 'turnover')]?.actual_value;
  const kamActual = plans[keyOf('kam', 'turnover')]?.actual_value;
  const kamShare = businessActual && kamActual != null ? kamActual / businessActual : null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>KPI</h1>
          <p>გეგმა, ფაქტი და მარჟა. დაგეგმილი, ფაქტი % და სხვაობა გამოითვლება.</p>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label className="sr-only" htmlFor="kpi-month">თვე</label>
          <input
            id="kpi-month"
            className="input"
            type="month"
            value={year + '-' + String(month).padStart(2, '0')}
            onChange={(e) => {
              const [y, m] = e.target.value.split('-').map(Number);
              if (y && m) { setYear(y); setMonth(m); }
            }}
          />
        </div>
      </div>

      <section className="card flush" aria-labelledby="plan-title">
        <div className="card-head">
          <h2 id="plan-title">{MONTH_NAME[month - 1]} {year}</h2>
          <p className="small muted">მარჟა ხელით იწერება. გეგმის ფურცელი მას არ ითვლის.</p>
        </div>
        {!loaded && <p className="empty">იტვირთება…</p>}
        {loaded && (
          <div className="table-wrap">
            <table className="table sheet" style={{ minWidth: 980 }}>
              <thead>
                <tr>
                  <th>სტრიქონი</th>
                  <th className="num">გეგმა</th>
                  <th className="num">დაგეგმილი %</th>
                  <th className="num">დაგეგმილი</th>
                  <th className="num">ფაქტი</th>
                  <th className="num">ფაქტი %</th>
                  <th className="num">გეგმა ფაქტთან</th>
                  <th className="num">მარჟა %</th>
                </tr>
              </thead>
              <tbody>
                {SECTIONS.map((section) => (
                  <Section
                    key={section.segment}
                    title={section.title}
                    rows={section.metrics.map(([metric, label]) => {
                      const row = plans[keyOf(section.segment, metric)];
                      const plan = row?.plan_value ?? null;
                      const plannedPct = row?.planned_pct ?? null;
                      const actual = row?.actual_value ?? null;
                      const planned = plan != null && plannedPct != null ? plan * plannedPct : null;
                      const actualPct = plan ? (actual ?? 0) / plan : null;
                      const gap = actualPct != null && plannedPct != null ? actualPct - plannedPct : null;
                      return { metric, label, plan, plannedPct, actual, planned, actualPct, gap, margin: row?.margin_pct ?? null };
                    })}
                    onSave={(metric, field, value) => savePlan(section.segment, metric, field, value).catch((err: Error) => toast(err.message, 'error'))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {loaded && kamShare != null && (
          <p className="small" style={{ padding: '12px 24px 4px' }}>KAM-ის წილი ბიზნესის ბრუნვაში: {fmtPct(kamShare)}</p>
        )}
      </section>

      <section className="card flush" aria-labelledby="year-title" style={{ marginTop: 18 }}>
        <div className="card-head">
          <h2 id="year-title">ბრუნვა, 2026 2025-თან</h2>
          <p className="small muted">ჯამები და წლიური შედარება გამოითვლება.</p>
        </div>
        {loaded && (
          <div className="table-wrap">
            <table className="table sheet" style={{ minWidth: 1100 }}>
              <thead>
                <tr>
                  <th>სტრიქონი</th>
                  {MONTHS.map((name) => <th key={name} className="num">{name}</th>)}
                </tr>
              </thead>
              <tbody>
                {(['retail', 'business'] as const).map((segment) => (
                  <YearBlock
                    key={segment}
                    title={segment === 'retail' ? 'საცალო ბრუნვა' : 'ბიზნესის ბრუნვა'}
                    segment={segment}
                    history={history}
                    onSave={(histYear, histMonth, amount) => saveHistory(segment, histYear, histMonth, amount).catch((err: Error) => toast(err.message, 'error'))}
                  />
                ))}
                <tr className="section-row"><td colSpan={13}>სულ</td></tr>
                <tr>
                  <th scope="row">2025</th>
                  {MONTHS.map((_, i) => <td key={i} className="num">{fmtCount(sumHistory(history, 2025, i + 1))}</td>)}
                </tr>
                <tr>
                  <th scope="row">2026</th>
                  {MONTHS.map((_, i) => <td key={i} className="num">{fmtCount(sumHistory(history, 2026, i + 1))}</td>)}
                </tr>
                <tr>
                  <th scope="row">2026 2025-თან</th>
                  {MONTHS.map((_, i) => {
                    const prior = sumHistory(history, 2025, i + 1);
                    const current = sumHistory(history, 2026, i + 1);
                    const vs = prior ? ((current ?? 0) / prior) - 1 : null;
                    return <td key={i} className="num">{prior == null && current == null ? '' : fmtPct(vs)}</td>;
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function sumHistory(history: Record<string, number | null>, year: number, month: number): number | null {
  const retail = history[historyKey('retail', year, month)];
  const business = history[historyKey('business', year, month)];
  if (retail == null && business == null) return null;
  return (retail ?? 0) + (business ?? 0);
}

function Section({ title, rows, onSave }: {
  title: string;
  rows: { metric: Metric; label: string; plan: number | null; plannedPct: number | null; actual: number | null; planned: number | null; actualPct: number | null; gap: number | null; margin: number | null }[];
  onSave: (metric: Metric, field: Field, value: number | null) => void;
}) {
  return (
    <>
      <tr className="section-row"><td colSpan={8}>{title}</td></tr>
      {rows.map((row) => (
        <tr key={row.metric}>
          <th scope="row">{row.label}</th>
          <td className="num"><Cell value={row.plan} format={fmtCount} parse={parseAmount} onSave={(v) => onSave(row.metric, 'plan_value', v)} /></td>
          <td className="num"><Cell value={row.plannedPct} format={(n) => (n == null ? '' : (n * 100).toFixed(1))} parse={parsePercent} onSave={(v) => onSave(row.metric, 'planned_pct', v)} /></td>
          <td className="num">{fmtCount(row.planned)}</td>
          <td className="num"><Cell value={row.actual} format={fmtCount} parse={parseAmount} onSave={(v) => onSave(row.metric, 'actual_value', v)} /></td>
          <td className="num">{fmtPct(row.actualPct)}</td>
          <td className="num">{fmtPct(row.gap)}</td>
          <td className="num"><Cell value={row.margin} format={(n) => (n == null ? '' : (n * 100).toFixed(1))} parse={parsePercent} onSave={(v) => onSave(row.metric, 'margin_pct', v)} /></td>
        </tr>
      ))}
    </>
  );
}

function YearBlock({ title, segment, history, onSave }: {
  title: string;
  segment: 'retail' | 'business';
  history: Record<string, number | null>;
  onSave: (year: number, month: number, amount: number | null) => void;
}) {
  return (
    <>
      <tr className="section-row"><td colSpan={13}>{title}</td></tr>
      {[2025, 2026].map((histYear) => (
        <tr key={histYear}>
          <th scope="row">{histYear}</th>
          {MONTHS.map((_, i) => (
            <td key={i} className="num">
              <Cell
                value={history[historyKey(segment, histYear, i + 1)] ?? null}
                format={fmtCount}
                parse={parseAmount}
                onSave={(v) => onSave(histYear, i + 1, v)}
              />
            </td>
          ))}
        </tr>
      ))}
      <tr>
        <th scope="row">2026 2025-თან</th>
        {MONTHS.map((_, i) => {
          const prior = history[historyKey(segment, 2025, i + 1)];
          const current = history[historyKey(segment, 2026, i + 1)];
          const vs = prior ? ((current ?? 0) / prior) - 1 : null;
          return <td key={i} className="num">{prior == null && current == null ? '' : fmtPct(vs)}</td>;
        })}
      </tr>
    </>
  );
}

function Cell({ value, format, parse, onSave }: {
  value: number | null;
  format: (n: number | null) => string;
  parse: (text: string) => number | null;
  onSave: (value: number | null) => void;
}) {
  const toast = useToast();
  const shown = format(value);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(shown); }, [shown, editing]);

  return (
    <input
      className="input cell-input"
      inputMode="decimal"
      value={text}
      aria-label="რედაქტირება"
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false);
        try {
          const next = parse(text);
          if (next !== value) onSave(next);
          else setText(shown);
        } catch (err) {
          toast((err as Error).message, 'error');
          setText(shown);
        }
      }}
    />
  );
}
