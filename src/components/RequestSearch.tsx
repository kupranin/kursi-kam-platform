import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { describeDeal, fmtDateTime, fmtWhole } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { isHistoricalRequest } from '../lib/displayClass';
import {
  currencyPairOptions,
  searchPair,
  searchStatusOf,
  type SearchDates,
  type SearchStatus,
} from '../lib/requestSearch';
import { useRequestSearch } from '../lib/useRequestSearch';
import { isWrittenHistory } from '../lib/requestStatus';
import { useViewAs } from '../lib/viewAs';
import type { RequestRow } from '../lib/types';
import CorrectStatusButton from './CorrectStatusButton';
import DeleteRequestButton, { canDeleteRequest } from './DeleteRequestButton';
import LoadingLine from './LoadingLine';
import LossApproval from './LossApproval';
import RequestOutcomeButtons from './RequestOutcomeButtons';
import KamEditForm from './mobile/KamEditForm';
import RequestKamLine from './RequestKamLine';
import { loadKamRequest } from './mobile/kamLoad';

type T = (ka: string, en: string, vars?: Record<string, string | number>) => string;

const STATUS_ORDER: Exclude<SearchStatus, 'all'>[] = ['waiting', 'quoted', 'better', 'accepted', 'completed', 'lost'];

function resultLabel(row: RequestRow, t: T): string {
  const code = searchStatusOf(row);
  if (isHistoricalRequest(row)) {
    return code === 'completed' ? t('მოგებული', 'Won') : t('დაკარგული', 'Lost');
  }
  return statusLabel(code, t);
}

function statusLabel(code: Exclude<SearchStatus, 'all'>, t: T): string {
  if (code === 'waiting') return t('ელოდება', 'Waiting');
  if (code === 'quoted') return t('კურსი გაცემულია', 'Quoted');
  if (code === 'better') return t('უკეთესი კურსი', 'Better rate');
  if (code === 'accepted') return t('დადასტურებული', 'Accepted');
  if (code === 'completed') return t('დასრულებული', 'Completed');
  return t('დაიკარგა', 'Lost');
}

function statusClass(code: Exclude<SearchStatus, 'all'>): string {
  if (code === 'completed') return 'pill-ok';
  if (code === 'lost') return 'pill-alert';
  if (code === 'quoted' || code === 'accepted') return 'pill-warn';
  return 'pill-wait';
}

function SearchControls({
  text,
  setText,
  status,
  setStatus,
  dates,
  setDates,
  pair,
  setPair,
  t,
  compact = false,
}: {
  text: string;
  setText: (value: string) => void;
  status: SearchStatus;
  setStatus: (value: SearchStatus) => void;
  dates: SearchDates;
  setDates: (value: SearchDates) => void;
  pair: string;
  setPair: (value: string) => void;
  t: T;
  compact?: boolean;
}) {
  const placeholder = t('მოძებნე კლიენტი, ID ან მოთხოვნა', 'Search for a client, an ID, or a request');
  return (
    <form className="req-search" role="search" onSubmit={(e) => e.preventDefault()}>
      <label className="field">
        <span className="sr-only">{placeholder}</span>
        <input
          id="kam-request-search"
          className={compact ? 'input' : 'input big'}
          type="search"
          name="q"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 80))}
        />
      </label>
      <div className="req-search-filters">
        <label className="field">
          <span>{t('თარიღი', 'Date')}</span>
          <select className="select" value={dates} onChange={(e) => setDates(e.target.value === 'all' ? 'all' : '30')}>
            <option value="30">{t('ბოლო 30 დღე', 'Last 30 days')}</option>
            <option value="all">{t('ყველა თარიღი', 'All dates')}</option>
          </select>
        </label>
        <label className="field">
          <span>{t('სტატუსი', 'Status')}</span>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value as SearchStatus)}>
            <option value="all">{t('ყველა სტატუსი', 'All statuses')}</option>
            {STATUS_ORDER.map((code) => <option key={code} value={code}>{statusLabel(code, t)}</option>)}
          </select>
        </label>
        <label className="field">
          <span>{t('ვალუტის წყვილი', 'Currency pair')}</span>
          <select className="select" value={pair} onChange={(e) => setPair(e.target.value)}>
            <option value="all">{t('ყველა წყვილი', 'All pairs')}</option>
            {currencyPairOptions().map((code) => <option key={code} value={code}>{code.replace('/', ' / ')}</option>)}
          </select>
        </label>
      </div>
    </form>
  );
}

