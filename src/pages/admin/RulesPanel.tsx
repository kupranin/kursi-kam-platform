import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../lib/toast';
import { fmtDateTime } from '../../lib/format';
import type { LossReason, Rules } from '../../lib/types';
import type { Names } from './Admin';

type Form = {
  cutoff: string; validity: string; windowDays: string; tierA: string; tierB: string; deleteMin: string;
  mfa: boolean; alertSeconds: string; expiryWarning: string; appUrl: string;
};

const toForm = (r: Rules): Form => ({
  cutoff: r.month_grace_days == null ? 'none' : String(r.month_grace_days),
  validity: String(r.default_quote_minutes),
  windowDays: String(r.winback_window_days),
  tierA: String(Math.round(Number(r.tier_a_min_gel))),
  tierB: String(Math.round(Number(r.tier_b_min_gel))),
  deleteMin: String(r.request_delete_minutes),
  mfa: r.admin_requires_mfa,
  alertSeconds: String(r.treasury_alert_seconds),
  expiryWarning: String(r.expiry_warning_minutes),
  appUrl: r.app_url ?? '',
});

export default function RulesPanel({ names }: { names: Names }) {
  const toast = useToast();
  const [rules, setRules] = useState<Rules | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [reasons, setReasons] = useState<(LossReason & { isNew?: boolean; dirty?: boolean })[]>([]);
  const [saving, setSaving] = useState(false);

  async function load() {
    const [r, l] = await Promise.all([
      supabase.from('rules').select('*').single(),
      supabase.from('loss_reasons').select('*').order('sort_order'),
    ]);
    if (r.data) { setRules(r.data as Rules); setForm(toForm(r.data as Rules)); }
    setReasons((l.data ?? []) as LossReason[]);
  }
  useEffect(() => { load(); }, []);

  if (!form || !rules) return <section id="rules" className="card"><h2>Counting rules</h2><p className="empty">Loading…</p></section>;
  const set = (p: Partial<Form>) => setForm({ ...form, ...p });
  const int = (s: string) => Math.round(Number(s.replace(/[\s,]/g, '')));

  async function save() {
    const f = form!;
    const update = {
      month_grace_days: f.cutoff === 'none' ? null : Number(f.cutoff),
      default_quote_minutes: int(f.validity),
      winback_window_days: int(f.windowDays),
      tier_a_min_gel: int(f.tierA),
      tier_b_min_gel: int(f.tierB),
      request_delete_minutes: int(f.deleteMin),
      admin_requires_mfa: f.mfa,
      treasury_alert_seconds: int(f.alertSeconds),
      expiry_warning_minutes: int(f.expiryWarning),
      app_url: f.appUrl.trim() || null,
    };
    if (Object.values(update).some((v) => typeof v === 'number' && Number.isNaN(v))) { toast('Use whole numbers in the number fields.', 'error'); return; }
    if (update.tier_a_min_gel < update.tier_b_min_gel) { toast('Priority A must start at a higher amount than B.', 'error'); return; }
    setSaving(true);
    const { error } = await supabase.from('rules').update(update).eq('id', true);
    setSaving(false);
    if (error) { toast(error.message.includes('check') ? 'One of the values is outside what the rule allows.' : error.message, 'error'); return; }
    toast('Rules saved. The change is in the activity list.');
    load();
  }

  async function saveReasons() {
    for (const r of reasons.filter((x) => x.dirty || x.isNew)) {
      if (!r.label_en.trim() || !r.label_ka.trim()) { toast('Every reason needs an English and a Georgian label.', 'error'); return; }
      const res = r.isNew
        ? await supabase.from('loss_reasons').insert({ code: r.code, label_en: r.label_en.trim(), label_ka: r.label_ka.trim(), sort_order: r.sort_order, active: r.active })
        : await supabase.from('loss_reasons').update({ label_en: r.label_en.trim(), label_ka: r.label_ka.trim(), active: r.active }).eq('code', r.code);
      if (res.error) { toast(res.error.message, 'error'); return; }
    }
    toast('Reasons saved.');
    load();
  }

  function addReason() {
    const n = reasons.length + 1;
    setReasons([...reasons, { code: 'reason_' + Date.now().toString(36), label_en: '', label_ka: '', sort_order: n * 10 + 100, active: true, isNew: true }]);
    void n;
  }

  const editReason = (code: string, p: Partial<LossReason>) =>
    setReasons(reasons.map((r) => (r.code === code ? { ...r, ...p, dirty: true } : r)));

  const numField = (id: string, label: string, value: string, key: keyof Form, suffix: string, hint?: string, warn?: boolean) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
        <input id={id} className="input" style={{ width: 160, borderColor: warn ? '#B47A2E' : undefined }} inputMode="numeric" value={value} onChange={(e) => set({ [key]: e.target.value } as Partial<Form>)} />
        <span>{suffix}</span>
      </div>
      {hint && <span className={'hint' + (warn ? '' : '')} style={warn ? { color: '#7A4A0E' } : undefined}>{hint}</span>}
    </div>
  );

  return (
    <section id="rules" className="card" aria-labelledby="rules-title">
      <div className="card-head">
        <h2 id="rules-title" style={{ fontSize: 22 }}>Counting rules</h2>
        <span className="small muted">Last changed {fmtDateTime(rules.updated_at)}{rules.updated_by && names[rules.updated_by] ? ' by ' + names[rules.updated_by] : ''}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '22px 28px' }}>
        <div className="field">
          <label htmlFor="cutoff">Month cutoff</label>
          <select id="cutoff" className="select" style={{ borderColor: form.cutoff === 'none' ? '#B47A2E' : undefined }} value={form.cutoff} onChange={(e) => set({ cutoff: e.target.value })}>
            <option value="none">Not decided yet</option>
            <option value="0">Calendar month only</option>
            {[1, 2, 3, 4, 5].map((d) => <option key={d} value={String(d)}>Month plus {d} {d === 1 ? 'day' : 'days'}</option>)}
          </select>
          <span className="hint" style={form.cutoff === 'none' ? { color: '#7A4A0E' } : undefined}>
            {form.cutoff === 'none' ? 'Counts as the calendar month until you choose.' : form.cutoff === '0' ? 'Only requests made inside the month count.' : `Requests up to day ${form.cutoff} of the next month count.`}
          </span>
        </div>
        <div className="field">
          <label htmlFor="validity">Treasury rate is valid for</label>
          <select id="validity" className="select" value={form.validity} onChange={(e) => set({ validity: e.target.value })}>
            {['5', '10', '15', '30', '60'].map((m) => <option key={m} value={m}>{m} minutes</option>)}
          </select>
          <span className="hint">Default. Treasury can pick another time for each rate.</span>
        </div>
        {numField('window', 'Win-back looks back', form.windowDays, 'windowDays', 'days')}
        {numField('tier-a', 'Priority A from', form.tierA, 'tierA', 'GEL')}
        {numField('tier-b', 'Priority B from', form.tierB, 'tierB', 'GEL')}
        {numField('delete-min', 'KAMs can delete a request within', form.deleteMin, 'deleteMin', 'minutes')}
        {numField('alert', 'Alert treasury when a request waits', form.alertSeconds, 'alertSeconds', 'seconds')}
        {numField('expiry', 'Warn the KAM before a rate expires', form.expiryWarning, 'expiryWarning', 'minutes')}
        <div className="field">
          <label htmlFor="app-url">Platform address</label>
          <input id="app-url" className="input" placeholder="https://kam.kursi.ge" value={form.appUrl} onChange={(e) => set({ appUrl: e.target.value })} />
          <span className="hint">Used for the links inside messages</span>
        </div>
      </div>
      <div className="row-between" style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--line-soft)', alignItems: 'center' }}>
        <label className="checkbox">
          <input type="checkbox" checked={form.mfa} onChange={(e) => set({ mfa: e.target.checked })} />
          <span><span className="strong" style={{ fontWeight: 500 }}>Admins confirm sign-in with an authenticator app</span><br /><span className="small muted">Set up your own app first, under Password and sign-in.</span></span>
        </label>
        <button type="button" className="btn btn-dark" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save rules'}</button>
      </div>

      <h3 style={{ margin: '28px 0 4px' }}>Reasons a request didn't go through</h3>
      <p className="small" style={{ margin: '0 0 12px', color: 'var(--ink-2)' }}>KAMs pick one of these on the Follow-ups page.</p>
      <div className="stack-sm">
        {reasons.map((r) => (
          <div key={r.code} className="row" style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--ground)', gap: '10px 14px' }}>
            <label className="sr-only" htmlFor={'en-' + r.code}>English label</label>
            <input id={'en-' + r.code} className="input" style={{ flex: '1 1 220px', minHeight: 44 }} placeholder="English" value={r.label_en} onChange={(e) => editReason(r.code, { label_en: e.target.value })} />
            <label className="sr-only" htmlFor={'ka-' + r.code}>Georgian label</label>
            <input id={'ka-' + r.code} lang="ka" className="input" style={{ flex: '1 1 220px', minHeight: 44 }} placeholder="ქართულად" value={r.label_ka} onChange={(e) => editReason(r.code, { label_ka: e.target.value })} />
            <label className="checkbox small"><input type="checkbox" checked={r.active} onChange={(e) => editReason(r.code, { active: e.target.checked })} />In use</label>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button type="button" className="btn btn-quiet" onClick={addReason}>Add a reason</button>
        {reasons.some((r) => r.dirty || r.isNew) && <button type="button" className="btn btn-dark" onClick={saveReasons}>Save reasons</button>}
      </div>
    </section>
  );
}
