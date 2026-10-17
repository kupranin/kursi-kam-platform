import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { CURRENCIES } from '../lib/types';
import { parseRate } from '../lib/format';
import {
  EMPTY_SPECIAL_DRAFT,
  SPECIAL_BANKS,
  loadSpecialRates,
  type SpecialBank,
  type SpecialBankDraft,
  type SpecialRateRow,
  type SpecialTermsDraft,
} from '../lib/specialRates';
import { specialFormDirty, specialRateBoxChecked, specialTermsNeedClear, type StoredSpecialBank } from '../lib/specialRateStatus';
import LoadingLine from './LoadingLine';
import { BankSpecialReference } from './VenuePairLine';

interface Props {
  clientId: string | null;
  idSuffix: string;
  onDraft: (draft: SpecialTermsDraft) => void;
  /** The request pair, used for the provider reference when no bank pair is filled. */
  requestSells?: string;
  requestGets?: string;
}

interface BankFields {
  providerLabel: string;
  comment: string;
  sells: string;
  gets: string;
  rate: string;
}

function emptyFields(): BankFields {
  return { providerLabel: '', comment: '', sells: '', gets: '', rate: '' };
}

function fieldsFrom(row: SpecialRateRow | undefined): BankFields {
  if (!row) return emptyFields();
  return {
    providerLabel: row.provider_label ?? '',
    comment: row.comment ?? '',
    sells: row.sells_currency ?? '',
    gets: row.gets_currency ?? '',
    rate: row.rate == null ? '' : String(row.rate),
  };
}

function storedFrom(row: SpecialRateRow | undefined): StoredSpecialBank | null {
  if (!row) return null;
  return {
    clientId: row.client_id,
    bank: row.bank,
    providerLabel: row.provider_label,
    comment: row.comment,
    sells: row.sells_currency,
    gets: row.gets_currency,
    rate: row.rate,
    active: true,
  };
}

function bankDirty(code: SpecialBank, form: BankFields, rows: SpecialRateRow[]): boolean {
  const parsed = parseRate(form.rate);
  return specialFormDirty(code, {
    providerLabel: form.providerLabel,
    comment: form.comment,
    sells: form.sells,
    gets: form.gets,
    rateOk: parsed.ok,
    rateValue: parsed.ok ? parsed.value : null,
  }, storedFrom(rows.find((row) => row.bank === code)));
}

