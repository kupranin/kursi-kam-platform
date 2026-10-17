import { useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../../lib/i18n';
import type { KamGroups } from '../../lib/kamWorkspace';
import type { RequestRow } from '../../lib/types';
import LoadingLine from '../LoadingLine';
import RequestSearch from '../RequestSearch';
import KamNewRequest from './KamNewRequest';
import KamRequestCard from './KamRequestCard';
import { useKamDesk } from './useKamDesk';

function Block({
  id,
  title,
  rows,
  empty,
  onOpen,
  compact = false,
  heading = 'h2',
}: {
  id?: string;
  title: string;
  rows: RequestRow[];
  empty: string;
  onOpen: (row: RequestRow) => void;
  compact?: boolean;
  heading?: 'h2' | 'h3';
}) {
  const quiet = rows.length === 0;
  const Title = heading;
  return (
    <section className={'m-block' + (quiet ? ' is-empty' : '') + (compact ? ' is-compact' : '')} id={id} aria-labelledby={id ? id + '-title' : undefined}>
      <Title id={id ? id + '-title' : undefined} className="m-block-title">{title}</Title>
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
  const { search } = useLocation();
  const live = useKamDesk(seed == null);
  const data = seed ?? live;
  const loaded = seed != null || live.loaded;

  useEffect(() => {
    if (!loaded) return;
    const id = window.location.hash.replace('#', '');
    if (!id) return;
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [loaded, data.awaitingTreasury.length]);

  function open(row: RequestRow) {
    navigate({ pathname: '/requests/' + row.id, search });
  }

  return (
    <div className="m-home">
      <section className="m-home-new" aria-labelledby="kam-new-title">
        <h2 id="kam-new-title" className="m-block-title">{t('ახალი მოთხოვნა', 'New request')}</h2>
        <KamNewRequest embedded />
      </section>
      {!loaded && <LoadingLine />}
      {loaded && (
        <>
          <section className="m-block" id="kam-open" aria-labelledby="kam-open-title">
            <h2 id="kam-open-title" className="m-block-title">{t('ღია მოთხოვნები', 'Open requests')}</h2>
            <Block
              id="kam-action"
              heading="h3"
              title={t('კლიენტს ელოდება', 'Awaiting client')}
              rows={data.awaitingClient}
              empty={t('კლიენტის პასუხს არაფერი ელოდება.', 'Nothing is awaiting the client.')}
              onOpen={open}
            />
            <Block
              id="kam-waiting"
              heading="h3"
              title={t('ხაზინას ელოდება', 'Awaiting treasury')}
              rows={data.awaitingTreasury}
              empty={t('ხაზინას არაფერი ელოდება.', 'Nothing is waiting on treasury.')}
              onOpen={open}
            />
            <Block
              id="kam-held"
              heading="h3"
              title={t('შეჩერებული', 'Held')}
              rows={data.held}
              empty={t('შეჩერებული კურსი არ არის.', 'No rate is held.')}
              onOpen={open}
            />
            <Block
              id="kam-follow"
              heading="h3"
              title={t('დაბრუნება', 'Follow-up')}
              rows={data.followUp}
              empty={t('ბოლო 7 დღეში დასაბრუნებელი არ არის.', 'No follow-up in the last 7 days.')}
              onOpen={open}
            />
            {data.followUp.length > 0 && (
              <Link to="/follow-ups" className="btn">{t('მიზეზის ჩაწერა', 'Record the reason')}</Link>
            )}
            {data.stillOpen.length > 0 && (
              <Block
                id="kam-still"
                heading="h3"
                title={t('სხვა ღია', 'Other open')}
                rows={data.stillOpen}
                empty=""
                onOpen={open}
              />
            )}
          </section>
          <RequestSearch variant="phone" />
          <section className="m-block" id="kam-today" aria-labelledby="kam-today-title">
            <h2 id="kam-today-title" className="m-block-title">{t('დღევანდელი აქტივობა', "Today's activity")}</h2>
            <p className="m-quiet">{t('გაწერილი კურსი გადახდა არ არის.', 'A written rate is not a payment.')}</p>
            <Block
              id="kam-written"
              heading="h3"
              title={t('დღეს გაწერილი კურსი', 'Rate written today')}
              rows={data.writtenToday}
              empty={t('დღეს გაწერილი კურსი არ არის.', 'No rate was written today.')}
              onOpen={open}
              compact
            />
            <Block
              id="kam-paid"
              heading="h3"
              title={t('დღეს გავიდა', 'Went through today')}
              rows={data.paidToday}
              empty={t('დღეს გასული არ არის.', 'Nothing went through today.')}
              onOpen={open}
              compact
            />
            <Block
              id="kam-lost"
              heading="h3"
              title={t('დღეს უარი ან დაკარგული', 'Declined or lost today')}
              rows={data.lostToday}
              empty={t('დღეს უარი ან დაკარგული არ არის.', 'Nothing was declined or lost today.')}
              onOpen={open}
              compact
            />
          </section>
          <p className="m-earlier">
            <Link to="/requests/history" className="btn">{t('წინა მოთხოვნები', 'Earlier requests')}</Link>
          </p>
        </>
      )}
    </div>
  );
}
