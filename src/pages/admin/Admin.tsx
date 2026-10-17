import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useI18n } from '../../lib/i18n';
import { supabase } from '../../lib/supabase';
import LangSwitch from '../../components/LangSwitch';
import ViewSwitch from '../../components/ViewSwitch';
import AbsGelPanel from './AbsGelPanel';
import People from './People';
import RulesPanel from './RulesPanel';
import MessagesPanel from './MessagesPanel';
import ActivityPanel from './ActivityPanel';

export type Names = Record<string, string>;

export default function Admin() {
  const { t } = useI18n();
  const location = useLocation();
  const [names, setNames] = useState<Names>({});

  useEffect(() => {
    supabase.from('profiles').select('id, full_name').then(({ data }) => {
      const map: Names = {};
      (data ?? []).forEach((p: { id: string; full_name: string }) => { map[p.id] = p.full_name; });
      setNames(map);
    });
  }, []);

  useEffect(() => {
    if (location.hash) {
      const el = document.getElementById(location.hash.slice(1));
      if (el) window.setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
    }
  }, [location.hash]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('ადმინი', 'Admin')}</h1>
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 17 }}>{t('ლარის რიგი, ხალხი, დათვლის წესები და შეტყობინებები', 'Lari queue, people, counting rules and messages')}</p>
        </div>
        <div className="row">
          <ViewSwitch onPage />
          <LangSwitch onPage />
        </div>
      </div>
      <div>
        <nav className="page-links" aria-label={t('ამ გვერდზე', 'On this page')}>
          <Link to="/analytics#kam-portfolios">{t('KAM-ების პორტფელი', 'KAM portfolios')}</Link>
          <a href="#abs-gel">{t('ABS GEL', 'ABS GEL')}</a>
          <a href="#people">{t('ხალხი', 'People')}</a>
          <a href="#rules">{t('დათვლის წესები', 'Counting rules')}</a>
          <a href="#messages">{t('შეტყობინებები', 'Messages')}</a>
          <a href="#activity">{t('აქტივობა', 'Activity')}</a>
        </nav>
      </div>
      <AbsGelPanel />
      <People />
      <RulesPanel names={names} />
      <MessagesPanel />
      <ActivityPanel names={names} />
    </>
  );
}
