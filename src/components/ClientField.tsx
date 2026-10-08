import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { rpc } from '../lib/supabase';
import { bankList, type ClientMatch } from '../lib/types';

export interface ClientInfo {
  id: string;
  valid: boolean;
  known: boolean;
  /** Stored name, or the name typed for a client that has none. */
  name: string | null;
  /** The name on screen is the one already stored. Do not send it back as a replacement. */
  nameFromFile: boolean;
  picked: boolean;
  /** Both the ID and a usable name are present, so the request can be sent. */
  ready: boolean;
  /** Banks remembered on the client. Empty when this client has none yet. */
  banks: string[];
  lastSells?: string | null;
  lastGets?: string | null;
}

interface Props {
  onInfo: (info: ClientInfo | null) => void;
  tried: boolean;
}

interface Lookup {
  client_id: string;
  valid: boolean;
  known: boolean;
  name: string | null;
  kind: string | null;
  banks?: string[] | string | null;
}

interface Resolved {
  id: string;
  valid: boolean;
  known: boolean;
  storedName: string | null;
  idFromFile: boolean;
  nameFromFile: boolean;
  picked: boolean;
  banks: string[];
  kind: string | null;
  padded: boolean;
  lastSells: string | null;
  lastGets: string | null;
}

const NAME_MAX = 200;

