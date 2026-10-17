import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useLive, useTick } from '../../lib/useLive';
import { loadKamDesk, type KamDeskData } from './kamLoad';

const EMPTY: KamDeskData = {
  awaitingClient: [],
  awaitingTreasury: [],
  held: [],
  followUp: [],
  stillOpen: [],
  writtenToday: [],
  paidToday: [],
  lostToday: [],
  loaded: false,
};

export function useKamDesk(enabled = true) {
  const { profile } = useAuth();
  const [data, setData] = useState<KamDeskData>(EMPTY);
  const dataRef = useRef(data);
  const ticket = useRef(0);
  dataRef.current = data;
  useTick(15000);

  const reload = useCallback(async () => {
    const mine = ++ticket.current;
    if (!enabled || !profile) {
      if (enabled) setData((prev) => ({ ...prev, loaded: true }));
      return;
    }
    try {
      const next = await loadKamDesk(profile.id, dataRef.current.loaded ? dataRef.current : null);
      if (mine !== ticket.current) return;
      dataRef.current = next;
      setData((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    } catch {
      if (mine !== ticket.current) return;
      setData((current) => ({ ...current, loaded: true }));
    }
  }, [enabled, profile]);

  useEffect(() => { void reload(); }, [reload]);
  useLive(enabled ? ['requests'] : [], () => { void reload(); }, 10000, { realtime: enabled });

  return { ...data, reload };
}
