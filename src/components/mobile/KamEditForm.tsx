import { useState, type FormEvent } from 'react';
import CurrencyPicker from '../CurrencyPicker';
import DeleteRequestButton from '../DeleteRequestButton';
import { useI18n } from '../../lib/i18n';
import { useViewAs } from '../../lib/viewAs';
import { rpc } from '../../lib/supabase';
import { useToast } from '../../lib/toast';
import { BANKS, CURRENCIES, bankList, type RequestRow } from '../../lib/types';
import { isWrittenHistory } from '../../lib/requestStatus';
import { readAmount, readRate } from './amounts';

function currencyKept(code: string, original: string | null) {
  if (code === original && /^[A-Z]{3}$/.test(code)) return true;
  return (CURRENCIES as readonly string[]).includes(code);
}

/** Same edit_request arguments and checks as the desktop form, stacked for a phone. */
export default function KamEditForm({
  row,
  onClose,
  onSaved,
  onDeleted,
}: {
  row: RequestRow;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const { realRole } = useViewAs();
  const toast = useToast();
  const [clientId, setClientId] = useState(row.client_id);
  const [name, setName] = useState(row.client_name ?? '');
  const [sells, setSells] = useState(row.sells_currency && /^[A-Z]{3}$/.test(row.sells_currency) ? row.sells_currency : 'USD');
  const [gets, setGets] = useState(row.gets_currency && /^[A-Z]{3}$/.test(row.gets_currency) ? row.gets_currency : 'GEL');
  const [sellsAmt, setSellsAmt] = useState(row.amount != null ? String(row.amount) : '');
  const [getsAmt, setGetsAmt] = useState(row.gets_amount != null ? String(row.gets_amount) : '');
  const [rate, setRate] = useState(row.client_rate != null ? String(row.client_rate) : '');
  const [banks, setBanks] = useState<string[]>(bankList(row.bank));
  const [note, setNote] = useState(row.note ?? '');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  const idOk = /^([0-9]{9}|[0-9]{11})$/.test(clientId.trim());
  const nameOk = name.trim().length >= 2;
  const sellAmt = readAmount(sellsAmt);
  const getAmt = readAmount(getsAmt);
  const rateAmt = readRate(rate);
  const picked = bankList(banks);
  const pairOk = sells !== gets && currencyKept(sells, row.sells_currency) && currencyKept(gets, row.gets_currency);
  const hasSide = sellAmt.value != null || getAmt.value != null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!idOk || !nameOk || !sellAmt.ok || !getAmt.ok || !rateAmt.ok || !pairOk || !hasSide || picked.length < 1 || busy) return;
    setBusy(true);
    try {
      await rpc('edit_request', {
        p_request_id: row.id,
        p_client_id: clientId.trim(),
        p_client_name: name.trim(),
        p_sells_currency: sells,
        p_gets_currency: gets,
        p_amount: sellAmt.value,
        p_gets_amount: getAmt.value,
        p_client_rate: rateAmt.value,
        p_note: note.trim() || null,
        p_bank: BANKS.filter((code) => picked.includes(code)),
      });
      toast(t('მოთხოვნა შეიცვალა.', 'Request updated.'));
      onSaved();
    } catch (err) {
      toast((err as Error).message, 'error');
      setBusy(false);
    }
  }

  return (
    <form className="m-edit" onSubmit={save} noValidate>
      <div className="field">
        <label htmlFor={'edit-id-' + row.id}>{t('კლიენტის ID', 'Client ID')}</label>
        <input id={'edit-id-' + row.id} className={'input' + (tried && !idOk ? ' invalid' : '')} inputMode="numeric" autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        {tried && !idOk && <span className="hint error">{t('კომპანიას 9 ციფრი აქვს, ადამიანს 11', 'A company has 9 digits, a person 11')}</span>}
      </div>
      <div className="field">
        <label htmlFor={'edit-name-' + row.id}>{t('კლიენტის სახელი', 'Client name')}</label>
        <input id={'edit-name-' + row.id} className={'input' + (tried && !nameOk ? ' invalid' : '')} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        {tried && !nameOk && <span className="hint error">{t('ჩაწერეთ სახელი', 'Enter the name')}</span>}
      </div>
      <div className="field">
        <span className="label" id={'edit-banks-' + row.id}>{t('ბანკი, სადაც კლიენტი აგზავნის', 'Bank the client is sending to')}</span>
        <div className="seg m-banks" role="group" aria-labelledby={'edit-banks-' + row.id}>
          {BANKS.map((code) => (
            <button key={code} type="button" aria-pressed={picked.includes(code)} onClick={() => setBanks((cur) => bankList(cur.includes(code) ? cur.filter((item) => item !== code) : [...cur, code]))}>
              {code}
            </button>
          ))}
        </div>
        {tried && picked.length < 1 && <span className="hint error">{t('აირჩიეთ ერთი ბანკი მაინც', 'Choose at least one bank')}</span>}
      </div>
      <CurrencyPicker label={t('კლიენტი ყიდის', 'Client sells')} value={sells} onChange={(c) => { setSells(c); if (gets === c) setGets(c === 'GEL' ? 'USD' : 'GEL'); }} idSuffix={'edit-' + row.id} />
      <div className="field">
        <label htmlFor={'edit-sells-' + row.id}>{t('თანხა', 'Amount')}</label>
        <input id={'edit-sells-' + row.id} className={'input' + (tried && !sellAmt.ok ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={sellsAmt} onChange={(e) => setSellsAmt(e.target.value)} />
      </div>
      <CurrencyPicker label={t('კლიენტი იღებს', 'Client gets')} value={gets} onChange={setGets} disabledValue={sells} idSuffix={'edit-' + row.id} />
      <div className="field">
        <label htmlFor={'edit-gets-' + row.id}>{t('თანხა', 'Amount')}</label>
        <input id={'edit-gets-' + row.id} className={'input' + (tried && !getAmt.ok ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={getsAmt} onChange={(e) => setGetsAmt(e.target.value)} />
      </div>
      {tried && !pairOk && <span className="hint error">{t('აირჩიეთ ორი განსხვავებული ვალუტა', 'Choose two different currencies')}</span>}
      {tried && sellAmt.ok && getAmt.ok && !hasSide && <span className="hint error">{t('ჩაწერეთ თანხა ერთ მხარეს', 'Enter an amount on one side')}</span>}
      <div className="field">
        <label htmlFor={'edit-rate-' + row.id}>{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')}</label>
        <input id={'edit-rate-' + row.id} className={'input' + (tried && !rateAmt.ok ? ' invalid' : '')} inputMode="decimal" autoComplete="off" value={rate} onChange={(e) => setRate(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={'edit-note-' + row.id}>{t('კომენტარი ხაზინას', 'Comment for treasury')}</label>
        <input id={'edit-note-' + row.id} className="input" autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <button type="submit" className="btn btn-primary m-send" disabled={busy}>{busy ? t('ინახება', 'Saving') : t('შენახვა', 'Save')}</button>
      <button type="button" className="m-text-btn" onClick={onClose}>{t('გაუქმება', 'Cancel')}</button>
      {(realRole === 'admin' || !isWrittenHistory(row)) && <DeleteRequestButton requestId={row.id} onDeleted={onDeleted} />}
    </form>
  );
}
