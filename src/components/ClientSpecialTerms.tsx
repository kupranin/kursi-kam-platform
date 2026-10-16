import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { CURRENCIES } from '../lib/types';
import { fmtRate, parseRate } from '../lib/format';
import {
  EMPTY_SPECIAL_DRAFT,
  SPECIAL_BANKS,
  loadSpecialRates,
  type SpecialBank,
  type SpecialRateRow,
  type SpecialTermsDraft,
} from '../lib/specialRates';
import LoadingLine from './LoadingLine';

interface Props {
  clientId: string | null;
  idSuffix: string;
  onDraft: (draft: SpecialTermsDraft) => void;
}

function rateText(rate: number | null): string {
  return rate == null ? '' : String(rate);
}

function sameRate(text: string, stored: number | null): boolean {
  const parsed = parseRate(text);
  if (!parsed.ok) return false;
  if (parsed.value == null && stored == null) return true;
  if (parsed.value == null || stored == null) return false;
  return Math.abs(parsed.value - stored) < 1e-9;
}

function latest(rows: SpecialRateRow[]): SpecialRateRow {
  return [...rows].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))[0];
}

/** Optional client-reported bank terms on the new-request form. Hidden when setup 42 is absent. */
export default function ClientSpecialTerms({ clientId, idSuffix, onDraft }: Props) {
  const { t } = useI18n();
  const [gate, setGate] = useState<'unknown' | 'on' | 'off'>('unknown');
  const [rows, setRows] = useState<SpecialRateRow[]>([]);
  const [on, setOn] = useState(false);
  const [bank, setBank] = useState<SpecialBank | ''>('');
  const [providerLabel, setProviderLabel] = useState('');
  const [comment, setComment] = useState('');
  const [sells, setSells] = useState('');
  const [gets, setGets] = useState('');
  const [rate, setRate] = useState('');
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const checkId = 'special-rate-on-' + idSuffix;
  const bankLabelId = 'special-bank-' + idSuffix;

  function fill(row: SpecialRateRow | null) {
    setBank(row?.bank ?? '');
    setProviderLabel(row?.provider_label ?? '');
    setComment(row?.comment ?? '');
    setSells(row?.sells_currency ?? '');
    setGets(row?.gets_currency ?? '');
    setRate(rateText(row?.rate ?? null));
  }

  useEffect(() => {
    let live = true;
    setOn(false);
    setRows([]);
    fill(null);
    loadSpecialRates(clientId ? [clientId] : [])
      .then((result) => {
        if (!live) return;
        if (result.missing) {
          setGate('off');
          return;
        }
        setGate('on');
        setRows(result.rows);
        if (result.rows.length) {
          setOn(true);
          fill(latest(result.rows));
        }
      })
      .catch(() => {
        if (live) setGate('on');
      });
    return () => {
      live = false;
    };
  }, [clientId]);

  const saved = bank ? rows.find((row) => row.bank === bank) ?? null : null;
  const dirty = on && bank !== '' && (
    !saved
    || comment.trim() !== (saved.comment ?? '')
    || (bank === 'Other' && providerLabel.trim() !== (saved.provider_label ?? ''))
    || sells !== (saved.sells_currency ?? '')
    || gets !== (saved.gets_currency ?? '')
    || !sameRate(rate, saved.rate)
  );

  useEffect(() => {
    if (gate === 'off') {
      onDraftRef.current(EMPTY_SPECIAL_DRAFT);
      return;
    }
    onDraftRef.current({ on, bank, providerLabel, comment, sells, gets, rate, dirty });
  }, [gate, on, bank, providerLabel, comment, sells, gets, rate, dirty]);

  function pickBank(code: SpecialBank) {
    const row = rows.find((item) => item.bank === code) ?? null;
    setBank(code);
    setProviderLabel(row?.provider_label ?? '');
    setComment(row?.comment ?? '');
    setSells(row?.sells_currency ?? '');
    setGets(row?.gets_currency ?? '');
    setRate(rateText(row?.rate ?? null));
  }

  if (gate === 'off') return null;
  if (gate === 'unknown') return <LoadingLine compact />;

  const rateParsed = parseRate(rate);
  const pairHalf = Boolean(sells) !== Boolean(gets);

  return (
    <section className="special-terms" aria-labelledby={bankLabelId + '-title'}>
      <h3 id={bankLabelId + '-title'} className="small strong" style={{ margin: '0 0 4px' }}>{t('კლიენტის საბანკო პირობები', 'Client bank terms')}</h3>
      <p className="tiny muted" style={{ margin: '0 0 8px' }}>{t('კლიენტის თქმით. ეს შემოწმებული საბაზრო კურსი არ არის.', 'As reported by the client. This is not a verified market rate.')}</p>
      <label className="checkbox" htmlFor={checkId}>
        <input id={checkId} type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span>{t('კლიენტს აქვს ბანკის სპეციალური კურსი', 'The client has a special bank rate')}</span>
      </label>
      {on && (
        <div className="special-terms-body">
          <p className="hint" style={{ margin: '4px 0 8px' }}>{t('ეს არ არის ბანკი, სადაც კლიენტი აგზავნის. ცარიელი ველი შენახულ პირობას არ შლის.', 'This is not the bank the client is sending to. A blank field does not erase a saved term.')}</p>
          {rows.length > 0 && (
            <ul className="special-saved">
              {rows.map((row) => (
                <li key={row.bank}>
                  <button type="button" className="link" onClick={() => pickBank(row.bank)}>
                    {row.bank === 'Other' ? (row.provider_label || t('სხვა', 'Other')) : row.bank}
                    {row.sells_currency && row.gets_currency ? ` · ${row.sells_currency}/${row.gets_currency}` : ''}
                    {row.rate != null ? ` · ${fmtRate(row.rate)}` : ''}
                    {row.comment ? ` · ${row.comment}` : ''}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <span className="label" id={bankLabelId}>{t('ბანკი / პროვაიდერი', 'Bank / provider')}</span>
          <div className="seg" role="group" aria-labelledby={bankLabelId}>
            {SPECIAL_BANKS.map((code) => (
              <button key={code} type="button" aria-pressed={bank === code} onClick={() => pickBank(code)}>
                {code === 'Other' ? t('სხვა', 'Other') : code}
              </button>
            ))}
          </div>
          {bank === 'Other' && (
            <div className="field" style={{ marginTop: 8 }}>
              <label htmlFor={'special-provider-' + idSuffix}>{t('პროვაიდერის სახელი', 'Provider name')} <span className="muted">({t('არასავალდებულო', 'optional')})</span></label>
              <input
                id={'special-provider-' + idSuffix}
                className="input"
                autoComplete="off"
                maxLength={80}
                value={providerLabel}
                onChange={(e) => setProviderLabel(e.target.value)}
              />
            </div>
          )}
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor={'special-comment-' + idSuffix}>{t('დეტალები', 'Details')} <span className="muted">({t('არასავალდებულო', 'optional')})</span></label>
            <input
              id={'special-comment-' + idSuffix}
              className="input"
              autoComplete="off"
              maxLength={500}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
          <div className="form-row" style={{ marginTop: 8 }}>
            <div className="field" style={{ flex: '1 1 120px' }}>
              <label htmlFor={'special-sells-' + idSuffix}>{t('წყვილი', 'Pair')} <span className="muted">({t('არასავალდებულო', 'optional')})</span></label>
              <select id={'special-sells-' + idSuffix} className="select" value={sells} onChange={(e) => setSells(e.target.value)}>
                <option value="">{t('ვალუტა', 'Currency')}</option>
                {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '1 1 120px' }}>
              <label htmlFor={'special-gets-' + idSuffix} className="sr-only">{t('მეორე ვალუტა', 'Second currency')}</label>
              <select id={'special-gets-' + idSuffix} className="select" value={gets} onChange={(e) => setGets(e.target.value)}>
                <option value="">{t('ვალუტა', 'Currency')}</option>
                {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '1 1 140px' }}>
              <label htmlFor={'special-rate-' + idSuffix}>{t('კურსი', 'Rate')} <span className="muted">({t('არასავალდებულო', 'optional')})</span></label>
              <input
                id={'special-rate-' + idSuffix}
                className={'input' + (!rateParsed.ok ? ' invalid' : '')}
                inputMode="decimal"
                autoComplete="off"
                value={rate}
                onChange={(e) => setRate(e.target.value.replace(/,/g, '.'))}
              />
            </div>
          </div>
          {on && !bank && <span className="hint">{t('აირჩიეთ ბანკი, თუ ეს პირობა უნდა შეინახოს. მოთხოვნა ამის გარეშეც იგზავნება.', 'Choose a bank if this term should be saved. The request is still sent without it.')}</span>}
          {!rateParsed.ok && <span className="hint error">{t('ჩაწერეთ კურსი, ან დატოვეთ ცარიელი', 'Enter a rate, or leave it blank')}</span>}
          {pairHalf && <span className="hint">{t('წყვილისთვის ორივე ვალუტაა საჭირო. ერთი ვალუტა არ ინახება.', 'A pair needs both currencies. One currency is not saved.')}</span>}
        </div>
      )}
    </section>
  );
}