/** Client ID and name, each in its own field. One fills the other when the client is already on file. */
export default function ClientField({ onInfo, tried }: Props) {
  const { t } = useI18n();
  const [idText, setIdText] = useState('');
  const [nameText, setNameText] = useState('');
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [nameHits, setNameHits] = useState<{ q: string; rows: ClientMatch[] } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  const onInfoRef = useRef(onInfo);
  onInfoRef.current = onInfo;
  const idRef = useRef(idText);
  idRef.current = idText;
  const nameRef = useRef(nameText);
  nameRef.current = nameText;
  const idSeq = useRef(0);
  const nameSeq = useRef(0);
  const skipIdLookup = useRef(false);
  const skipNameSearch = useRef(false);

  const idFromFile = Boolean(resolved?.idFromFile);
  const nameFromFile = Boolean(resolved?.nameFromFile);

  function publish(next: Resolved | null, typedName: string) {
    if (!next) {
      onInfoRef.current(null);
      return;
    }
    const typed = typedName.trim();
    const fileName = next.nameFromFile && next.storedName ? next.storedName.trim() : '';
    const name = fileName || typed || null;
    const typedOk = typed.length >= 2 && typed.length <= NAME_MAX;
    onInfoRef.current({
      id: next.id,
      valid: next.valid,
      known: next.known,
      name,
      nameFromFile: Boolean(fileName),
      picked: next.picked,
      ready: next.valid && (fileName ? true : typedOk),
      banks: next.banks,
      lastSells: next.lastSells,
      lastGets: next.lastGets,
    });
  }

  function applyMatch(m: ClientMatch) {
    skipIdLookup.current = true;
    skipNameSearch.current = true;
    const next: Resolved = {
      id: m.client_id,
      valid: true,
      known: true,
      storedName: m.name,
      idFromFile: true,
      nameFromFile: Boolean(m.name && m.name.trim()),
      picked: true,
      banks: bankList(m.banks),
      kind: m.kind,
      padded: false,
      lastSells: m.last_sells_currency,
      lastGets: m.last_gets_currency,
    };
    setListOpen(false);
    setNameHits(null);
    setIdText(m.client_id);
    setNameText(m.name ?? '');
    setResolved(next);
    publish(next, m.name ?? '');
  }

  function clearClient() {
    skipIdLookup.current = true;
    skipNameSearch.current = true;
    setIdText('');
    setNameText('');
    setResolved(null);
    setNameHits(null);
    setListOpen(false);
    onInfoRef.current(null);
  }

  useEffect(() => {
    if (skipIdLookup.current) {
      skipIdLookup.current = false;
      return;
    }
    if (idFromFile) return;
    const raw = idText.trim();
    const my = ++idSeq.current;
    if (!/^\d+$/.test(raw) || (raw.length !== 9 && raw.length !== 10 && raw.length !== 11)) {
      setResolved(null);
      publish(null, nameRef.current);
      return;
    }
    const handle = window.setTimeout(async () => {
      try {
        const rows = await rpc<Lookup[]>('lookup_client', { p_client_id: raw });
        if (my !== idSeq.current) return;
        const row = rows?.[0];
        if (!row) return;
        const padded = raw.length === 10 && row.client_id !== raw;
        if (row.client_id !== raw) {
          skipIdLookup.current = true;
          setIdText(row.client_id);
        }
        const stored = row.name?.trim() ? row.name : null;
        const fromFile = Boolean(row.valid && row.known && stored);
        if (fromFile && stored) {
          skipNameSearch.current = true;
          setNameText(stored);
        }
        const next: Resolved = {
          id: row.client_id,
          valid: row.valid,
          known: row.known,
          storedName: stored,
          idFromFile: false,
          nameFromFile: fromFile,
          picked: false,
          banks: bankList(row.banks),
          kind: row.kind,
          padded,
          lastSells: null,
          lastGets: null,
        };
        setResolved(next);
        publish(next, fromFile && stored ? stored : nameRef.current);
      } catch {
        /* keep the last state */
      }
    }, 180);
    return () => window.clearTimeout(handle);
    // name text is read from a ref so typing a name does not refetch the ID
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idText, idFromFile]);

  useEffect(() => {
    if (skipNameSearch.current) {
      skipNameSearch.current = false;
      return;
    }
    if (nameFromFile || idFromFile || idText.length > 0) return;
    if (!listOpen && nameText.trim() === '') return;
    const my = ++nameSeq.current;
    const q = nameText.trim();
    const handle = window.setTimeout(async () => {
      try {
        const list = await rpc<ClientMatch[]>('search_my_clients', { p_query: q, p_limit: 8 });
        if (my !== nameSeq.current || idRef.current.length > 0) return;
        const rows = list ?? [];
        if (q.length >= 1 && rows.length === 1) {
          applyMatch(rows[0]);
          return;
        }
        setNameHits({ q, rows });
        setActive(0);
      } catch {
        /* keep the last state */
      }
    }, 180);
    return () => window.clearTimeout(handle);
    // applyMatch only uses the search result and setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameText, listOpen, idText, nameFromFile, idFromFile]);

  useEffect(() => {
    // A stored name is already published. A name the KAM is typing (new client,
    // or a client on file with no name) has to reach the form as it changes.
    if (!resolved || resolved.nameFromFile) return;
    publish(resolved, nameText);
    // publish is recreated each render and only reads the latest text
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameText, resolved]);

  function onIdChange(value: string) {
    if (idFromFile) return;
    const digits = value.replace(/\D/g, '').slice(0, 16);
    setIdText(digits);
    setListOpen(false);
    setResolved(null);
    onInfoRef.current(null);
    if (nameFromFile) {
      skipNameSearch.current = true;
      setNameText('');
    }
  }

  function onNameChange(value: string) {
    if (nameFromFile) return;
    setNameText(value.slice(0, NAME_MAX));
    if (!idFromFile && idText.length === 0) setListOpen(true);
  }

  const query = nameText.trim();
  const hits = nameHits && nameHits.q === query ? nameHits.rows : [];
  const several = !idText && !nameFromFile && !idFromFile && query.length > 0 && hits.length > 1;
  const nameMissing = !nameFromFile && query.length === 0 && Boolean(resolved?.valid && !resolved.storedName);
  const showList = listOpen && !idFromFile && !nameFromFile && idText.length === 0 && hits.length > 0 && !(query.length >= 1 && hits.length === 1);
  const typedLen = query.length;
  const nameTooLong = typedLen > NAME_MAX;
  const nameTooShort = !nameFromFile && typedLen > 0 && typedLen < 2 && Boolean(resolved?.valid || tried);

  let idHint = t('კომპანიას 9 ციფრი აქვს, ფიზიკურ პირს 11', 'A company has 9 digits, a person has 11');
  let idTone: '' | 'ok' | 'error' = '';
  if (idFromFile) {
    idHint = t('ID ფაილიდან შეივსო', 'ID filled in from the file');
    idTone = 'ok';
  } else if (/^\d+$/.test(idText) && idText.length > 11) {
    idHint = t('ზედმეტი ციფრია: კომპანიას 9 აქვს, ფიზიკურ პირს 11', 'Too many digits: a company has 9, a person has 11');
    idTone = 'error';
  } else if (resolved?.valid && resolved.known) {
    const kind = resolved.kind === 'company' ? t('კომპანია', 'Company') : t('ფიზიკური პირი', 'Person');
    idHint = resolved.padded
      ? t('თავში 0 დაემატა. {kind}, ბაზაშია.', 'A leading 0 was added. {kind}, already on file.', { kind })
      : t('{kind}, ბაზაშია.', '{kind}, already on file.', { kind });
    idTone = 'ok';
  } else if (resolved?.valid && !resolved.known) {
    idHint = t('ეს ID ბაზაში არ არის. ახალი კლიენტია — სახელიც აუცილებელია.', 'This ID is not in the database. New client — the name is required too.');
  } else if (several) {
    idHint = t('რამდენიმე კლიენტი ემთხვევა. აირჩიეთ ერთი, ან ჩაწერეთ ID.', 'Several clients match. Pick one, or type the ID.');
    if (tried) idTone = 'error';
  } else if (tried && !idText) {
    idHint = t('შეიყვანეთ კლიენტის ID', 'Enter the client ID');
    idTone = 'error';
  } else if (tried && !resolved?.valid) {
    idHint = t('შეამოწმეთ ID: კომპანიას 9 ციფრი აქვს, ფიზიკურ პირს 11', 'Check the ID: a company has 9 digits, a person has 11');
    idTone = 'error';
  }

  let nameHint = t('აკრიფეთ სახელი, ან ის ID-დან შეივსება', 'Type a name, or it will fill in from the ID');
  let nameTone: '' | 'ok' | 'error' = '';
  if (nameFromFile) {
    nameHint = t('სახელი ფაილიდან შეივსო', 'Name filled in from the file');
    nameTone = 'ok';
  } else if (nameTooLong || (tried && typedLen > NAME_MAX)) {
    nameHint = t('სახელი 200 სიმბოლოზე გრძელია', 'The name is longer than 200 characters');
    nameTone = 'error';
  } else if (several) {
    nameHint = t('რამდენიმე კლიენტი ემთხვევა. აირჩიეთ ერთი.', 'Several clients match. Pick one.');
    if (tried) nameTone = 'error';
  } else if (resolved?.valid && resolved.known && !resolved.storedName) {
    nameHint = t('ამ კლიენტს სახელი არ აქვს. ჩაწერეთ, რომ შეინახოს.', 'This client has no name. Type one so it is saved.');
    if (tried && typedLen < 2) nameTone = 'error';
  } else if (resolved?.valid && !resolved.known) {
    nameHint = t('ბაზაში არ არის. ჩაწერეთ სახელი. ID-იც და სახელიც შეინახება.', 'Not in the database. Type the name. Both the ID and the name are saved.');
    if (tried && typedLen < 2) nameTone = 'error';
  } else if (!idText && query.length > 0 && nameHits?.q === query && hits.length === 0) {
    nameHint = t('ეს სახელი ბაზაში არ არის. ახალი კლიენტისთვის ჩაწერეთ ID-იც.', 'This name is not in the database. For a new client, type the ID as well.');
    if (tried) nameTone = 'error';
  } else if (tried && !query) {
    nameHint = t('ჩაწერეთ კლიენტის სახელი', 'Enter the client name');
    nameTone = 'error';
  } else if (nameTooShort) {
    nameHint = t('სახელი მინიმუმ 2 სიმბოლოა', 'The name needs at least 2 characters');
    if (tried) nameTone = 'error';
  }

  const idInvalid = idTone === 'error';
  const nameInvalid = nameTone === 'error';
  const locked = idFromFile || nameFromFile;

  return (
    <>
      <div className="field" style={{ flex: '1 1 200px', minWidth: 180 }}>
        <label htmlFor="client-id">{t('კლიენტის ID', 'Client ID')}</label>
        <input
          id="client-id"
          className={'input' + (idFromFile ? ' from-file' : '') + (idInvalid ? ' invalid' : '')}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          readOnly={idFromFile}
          aria-invalid={idInvalid}
          placeholder={t('9 ან 11 ციფრი', '9 or 11 digits')}
          value={idText}
          onChange={(e) => onIdChange(e.target.value)}
        />
        <span className={'hint ' + idTone}>{idHint}</span>
      </div>
      <div className="field combo" style={{ flex: '1 1 240px', minWidth: 200 }}>
        <label htmlFor="client-name">{t('კლიენტის სახელი', 'Client name')}</label>
        <input
          id="client-name"
          className={'input' + (nameFromFile ? ' from-file' : '') + (nameMissing && !nameInvalid ? ' attention' : '') + (nameInvalid ? ' invalid' : '')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls="client-list"
          aria-invalid={nameInvalid}
          aria-activedescendant={showList && hits.length ? 'client-opt-' + active : undefined}
          autoComplete="off"
          spellCheck={false}
          readOnly={nameFromFile}
          maxLength={NAME_MAX}
          placeholder={t('კომპანიის ან პირის სრული სახელი', 'Full name of the company or person')}
          value={nameText}
          onChange={(e) => onNameChange(e.target.value)}
          onFocus={() => { if (!nameFromFile && !idFromFile && idText.length === 0) setListOpen(true); }}
          onBlur={() => window.setTimeout(() => setListOpen(false), 150)}
          onKeyDown={(e) => {
            if (!showList) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter' && hits[active]) { e.preventDefault(); applyMatch(hits[active]); }
            else if (e.key === 'Escape') setListOpen(false);
          }}
        />
        <span className={'hint ' + nameTone}>{nameHint}</span>
        {locked && (
          <button type="button" className="link" onClick={clearClient}>{t('სხვა კლიენტი', 'Different client')}</button>
        )}
        {showList && (
          <div id="client-list" role="listbox" aria-label={t('კლიენტები', 'Clients')} className="combo-list">
            <div className="head">{query ? t('აირჩიეთ კლიენტი', 'Choose a client') : t('თქვენი ბოლო კლიენტები', 'Your recent clients')}</div>
            {hits.map((m, i) => (
              <button
                key={m.client_id}
                id={'client-opt-' + i}
                type="button"
                role="option"
                aria-selected={i === active}
                tabIndex={-1}
                className="combo-option"
                onMouseDown={(e) => { e.preventDefault(); applyMatch(m); }}
              >
                <span style={{ minWidth: 0 }}>
                  <span className="strong" style={{ display: 'block' }}>{m.name ?? t('სახელი არ არის', 'No name')}</span>
                  <span className="tiny muted">ID {m.client_id}, {m.kind === 'company' ? t('კომპანია', 'Company') : t('ფიზიკური პირი', 'Person')}</span>
                </span>
                {m.last_sells_currency && <span className="tiny muted">{m.last_sells_currency} → {m.last_gets_currency}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
