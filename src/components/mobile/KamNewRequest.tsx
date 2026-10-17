import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import ClientField, { type ClientInfo } from '../ClientField';
import ClientHistory from '../ClientHistory';
import ClientSpecialTerms from '../ClientSpecialTerms';
import DynamicActiveNegotiatedRates from '../DynamicActiveNegotiatedRates';
import CurrencyPicker from '../CurrencyPicker';
import { useI18n } from '../../lib/i18n';
import { EMPTY_SPECIAL_DRAFT, saveClientSpecialRate, type SpecialTermsDraft } from '../../lib/specialRates';
import { rpc } from '../../lib/supabase';
import { useToast } from '../../lib/toast';
import { BANKS, CURRENCIES, bankList } from '../../lib/types';
import { readAmount, readRate } from './amounts';
import StickyBar from './StickyBar';

export default function KamNewRequest({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const lock = useRef(false);
  const [formKey, setFormKey] = useState(0);

  const [info, setInfo] = useState<ClientInfo | null>(null);
  const [sells, setSells] = useState('USD');
  const [gets, setGets] = useState('GEL');
  const [sellsAmount, setSellsAmount] = useState('');
  const [getsAmount, setGetsAmount] = useState('');
  const [showGets, setShowGets] = useState(false);
  const [clientRate, setClientRate] = useState('');
  const [banks, setBanks] = useState<string[]>([]);
  const [banksFromClient, setBanksFromClient] = useState(false);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const appliedClient = useRef<string | null>(null);
  const bankClient = useRef<string | null>(null);
  const bankClientKnown = useRef(false);
  const banksTouched = useRef(false);
  const specialRef = useRef<SpecialTermsDraft>(EMPTY_SPECIAL_DRAFT);

  const sellsSide = readAmount(sellsAmount);
  const getsSide = readAmount(showGets ? getsAmount : '');
  const rateSide = readRate(clientRate);
  const hasAmount = sellsSide.value != null || getsSide.value != null;
  const bothBlank = sellsSide.ok && getsSide.ok && !hasAmount;
  const currenciesOk = sells !== gets && (CURRENCIES as readonly string[]).includes(sells) && (CURRENCIES as readonly string[]).includes(gets);
  const chosenBanks = bankList(banks);

  function onInfo(next: ClientInfo | null) {
    setInfo(next);
    if (next?.picked && next.lastSells && next.lastGets && appliedClient.current !== next.id) {
      const known = CURRENCIES as readonly string[];
      if (known.includes(next.lastSells) && known.includes(next.lastGets)) {
        appliedClient.current = next.id;
        setSells(next.lastSells);
        setGets(next.lastGets);
      }
    }
    if (!next?.valid || !next.id) return;
    if (bankClient.current === next.id) return;
    const previousKnown = bankClientKnown.current;
    bankClient.current = next.id;
    bankClientKnown.current = next.known;
    if (next.known) {
      const remembered = bankList(next.banks);
      setBanks(remembered);
      setBanksFromClient(remembered.length > 0);
      banksTouched.current = false;
    } else if (previousKnown && !banksTouched.current) {
      setBanks([]);
      setBanksFromClient(false);
    }
  }

  function toggleBank(code: string) {
    banksTouched.current = true;
    setBanksFromClient(false);
    setBanks((cur) => bankList(cur.includes(code) ? cur.filter((item) => item !== code) : [...cur, code]));
  }

  function pickSells(code: string) {
    setSells(code);
    if (gets === code) setGets(code === 'GEL' ? 'USD' : 'GEL');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    setTried(true);
    if (!info?.ready || !info.name || chosenBanks.length < 1 || !hasAmount || !sellsSide.ok || !getsSide.ok || !rateSide.ok || !currenciesOk) return;
    lock.current = true;
    setBusy(true);
    try {
      const pBank = BANKS.filter((code) => chosenBanks.includes(code));
      await rpc('log_request', {
        p_client_id: info.id,
        p_sells_currency: sells,
        p_gets_currency: gets,
        p_amount: sellsSide.value,
        p_gets_amount: getsSide.value,
        p_client_rate: rateSide.value,
        p_note: note.trim() || null,
        p_client_name: info.nameFromFile ? null : info.name,
        p_bank: pBank,
      });
      const special = await saveClientSpecialRate(info.id, specialRef.current);
      if (special === 'invalid' || special === 'failed') {
        toast(t('გაეგზავნა ხაზინას. საბანკო პირობა ვერ შეინახა.', 'Sent to treasury. The bank terms were not saved.'), 'error');
      } else {
        toast(t('გაეგზავნა ხაზინას.', 'Sent to treasury.'));
      }
      if (embedded) {
        setSells('USD');
        setGets('GEL');
        setSellsAmount('');
        setGetsAmount('');
        setShowGets(false);
        setClientRate('');
        setBanks([]);
        setBanksFromClient(false);
        setNote('');
        setTried(false);
        setHistoryOpen(false);
        setInfo(null);
        appliedClient.current = null;
        bankClient.current = null;
        bankClientKnown.current = false;
        banksTouched.current = false;
        specialRef.current = EMPTY_SPECIAL_DRAFT;
        setFormKey((key) => key + 1);
        lock.current = false;
        setBusy(false);
      }
      navigate('/requests#kam-waiting', { replace: true });
    } catch (err) {
      toast((err as Error).message, 'error');
      lock.current = false;
      setBusy(false);
    }
  }

  const clientReady = Boolean(info?.valid && info.id);

  const fields = (
    <>
      <div className="m-fields">
        <ClientField key={formKey} tried={tried} onInfo={onInfo} />
      </div>

      <div className="m-fields">
        <span className="label" id="client-banks-label">{t('ბანკი, სადაც კლიენტი აგზავნის', 'Bank the client is sending to')}</span>
        <div className="seg m-banks" role="group" aria-labelledby="client-banks-label" aria-invalid={tried && chosenBanks.length < 1}>
          {BANKS.map((code) => (
            <button key={code} type="button" aria-pressed={chosenBanks.includes(code)} onClick={() => toggleBank(code)}>
              {code}
            </button>
          ))}
        </div>
        {tried && chosenBanks.length < 1 && <span className="hint error">{t('აირჩიეთ ერთი ბანკი მაინც', 'Choose at least one bank')}</span>}
        {!tried && banksFromClient && <span className="hint">{t('შენახული ბანკები ჩანს. ამ გარიგებისთვის შეგიძლიათ შეცვალოთ.', 'Saved banks are on. You can change them for this deal.')}</span>}
      </div>

      <ClientSpecialTerms key={formKey} clientId={info?.valid ? info.id : null} idSuffix={embedded ? 'home' : 'phone'} requestSells={sells} requestGets={gets} onDraft={(draft) => { specialRef.current = draft; }} />
      <DynamicActiveNegotiatedRates clientId={info?.valid ? info.id : null} idSuffix={embedded ? 'home' : 'phone'} />

      <div className="m-fields" id="new-pair">
        <CurrencyPicker label={t('კლიენტი ყიდის', 'Client sells')} value={sells} onChange={pickSells} idSuffix="new" />
        <CurrencyPicker label={t('კლიენტი იღებს', 'Client gets')} value={gets} onChange={setGets} disabledValue={sells} idSuffix="new" />
        {tried && !currenciesOk && <span className="hint error">{t('აირჩიეთ ორი განსხვავებული ვალუტა', 'Choose two different currencies')}</span>}
      </div>

      <div className="field">
        <label htmlFor="sells-amount">{t('თანხა', 'Amount')}</label>
        <input
          id="sells-amount"
          className={'input m-amount' + (tried && !sellsSide.ok ? ' invalid' : '')}
          inputMode="decimal"
          autoComplete="off"
          value={sellsAmount}
          onChange={(e) => setSellsAmount(e.target.value)}
        />
        {tried && !sellsSide.ok && <span className="hint error">{t('ჩაწერეთ სწორი თანხა, ან დატოვეთ ეს მხარე ცარიელი', 'Enter a valid amount, or leave this side blank')}</span>}
        {tried && bothBlank && <span className="hint error">{t('ჩაწერეთ თანხა ერთ მხარეს', 'Enter an amount on one side')}</span>}
      </div>

      <div className="m-fields">
        <button
          type="button"
          className="m-disclosure"
          aria-expanded={showGets}
          onClick={() => setShowGets((open) => !open)}
        >
          {t('მეორე თანხა', 'Second amount')}
        </button>
        {showGets && (
          <div className="field">
            <label htmlFor="gets-amount">{t('თანხა, რომელსაც კლიენტი იღებს', 'Amount the client gets')} <span className="muted">({t('არასავალდებულო', 'optional')})</span></label>
            <input
              id="gets-amount"
              className={'input m-amount' + (tried && !getsSide.ok ? ' invalid' : '')}
              inputMode="decimal"
              autoComplete="off"
              value={getsAmount}
              onChange={(e) => setGetsAmount(e.target.value)}
            />
            {tried && !getsSide.ok && <span className="hint error">{t('ჩაწერეთ სწორი თანხა, ან დატოვეთ ეს მხარე ცარიელი', 'Enter a valid amount, or leave this side blank')}</span>}
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="client-rate">{t('კურსი, რომელსაც კლიენტი ითხოვს', 'Rate the client is asking for')} <span className="muted">({t('არასავალდებულო', 'optional')})</span></label>
        <input
          id="client-rate"
          className={'input' + (tried && !rateSide.ok ? ' invalid' : '')}
          inputMode="decimal"
          autoComplete="off"
          value={clientRate}
          onChange={(e) => setClientRate(e.target.value)}
        />
        {tried && !rateSide.ok && <span className="hint error">{t('ჩაწერეთ კურსი, რომელსაც კლიენტი ითხოვს, ან დატოვეთ ცარიელი', 'Enter the rate the client wants, or leave it blank')}</span>}
      </div>

      <div className="field">
        <label htmlFor="treasury-comment">{t('კომენტარი ხაზინას', 'Comment for treasury')} <span className="muted">({t('არასავალდებულო', 'optional')})</span></label>
        <input id="treasury-comment" className="input" autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      <div className="m-fields">
        <button
          type="button"
          className="m-disclosure"
          aria-expanded={historyOpen}
          disabled={!clientReady}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          {t('კლიენტის ისტორია', 'Client history')}
        </button>
        {historyOpen && clientReady && info?.id && <ClientHistory clientId={info.id} />}
      </div>
    </>
  );

  return (
    <form className={embedded ? 'm-form' : 'm-form m-dock'} onSubmit={submit} noValidate>
      {embedded ? fields : <div className="m-scroll">{fields}</div>}
      {embedded ? (
        <button type="submit" className="btn btn-primary m-send" disabled={busy}>
          {busy ? t('იგზავნება', 'Sending') : t('კურსის თხოვნა ხაზინას', 'Ask treasury for a rate')}
        </button>
      ) : (
        <StickyBar>
          <button type="submit" className="btn btn-primary m-send" disabled={busy}>
            {busy ? t('იგზავნება', 'Sending') : t('კურსის თხოვნა ხაზინას', 'Ask treasury for a rate')}
          </button>
        </StickyBar>
      )}
    </form>
  );
}
