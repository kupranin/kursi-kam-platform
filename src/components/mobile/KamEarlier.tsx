import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import type { RequestRow } from '../../lib/types';
import LoadingLine from '../LoadingLine';
import KamRequestCard from './KamRequestCard';
import { loadKamEarlier } from './kamLoad';

const PAGE = 20;

export default function KamEarlier() {
  const { profile } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [loaded, setLoaded] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!profile) return;
    let gone = false;
    setLoaded(false);
    loadKamEarlier(profile.id, limit).then((result) => {
      if (gone) return;
      setRows(result.rows);
      setDone(result.done);
      setError('');
      setLoaded(true);
    }).catch((err: Error) => {
      if (gone) return;
      setError(err.message);
      setLoaded(true);
    });
    return () => { gone = true; };
  }, [profile, limit]);

  return (
    <div className="m-home">
      <Link to="/requests" className="m-back">{t('უკან', 'Back')}</Link>
      {!loaded && <LoadingLine />}
      {error && <p className="alert-box" role="alert">{error}</p>}
      {loaded && !error && !rows.length && <p className="m-quiet">{t('წინა მოთხოვნა ჯერ არ არის.', 'No earlier requests yet.')}</p>}
      {rows.map((row) => (
        <KamRequestCard key={row.id} row={row} compact onOpen={() => navigate('/requests/' + row.id)} />
      ))}
      {loaded && !done && rows.length > 0 && (
        <p className="m-earlier">
          <button type="button" className="btn" onClick={() => setLimit((n) => n + PAGE)}>{t('მეტის ჩვენება', 'Show more')}</button>
        </p>
      )}
    </div>
  );
}
