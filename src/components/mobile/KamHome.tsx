import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useI18n } from '../../lib/i18n';
import type { RequestRow } from '../../lib/types';
import LoadingLine from '../LoadingLine';
import KamRequestCard from './KamRequestCard';
import { useKamDesk } from './useKamDesk';
import type { KamGroups } from './kamBuckets';

function Block({
  id,
  title,
  rows,
  empty,
  onOpen,
  compact = false,
}: {
  id?: string;
  title: string;
  rows: RequestRow[];
  empty: string;
  onOpen: (row: RequestRow) => void;
  compact?: boolean;
}) {
  const quiet = rows.length === 0;
  return (
    <section className={'m-block' + (quiet ? ' is-empty' : '') + (compact ? ' is-compact' : '')} id={id} aria-labelledby={id ? id + '-title' : undefined}>
      <h2 id={id ? id + '-title' : undefined} className="m-block-title">{title}</h2>
      {quiet && <p className="m-quiet">{empty}</p>}
      {rows.map((row) => (
        <KamRequestCard key={row.id} row={row} compact={compact} onOpen={() => onOpen(row)} />
      ))}
    </section>
  );
}

export default function KamHome({ seed }: { seed?: KamGroups }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const live = useKamDesk(seed == null);
  const data = seed ?? live;
  const loaded = seed != null || live.loaded;

  useEffect(() => {
    if (!loaded) return;
    const id = window.location.hash.replace('#', '');
    if (!id) return;
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [loaded, data.waiting.length]);

  function open(row: RequestRow) {
    navigate('/requests/' + row.id);
  }

  return (
    <div className="m-home">
      {!loaded && <LoadingLine />}
      {loaded && (
        <>
          <Block
            id="kam-action"
            title={t('ჩემი პასუხი სჭირდება', 'Needs my answer')}
            rows={data.action}
            empty={t('ახლა პასუხი არ გჭირდებათ.', 'Nothing needs your answer right now.')}
            onOpen={open}
          />
          <Block
            id="kam-waiting"
            title={t('ხაზინას ელოდება', 'Waiting on treasury')}
            rows={data.waiting}
            empty={t('ხაზინას არაფერი ელოდება.', 'Nothing is waiting on treasury.')}
            onOpen={open}
          />
          {data.active.length > 0 && (
            <Block
              id="kam-active"
              title={t('მიმდინარე', 'In progress')}
              rows={data.active}
              empty=""
              onOpen={open}
            />
          )}
          <Block
            id="kam-recent"
            title={t('ბოლო', 'Recent')}
            rows={data.recent}
            empty={t('ბოლო აქტივობა ჯერ არ არის.', 'No recent activity yet.')}
            onOpen={open}
            compact
          />
          <p className="m-earlier">
            <Link to="/requests/history" className="btn">{t('წინა მოთხოვნები', 'Earlier requests')}</Link>
          </p>
        </>
      )}
    </div>
  );
}
