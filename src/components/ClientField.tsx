import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { rpc } from '../lib/supabase';
import type { ClientMatch } from '../lib/types';

export interface ClientInfo {
  id: string;
  valid: boolean;
  known: boolean;
  name: string | null;
  picked: boolean;
  lastSells?: string | null;
  lastGets?: string | null;
}

interface Props {
  value: string;
  onChange: (raw: string) => void;
  onInfo: (info: ClientInfo | null) => void;
  tried: boolean;
  big?: boolean;
}

interface Lookup { client_id: string; valid: boolean; known: boolean; name: string | null; kind: string | null }

/** "Client ID or name". Typing searches the shared company directory. */
export default function ClientField({ value, onChange, onInfo, tried, big }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState<ClientMatch[]>([]);
  const [active, setActive] = useState(0);
  const [info, setInfo] = useState<ClientInfo | null>(null);
  const seq = useRef(0);
  const raw = value.trim();
  const digits = /^\d+$/.test(raw);

  // search as the user types (debounced), and look up a full ID
  useEffect(() => {
    const my = ++seq.current;
    const t = window.setTimeout(async () => {
      try {
        const list = await rpc<ClientMatch[]>('search_my_clients', { p_query: raw, p_limit: 8 });
        if (my !== seq.current) return;
        setMatches(list ?? []);
        setActive(0);
        if (info?.picked && info.id === raw) return;
        if (digits && (raw.length === 9 || raw.length === 10 || raw.length === 11)) {
          const rows = await rpc<Lookup[]>('lookup_client', { p_client_id: raw });
          if (my !== seq.current) return;
          const r = rows?.[0];
          const next: ClientInfo | null = r
            ? { id: r.client_id, valid: r.valid, known: r.known, name: r.name, picked: false }
            : null;
          setInfo(next);
          onInfo(next);
        } else {
          setInfo(null);
          onInfo(null);
        }
      } catch {
        /* keep the last state */
      }
    }, 180);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  function pick(m: ClientMatch) {
    const next: ClientInfo = {
      id: m.client_id, valid: true, known: true, name: m.name, picked: true,
      lastSells: m.last_sells_currency, lastGets: m.last_gets_currency,
    };
    setInfo(next);
    onChange(m.client_id);
    onInfo(next);
    setOpen(false);
  }

  const showList = open && !(info?.picked && info.id === raw);
  let hint = t('აკრიფეთ ID-ის ციფრები ან სახელის ნაწილი', 'Type ID digits or part of a name');
  let tone: '' | 'ok' | 'error' = '';
  if (info?.picked && info.id === raw) {
    hint = (info.name ?? info.id) + (info.lastSells ? t('. ვალუტები ბოლო მოთხოვნიდანაა.', '. Currencies are from the last request.') : '');
    tone = 'ok';
  } else if (info?.valid && info.name) {
    hint = info.name; tone = 'ok';
  } else if (info?.valid && info.known) {
    hint = t('ამ კლიენტს სახელი არ აქვს. დაამატეთ.', 'This client has no name. Add one.');
  } else if (info?.valid) {
    hint = t('ახალი კლიენტი. დაამატეთ სახელი.', 'New client. Add a name.');
  } else if (digits && raw.length > 11) {
    hint = t('ზედმეტი ციფრია: კომპანიას 9 აქვს, ფიზიკურ პირს 11', 'Too many digits: a company has 9, a person has 11'); tone = 'error';
  } else if (tried && !raw) {
    hint = t('შეიყვანეთ კლიენტის ID ან სახელი', 'Enter a client ID or name'); tone = 'error';
  } else if (tried && !digits) {
    hint = t('აირჩიეთ კლიენტი სიიდან, ან აკრიფეთ სრული ID', 'Pick a client from the list, or type the full ID'); tone = 'error';
  } else if (tried && !info?.valid) {
    hint = t('შეამოწმეთ ID: კომპანიას 9 ციფრი აქვს, ფიზიკურ პირს 11', 'Check the ID: a company has 9 digits, a person has 11'); tone = 'error';
  }

  return (
    <div className="field combo">
      <label htmlFor="client-field">{t('კლიენტის ID ან სახელი', 'Client ID or name')}</label>
      <input
        id="client-field"
        className={'input' + (big ? ' big' : '') + (tone === 'error' ? ' invalid' : '')}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls="client-list"
        aria-activedescendant={showList && matches.length ? 'client-opt-' + active : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={t('დაიწყეთ აკრეფა', 'Start typing')}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter' && showList && matches[active]) { e.preventDefault(); pick(matches[active]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      <span className={'hint ' + tone}>{hint}</span>
      {showList && (
        <div id="client-list" role="listbox" aria-label={t('კომპანიები', 'Companies')} className="combo-list">
          <div className="head">{raw ? t('კომპანიები', 'Companies') : t('თქვენი ბოლო კლიენტები', 'Your recent clients')}</div>
          {matches.map((m, i) => (
            <button
              key={m.client_id}
              id={'client-opt-' + i}
              type="button"
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              className="combo-option"
              onMouseDown={(e) => { e.preventDefault(); pick(m); }}
            >
              <span style={{ minWidth: 0 }}>
                <span className="strong" style={{ display: 'block' }}>{m.name ?? t('სახელი არ არის', 'No name')}</span>
                <span className="tiny muted">ID {m.client_id}, {m.kind === 'company' ? t('კომპანია', 'Company') : t('ფიზიკური პირი', 'Person')}</span>
              </span>
              {m.last_sells_currency && <span className="tiny muted">{m.last_sells_currency} → {m.last_gets_currency}</span>}
            </button>
          ))}
          {!matches.length && (
            <p className="small" style={{ margin: 0, padding: 10 }}>
              {info?.valid ? t('ახალი კომპანია. დაამატეთ სახელი და შემდეგ ჯერზე შეივსება.', 'New company. Add a name and it will fill in next time.') : digits ? t('ჯერ ვერ მოიძებნა. განაგრძეთ ID-ის აკრეფა.', 'Not found yet. Keep typing the ID.') : t('ამ სახელის კომპანია ჯერ არ არის. სრული ID აკრიფეთ ახლის დასამატებლად.', 'No company with this name yet. Type the full ID to add one.')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