/** Optional client-reported bank terms. Several banks can be open at once. Hidden when setup 42 is absent. */
export default function ClientSpecialTerms({ clientId, idSuffix, onDraft, requestSells = '', requestGets = '' }: Props) {
  const { t } = useI18n();
  const [gate, setGate] = useState<'unknown' | 'on' | 'off'>('unknown');
  const [rows, setRows] = useState<SpecialRateRow[]>([]);
  const [on, setOn] = useState(false);
  const [loadedActive, setLoadedActive] = useState(false);
  const [open, setOpen] = useState<SpecialBank[]>([]);
  const [fields, setFields] = useState<Partial<Record<SpecialBank, BankFields>>>({});
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const checkId = 'special-rate-on-' + idSuffix;
  const bankLabelId = 'special-bank-' + idSuffix;

  useEffect(() => {
    let live = true;
    setOn(false);
    setLoadedActive(false);
    setRows([]);
    setOpen([]);
    setFields({});
    loadSpecialRates(clientId ? [clientId] : [])
      .then((result) => {
        if (!live) return;
        if (result.missing) {
          setGate('off');
          return;
        }
        setGate('on');
        setRows(result.rows);
        const active = specialRateBoxChecked(result.rows.length);
        setLoadedActive(active);
        if (!active) return;
        const ordered = SPECIAL_BANKS.filter((code) => result.rows.some((row) => row.bank === code));
        const next: Partial<Record<SpecialBank, BankFields>> = {};
        for (const code of ordered) next[code] = fieldsFrom(result.rows.find((row) => row.bank === code));
        setOpen(ordered);
        setFields(next);
        setOn(true);
      })
      .catch(() => {
        if (live) setGate('on');
      });
    return () => {
      live = false;
    };
  }, [clientId]);

  const clear = specialTermsNeedClear(loadedActive, on);
  const shown = SPECIAL_BANKS.filter((code) => open.includes(code));
  const drafts: SpecialBankDraft[] = shown.map((code) => {
    const form = fields[code] ?? emptyFields();
    return {
      bank: code,
      providerLabel: form.providerLabel,
      comment: form.comment,
      sells: form.sells,
      gets: form.gets,
      rate: form.rate,
      dirty: bankDirty(code, form, rows),
    };
  });
  const draftKey = drafts.map((item) => [item.bank, item.providerLabel, item.comment, item.sells, item.gets, item.rate, item.dirty ? '1' : '0'].join('\u0001')).join('\u0002');
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  useEffect(() => {
    if (gate === 'off') {
      onDraftRef.current(EMPTY_SPECIAL_DRAFT);
      return;
    }
    onDraftRef.current({ on, banks: draftsRef.current, clear });
  }, [gate, on, draftKey, clear]);

  function addBank(code: SpecialBank) {
    setOpen((cur) => (cur.includes(code) ? cur : [...cur, code]));
    setFields((cur) => (cur[code] ? cur : { ...cur, [code]: fieldsFrom(rows.find((row) => row.bank === code)) }));
  }

  function edit(code: SpecialBank, patch: Partial<BankFields>) {
    setFields((cur) => ({ ...cur, [code]: { ...(cur[code] ?? emptyFields()), ...patch } }));
  }

  if (gate === 'off') return null;
  if (gate === 'unknown') return <LoadingLine compact />;

  const paired = shown
    .map((code) => fields[code])
    .find((form) => form && form.sells && form.gets && form.sells !== form.gets);
  const refSells = paired?.sells || requestSells;
  const refGets = paired?.gets || requestGets;
  const remaining = SPECIAL_BANKS.filter((code) => !open.includes(code));

  return (
    <section className="special-terms" aria-labelledby={bankLabelId + '-title'}>
      <h3 id={bankLabelId + '-title'} className="small strong" style={{ margin: '0 0 4px' }}>{t('კლიენტის საბანკო პირობები', 'Client bank terms')}</h3>
      <p className="tiny muted" style={{ margin: '0 0 8px' }}>{t('კლიენტის თქმით. ეს შემოწმებული საბაზრო კურსი არ არის.', 'As reported by the client. This is not a verified market rate.')}</p>
      <label className="checkbox" htmlFor={checkId}>
        <input id={checkId} type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span>{t('კლიენტს აქვს ბანკის სპეციალური კურსი', 'The client has a special bank rate')}</span>
      </label>
      {clear && <p className="hint" style={{ margin: '4px 0 0' }}>{t('მონიშვნის მოხსნა მოთხოვნის გაგზავნისას ინახება. ბანკები აქტიურ პირობად აღარ ჩანს.', 'Unchecking is saved when the request is sent. The banks are no longer shown as active terms.')}</p>}
      {on && <BankSpecialReference sells={refSells} gets={refGets} />}
      {on && (
        <div className="special-terms-body">
          <p className="hint" style={{ margin: '4px 0 8px' }}>{t('ეს არ არის ბანკი, სადაც კლიენტი აგზავნის. შეგიძლიათ შეინახოთ ერთზე მეტი ბანკი, თითოეულს თავისი პირობით. ცარიელი ველი შენახულ პირობას არ შლის.', 'This is not the bank the client is sending to. You can save more than one bank, each with its own terms. A blank field does not erase a saved term.')}</p>
          {shown.map((code) => {
            const form = fields[code] ?? emptyFields();
            const rateParsed = parseRate(form.rate);
            const pairHalf = Boolean(form.sells) !== Boolean(form.gets);
            const name = code === 'Other' ? t('სხვა', 'Other') : code;
            return (
              <div key={code} className="special-bank">
                <p className="small strong" id={bankLabelId + '-' + code} style={{ margin: '0 0 8px' }}>{name}</p>
                {code === 'Other' && (
                  <div className="field">
                    <label htmlFor={'special-provider-' + idSuffix + '-' + code}>{t('პროვაიდერის სახელი', 'Provider name')} <span className="muted">({t('არასავალდებულო', 'optional')})</span></label>
                    <input
                      id={'special-provider-' + idSuffix + '-' + code}
                      className="input"
                      autoComplete="off"
                      maxLength={80}
                      value={form.providerLabel}
                      onChange={(e) => edit(code, { providerLabel: e.target.value })}
                    />
                  </div>
                )}
                <div className="field" style={{ marginTop: code === 'Other' ? 8 : 0 }}>
                  <label htmlFor={'special-comment-' + idSuffix + '-' + code}>{t('დეტალები', 'Details')} <span className="muted">({t('არასავალდებულო', 'optional')})</span></label>
                  <input
                    id={'special-comment-' + idSuffix + '-' + code}
                    className="input"
                    autoComplete="off"
                    maxLength={500}
                    value={form.comment}
                    onChange={(e) => edit(code, { comment: e.target.value })}
                  />
                </div>
                <div className="form-row" style={{ marginTop: 8 }}>
                  <div className="field" style={{ flex: '1 1 120px' }}>
                    <label htmlFor={'special-sells-' + idSuffix + '-' + code}>{t('წყვილი', 'Pair')} <span className="muted">({t('არასავალდებულო', 'optional')})</span></label>
                    <select id={'special-sells-' + idSuffix + '-' + code} className="select" value={form.sells} onChange={(e) => edit(code, { sells: e.target.value })}>
                      <option value="">{t('ვალუტა', 'Currency')}</option>
                      {CURRENCIES.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                    </select>
                  </div>
                  <div className="field" style={{ flex: '1 1 120px' }}>
                    <label htmlFor={'special-gets-' + idSuffix + '-' + code} className="sr-only">{t('მეორე ვალუტა', 'Second currency')}</label>
                    <select id={'special-gets-' + idSuffix + '-' + code} className="select" value={form.gets} onChange={(e) => edit(code, { gets: e.target.value })}>
                      <option value="">{t('ვალუტა', 'Currency')}</option>
                      {CURRENCIES.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                    </select>
                  </div>
                  <div className="field" style={{ flex: '1 1 140px' }}>
                    <label htmlFor={'special-rate-' + idSuffix + '-' + code}>{t('კურსი', 'Rate')} <span className="muted">({t('არასავალდებულო', 'optional')})</span></label>
                    <input
                      id={'special-rate-' + idSuffix + '-' + code}
                      className={'input' + (!rateParsed.ok ? ' invalid' : '')}
                      inputMode="decimal"
                      autoComplete="off"
                      value={form.rate}
                      onChange={(e) => edit(code, { rate: e.target.value.replace(/,/g, '.') })}
                    />
                  </div>
                </div>
                {!rateParsed.ok && <span className="hint error">{t('ჩაწერეთ კურსი, ან დატოვეთ ცარიელი', 'Enter a rate, or leave it blank')}</span>}
                {pairHalf && <span className="hint">{t('წყვილისთვის ორივე ვალუტაა საჭირო. ერთი ვალუტა არ ინახება.', 'A pair needs both currencies. One currency is not saved.')}</span>}
              </div>
            );
          })}
          {remaining.length > 0 && (
            <div className="field" style={{ marginTop: shown.length ? 12 : 0 }}>
              <span className="label" id={bankLabelId}>{shown.length ? t('სხვა ბანკის დამატება', 'Add another bank') : t('ბანკი / პროვაიდერი', 'Bank / provider')}</span>
              <div className="seg" role="group" aria-labelledby={bankLabelId}>
                {remaining.map((code) => (
                  <button key={code} type="button" onClick={() => addBank(code)}>
                    {code === 'Other' ? t('სხვა', 'Other') : code}
                  </button>
                ))}
              </div>
            </div>
          )}
          {shown.length === 0 && <span className="hint">{t('აირჩიეთ ბანკი, თუ ეს პირობა უნდა შეინახოს. მოთხოვნა ამის გარეშეც იგზავნება.', 'Choose a bank if this term should be saved. The request is still sent without it.')}</span>}
        </div>
      )}
    </section>
  );
}
