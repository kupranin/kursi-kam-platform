import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import People from './People';
import RulesPanel from './RulesPanel';
import SyncPanel from './SyncPanel';
import MessagesPanel from './MessagesPanel';
import ActivityPanel from './ActivityPanel';

export type Names = Record<string, string>;

export default function Admin() {
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
      <div>
        <h1>Admin</h1>
        <p className="muted" style={{ margin: '6px 0 14px', fontSize: 17 }}>People, counting rules, data and messages</p>
        <nav className="page-links" aria-label="On this page">
          <a href="#people">People</a>
          <a href="#rules">Counting rules</a>
          <a href="#sync">Data sync</a>
          <a href="#messages">Messages</a>
          <a href="#activity">Activity</a>
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
