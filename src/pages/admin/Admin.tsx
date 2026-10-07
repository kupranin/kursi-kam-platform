import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../../lib/i18n';
import { supabase } from '../../lib/supabase';
import LangSwitch from '../../components/LangSwitch';
import ViewSwitch from '../../components/ViewSwitch';
import People from './People';
import RulesPanel from './RulesPanel';
import SyncPanel from './SyncPanel';
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
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 17 }}>{t('ხალხი, დათვლის წესები, მონაცემები და შეტყობინებები', 'People, counting rules, data and messages')}</p>
        </div>
        <div className="row">
          <ViewSwitch onPage />
          <LangSwitch onPage />
        </div>
      </div>
      <div>
        <nav className="page-links" aria-label={t('ამ გვერდზე', 'On this page')}>
          <a href="#people">{t('ხალხი', 'People')}</a>
          <a href="#rules">{t('დათვლის წესები', 'Counting rules')}</a>
          <a href="#sync">{t('მონაცემების სინქრონიზაცია', 'Data sync')}</a>
          <a href="#messages">{t('შეტყობინებები', 'Messages')}</a>
          <a href="#activity">{t('აქტივობა', 'Activity')}</a>
        </nav>
      </div>
      <People />
      <RulesPanel names={names} />
      <SyncPanel />
      <MessagesPanel />
      <ActivityPanel names={names} />
    </>
  );
}