function SearchDetail({
  id,
  seed,
  onPatch,
  onRemove,
}: {
  id: number;
  seed: RequestRow;
  onPatch: (row: RequestRow) => void;
  onRemove: (id: number) => void;
}) {
  const { t } = useI18n();
  const { profile } = useAuth();
  const { realRole } = useViewAs();
  const [row, setRow] = useState<RequestRow | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);

  async function reload(keepEdit = false) {
    const next = await loadKamRequest(id);
    if (!next) {
      setFailed(true);
      return;
    }
    setRow(next);
    setFailed(false);
    onPatch(next);
    setEditing(keepEdit);
  }

  useEffect(() => {
    let gone = false;
    loadKamRequest(id).then((next) => {
      if (gone) return;
      setRow(next);
      setFailed(!next);
      if (next) onPatch(next);
    }).catch(() => {
      if (!gone) setFailed(true);
    });
    return () => { gone = true; };
  }, [id]);

  const shown = row ?? seed;
  const own = canDeleteRequest(realRole, profile?.id, shown.kam_id);
  const ready = row != null || failed;

  return (
    <div className="req-search-detail">
      {shown.note
        ? <p className="note-box">{t('კომენტარი', 'Comment')}: {shown.note}</p>
        : <p className="small muted">{t('კომენტარი ჯერ არ არის.', 'No comment yet.')}</p>}
      {!ready && <LoadingLine compact />}
      {ready && !editing && (
        <div className="actions">
          <RequestOutcomeButtons row={shown} onDone={() => { void reload(false); }} />
          <CorrectStatusButton row={shown} onDone={() => { void reload(true); }} />
          {own && <button type="button" className="btn" onClick={() => setEditing(true)}>{t('რედაქტირება', 'Edit')}</button>}
          {own && !isWrittenHistory(shown) && <DeleteRequestButton requestId={shown.id} onDeleted={() => onRemove(shown.id)} />}
        </div>
      )}
      {ready && editing && (
        <KamEditForm
          row={shown}
          onClose={() => setEditing(false)}
          onSaved={() => { void reload(false); }}
          onDeleted={() => onRemove(shown.id)}
        />
      )}
      <LossApproval row={shown} onDone={() => { void reload(false); }} />
    </div>
  );
}

function ResultBody({ row, t }: { row: RequestRow; t: T }) {
  const code = searchStatusOf(row);
  const pair = searchPair(row);
  return (
    <>
      <div className="when">
        <div className="strong">{fmtDateTime(row.requested_at)}</div>
      </div>
      <div className="who">
        <div className="name">{row.client_name || row.client_id}</div>
        <div className="tiny muted">ID {row.client_id}</div>
        <RequestKamLine ownerName={row.owner_name} ownerState={row.owner_state} ownerSource={row.owner_source} requestKam={row.kam_name} />
        <div className="tiny muted">{t('მოთხოვნა', 'Request')} #{row.id}</div>
      </div>
      <div className="what">
        {pair && <div>{pair}</div>}
        <div>{describeDeal(row.sells_currency, row.amount, row.gets_currency, row.gets_amount)}</div>
        {row.legacy_status?.trim() && <div className="tiny muted">{t('ფაილის სტატუსი', 'File status')}: {row.legacy_status}</div>}
      </div>
      <span className={'pill ' + statusClass(code)}>{resultLabel(row, t)}</span>
    </>
  );
}

