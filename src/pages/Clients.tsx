import { Fragment, useEffect, useState } from 'react';
import SpecialRateMark from '../components/SpecialRateMark';
import { useSpecialRates } from '../lib/specialRates';
import { rpc } from '../lib/supabase';
import { useI18n } from '../lib/i18n';
import { useViewAs } from '../lib/viewAs';
import { fmtDay } from '../lib/format';
import { normalizeClientId, ownerDisplayText } from '../lib/clientOwnership';
import { loadAssignedOwnerNames, loadEffectiveOwners, type AssignedOwnerName, type OwnerLoad } from '../lib/clientOwners';
import type { ClientMatch } from '../lib/types';
import LoadingLine from '../components/LoadingLine';
import ClientBrief from '../components/ClientBrief';

const COLUMNS = 6;

export default function Clients() {
  const { role } = useViewAs();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<ClientMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [openClient, setOpenClient] = useState<string | null>(null);
  const [summaryId, setSummaryId] = useState<string | null>(null);
  const [ownerLoad, setOwnerLoad] = useState<OwnerLoad | null>(null);
  const [assignedNames, setAssignedNames] = useState<Map<string, AssignedOwnerName>>(new Map());
  const specialRates = useSpecialRates(rows.map((row) => row.client_id));

  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        const list = await rpc<ClientMatch[]>('search_my_clients', { p_query: q.trim(), p_limit: 20 });
        if (alive) setRows(list ?? []);
      } finally {
        if (alive) setLoading(false);
      }
    }, 200);
    return () => { alive = false; window.clearTimeout(t); };
  }, [q]);

  const ownerIds = rows.map((row) => row.client_id).join('\n');
  useEffect(() => {
    const ids = ownerIds ? ownerIds.split('\n') : [];
    if (!ids.length) {
      setOwnerLoad({ status: 'ok', owners: new Map() });
      setAssignedNames(new Map());
      return;
    }
    let alive = true;
    setOwnerLoad(null);
    setAssignedNames(new Map());
    loadEffectiveOwners(ids)
      .then(async (result) => {
        if (!alive) return;
        setOwnerLoad(result);
        if (result.status !== 'missing') return;
        const names = await loadAssignedOwnerNames(ids);
        if (alive) setAssignedNames(names);
      })
      .catch(() => {
        if (alive) setOwnerLoad({ status: 'failed' });
      });
    return () => { alive = false; };
  }, [ownerIds]);

  const { t, lang } = useI18n();
  const mine = role === 'kam';

  function ownerText(clientId: string): string {
    if (!ownerLoad) return '';
    if (ownerLoad.status === 'failed') return ownerDisplayText('missing', null, lang);
    if (ownerLoad.status === 'missing') {
      const assigned = assignedNames.get(clientId);
      if (!assigned) return '';
      return ownerDisplayText(assigned.state, assigned.name, lang);
    }
    const owner = ownerLoad.owners.get(clientId) ?? ownerLoad.owners.get(normalizeClientId(clientId));
    if (!owner) return ownerDisplayText('unresolved', null, lang);
    return ownerDisplayText(owner.state, owner.ownerName, lang);
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{mine ? t('ჩემი კლიენტები', 'My clients') : t('კლიენტები', 'Clients')}</h1>
          <p>{mine ? t('ცარიელი სია თქვენი კლიენტებია. აკრეფილი ID ან სახელი ნებისმიერ კლიენტს პოულობს. შეჯამების წაკითხვა შეიძლება. სხვისი მოთხოვნის შეცვლა არა.', 'An empty list is your clients. A typed ID or name finds any client. You can read the summary. You cannot change another KAM\'s request.') : t('ყველა კლიენტი, ბოლო მოთხოვნიდან', 'Every client, from the latest request')}</p>
        </div>
      </div>
      <div className="field" style={{ maxWidth: 420 }}>
        <label htmlFor="client-search">{t('ძებნა ID-ით ან სახელით', 'Search by ID or name')}</label>
        <input id="client-search" className="input" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('დაიწყეთ აკრეფა', 'Start typing')} />
      </div>
      <section className="card flush" aria-label={t('კლიენტები', 'Clients')} style={{ paddingTop: 8 }}>
        {loading && <LoadingLine />}
        {!loading && !rows.length && <p className="empty">{q ? t('ვერ მოიძებნა.', 'Nothing found.') : t('კლიენტები ჯერ არ არის.', 'No clients yet.')}</p>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 820 }}>
              <thead><tr><th>{t('კლიენტი', 'Client')}</th><th>ID</th><th>{t('ტიპი', 'Type')}</th><th>{t('კლიენტის მფლობელი', 'Client owner')}</th><th>{t('ბოლო მოთხოვნა', 'Last request')}</th><th>{t('ბოლო მიმართულება', 'Last direction')}</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const terms = specialRates.get(r.client_id) ?? [];
                  const open = openClient === r.client_id;
                  return (
                  <Fragment key={r.client_id}>
                  <tr>
                    <td className="strong">
                      <div>{r.name ?? <span className="muted">{t('სახელი არ არის', 'No name')}</span>}</div>
                      {terms.length > 0 && (
                        <button type="button" className="link" aria-expanded={open} onClick={() => setOpenClient(open ? null : r.client_id)}>
                          {t('სპეც. კურსი', 'Special rate')}
                        </button>
                      )}
                      <button type="button" className="link" style={{ marginLeft: 8 }} aria-expanded={summaryId === r.client_id} onClick={() => setSummaryId(summaryId === r.client_id ? null : r.client_id)}>
                        {t('შეჯამება', 'Summary')}
                      </button>
                    </td>
                    <td>{r.client_id}</td>
                    <td>{r.kind === 'company' ? t('კომპანია', 'Company') : t('ფიზიკური პირი', 'Person')}</td>
                    <td>{ownerText(r.client_id)}</td>
                    <td>{r.last_request_date ? fmtDay(r.last_request_date) : ''}</td>
                    <td>{r.last_sells_currency ? `${r.last_sells_currency} → ${r.last_gets_currency}` : ''}</td>
                  </tr>
                  {open && terms.length > 0 && (
                    <tr>
                      <td colSpan={COLUMNS}>
                        <SpecialRateMark clientId={r.client_id} rows={terms} variant="detail" />
                      </td>
                    </tr>
                  )}
                  {summaryId === r.client_id && (
                    <tr>
                      <td colSpan={COLUMNS}>
                        <ClientBrief clientId={r.client_id} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {rows.length === 20 && <p className="small muted" style={{ margin: 0 }}>{t('ნაჩვენებია პირველი 20. უფრო ზუსტად აკრიფეთ.', 'Showing the first 20. Type more to narrow it.')}</p>}
    </>
  );
}