function DeskRequestSearch() {
  const { t } = useI18n();
  const { profile } = useAuth();
  const { role } = useViewAs();
  const kamId = role === 'kam' ? profile?.id : undefined;
  const search = useRequestSearch(kamId);
  const [openId, setOpenId] = useState<number | null>(null);
  if (role !== 'kam' || !profile) return null;

  return (
    <section className="card flush" aria-labelledby="request-search-title">
      <div className="card-head">
        <h2 id="request-search-title" style={{ fontSize: 22 }}>{t('ძებნა', 'Search')}</h2>
      </div>
      <div style={{ padding: '0 24px 12px' }}>
        <SearchControls t={t} {...search} />
      </div>
      {search.error && <p className="alert-box" role="alert">{search.error}</p>}
      {search.engaged && search.loading && search.rows.length === 0 && <LoadingLine />}
      {search.engaged && search.loaded && !search.loading && !search.error && search.rows.length === 0 && (
        <p className="empty">{t('არაფერი მოიძებნა.', 'Nothing found.')}</p>
      )}
      {search.rows.map((row) => {
        const open = openId === row.id;
        return (
          <div key={row.id}>
            <button
              type="button"
              className={'list-row' + (open ? ' highlight' : '')}
              style={{ width: '100%', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' }}
              aria-expanded={open}
              onClick={() => setOpenId(row.id)}
            >
              <ResultBody row={row} t={t} />
            </button>
            {open && (
              <div style={{ padding: '0 24px 16px' }}>
                <SearchDetail
                  id={row.id}
                  seed={row}
                  onPatch={search.patchRow}
                  onRemove={(id) => { search.removeRow(id); setOpenId(null); }}
                />
              </div>
            )}
          </div>
        );
      })}
      {search.engaged && search.rows.length > 0 && search.rows.length < search.total && (
        <p className="empty">
          <button type="button" className="btn" disabled={search.loading} onClick={() => { void search.more(); }}>
            {t('მეტის ჩვენება', 'Show more')}
          </button>
          <span className="small muted" style={{ marginLeft: 12 }}>
            {t('{shown} {total}-დან', '{shown} of {total}', { shown: fmtWhole(search.rows.length), total: fmtWhole(search.total) })}
          </span>
        </p>
      )}
      {search.loading && search.rows.length > 0 && <LoadingLine compact />}
    </section>
  );
}

function PhoneRequestSearch() {
  const { t } = useI18n();
  const { profile } = useAuth();
  const { role } = useViewAs();
  const navigate = useNavigate();
  const { search: query } = useLocation();
  const kamId = role === 'kam' ? profile?.id : undefined;
  const search = useRequestSearch(kamId);
  if (role !== 'kam' || !profile) return null;

  return (
    <div className="req-search-phone">
      <SearchControls t={t} compact {...search} />
      {search.error && <p className="alert-box" role="alert">{search.error}</p>}
      {search.engaged && search.loading && search.rows.length === 0 && <LoadingLine />}
      {search.engaged && search.loaded && !search.loading && !search.error && search.rows.length === 0 && (
        <p className="m-quiet">{t('არაფერი მოიძებნა.', 'Nothing found.')}</p>
      )}
      {search.rows.map((row) => {
        const code = searchStatusOf(row);
        const pair = searchPair(row);
        return (
          <article key={row.id} className="m-card is-compact">
            <button
              type="button"
              className="m-card-hit"
              onClick={() => navigate({ pathname: '/requests/' + row.id, search: query })}
            >
              <div className="m-card-top">
                <div className="m-card-client">{row.client_name || row.client_id}</div>
                <span className={'pill ' + statusClass(code)}>{resultLabel(row, t)}</span>
              </div>
              <div className="tiny muted">ID {row.client_id}</div>
              <RequestKamLine ownerName={row.owner_name} ownerState={row.owner_state} ownerSource={row.owner_source} requestKam={row.kam_name} />
              <div className="tiny muted">{t('მოთხოვნა', 'Request')} #{row.id}</div>
              <div className="m-card-time">{fmtDateTime(row.requested_at)}</div>
              {pair && <div className="m-card-pair">{pair}</div>}
              <div>{describeDeal(row.sells_currency, row.amount, row.gets_currency, row.gets_amount)}</div>
            </button>
          </article>
        );
      })}
      {search.engaged && search.rows.length > 0 && search.rows.length < search.total && (
        <button type="button" className="btn m-send" disabled={search.loading} onClick={() => { void search.more(); }}>
          {t('მეტის ჩვენება', 'Show more')}
        </button>
      )}
      {search.loading && search.rows.length > 0 && <LoadingLine compact />}
    </div>
  );
}

export default function RequestSearch({ variant = 'desk' }: { variant?: 'desk' | 'phone' }) {
  if (variant === 'phone') return <PhoneRequestSearch />;
  return <DeskRequestSearch />;
}
