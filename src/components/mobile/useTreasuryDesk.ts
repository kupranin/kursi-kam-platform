import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../lib/i18n';
import { countPendingLosses } from '../../lib/pendingLoss';
import { useToast } from '../../lib/toast';
import { useLive } from '../../lib/useLive';
import type { QueueRow } from '../../lib/types';
import { loadClosingQueue, type ClosingDeal } from '../../lib/deferWrite';
import {
  loadActionReplies,
  loadRequestBanks,
  loadWaitingQueue,
  placeQueues,
  type TreasuryReply,
} from './treasuryLoad';

export interface TreasuryDeskData {
  waiting: QueueRow[];
  better: TreasuryReply[];
  write: TreasuryReply[];
  closing: ClosingDeal[] | null;
  banks: Record<number, string[]>;
  losses: number | null;
  loaded: boolean;
  repliesReady: boolean;
  queueError: string;
  replyError: string;
  lossError: string;
}

const EMPTY: TreasuryDeskData = {
  waiting: [],
  better: [],
  write: [],
  closing: null,
  banks: {},
  losses: null,
  loaded: false,
  repliesReady: false,
  queueError: '',
  replyError: '',
  lossError: '',
};

function queueSig(rows: QueueRow[]): string {
  return rows.map((row) => [row.request_id, row.asked_at, row.amount, row.gets_amount, row.note, row.client_rate, row.client_name].join('\u001f')).join('\u001e');
}

function replySig(rows: TreasuryReply[]): string {
  return rows.map((row) => [row.request_id, row.client_reply, row.rate, row.wanted_rate, row.approved_rate, row.client_replied_at].join('\u001f')).join('\u001e');
}

export function useTreasuryDesk(enabled = true): TreasuryDeskData & { reload: () => Promise<void> } {
  const { t } = useI18n();
  const toast = useToast();
  const [data, setData] = useState<TreasuryDeskData>(EMPTY);
  const dataRef = useRef(data);
  dataRef.current = data;
  const seen = useRef<Map<number, number>>(new Map());
  const initial = useRef(true);
  const queueTicket = useRef(0);
  const replyTicket = useRef(0);
  const lossTicket = useRef(0);
  const bankTicket = useRef(0);
  const queueSigRef = useRef<string | null>(null);
  const replyIds = useRef<number[]>([]);
  const tRef = useRef(t);
  tRef.current = t;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const queueErrorRef = useRef('');

  const publishBanks = useCallback(async (ids: number[]) => {
    const mine = ++bankTicket.current;
    try {
      const next = await loadRequestBanks(ids);
      if (mine !== bankTicket.current) return;
      setData((current) => {
        const same = JSON.stringify(current.banks) === JSON.stringify(next);
        return same ? current : { ...current, banks: next };
      });
    } catch {
      /* the names stay; the banks can arrive on the next check */
    }
  }, []);

  const pullQueue = useCallback(async () => {
    const mine = ++queueTicket.current;
    try {
      const rows = await loadWaitingQueue();
      if (mine !== queueTicket.current) return;
      const sig = queueSig(rows);
      const changed = sig !== queueSigRef.current;
      queueSigRef.current = sig;
      const now = Date.now();
      const fresh: QueueRow[] = [];
      for (const row of rows) {
        if (!seen.current.has(row.request_id)) {
          seen.current.set(row.request_id, initial.current ? 0 : now);
          if (!initial.current) fresh.push(row);
        }
      }
      initial.current = false;
      if (fresh.length) {
        const say = tRef.current;
        toastRef.current(fresh.length === 1
          ? say('ახალი მოთხოვნა {name}-ისგან: {client}', 'New request from {name}: {client}', { name: fresh[0].kam_name, client: fresh[0].client_name ?? fresh[0].client_id })
          : say('{n} ახალი მოთხოვნა', '{n} new requests', { n: fresh.length }));
      }
      queueErrorRef.current = '';
      setData((current) => {
        const placed = placeQueues(rows, current.better, current.write);
        const nextWaiting = queueSig(placed.waiting) === queueSig(current.waiting) ? current.waiting : placed.waiting;
        if (nextWaiting === current.waiting && current.queueError === '' && current.loaded) return current;
        return { ...current, waiting: nextWaiting, queueError: '', loaded: true };
      });
      if (changed) {
        const ids = [...new Set([...rows.map((row) => row.request_id), ...replyIds.current])];
        void publishBanks(ids);
      }
    } catch (err) {
      if (mine !== queueTicket.current) return;
      const message = (err as Error).message;
      if (message && message !== queueErrorRef.current) {
        queueErrorRef.current = message;
        toastRef.current(message, 'error');
      }
      setData((current) => (current.queueError === message && current.loaded
        ? current
        : { ...current, queueError: message, loaded: true }));
    }
  }, [publishBanks]);

  const pullReplies = useCallback(async () => {
    const mine = ++replyTicket.current;
    try {
      const next = await loadActionReplies();
      if (mine !== replyTicket.current) return;
      replyIds.current = [...next.better, ...next.write].map((row) => row.request_id);
      setData((current) => {
        const placed = placeQueues(current.waiting, next.better, next.write);
        const better = replySig(placed.better) === replySig(current.better) ? current.better : placed.better;
        const write = replySig(placed.write) === replySig(current.write) ? current.write : placed.write;
        const waiting = queueSig(placed.waiting) === queueSig(current.waiting) ? current.waiting : placed.waiting;
        if (better === current.better && write === current.write && waiting === current.waiting && current.replyError === '' && current.repliesReady) return current;
        return { ...current, waiting, better, write, replyError: '', repliesReady: true };
      });
      const ids = [...new Set([...dataRef.current.waiting.map((row) => row.request_id), ...replyIds.current])];
      void publishBanks(ids);
    } catch {
      if (mine !== replyTicket.current) return;
      const message = tRef.current('სია ჯერ არ იტვირთება.', 'This list is not loading yet.');
      setData((current) => (current.replyError === message && current.repliesReady ? current : { ...current, replyError: message, repliesReady: true }));
    }
  }, [publishBanks]);

  const pullLosses = useCallback(async () => {
    const mine = ++lossTicket.current;
    try {
      const count = await countPendingLosses();
      if (mine !== lossTicket.current) return;
      setData((current) => (current.losses === count && current.lossError === ''
        ? current
        : { ...current, losses: count, lossError: '' }));
    } catch {
      if (mine !== lossTicket.current) return;
      const message = tRef.current('სია ჯერ არ იტვირთება.', 'This list is not loading yet.');
      setData((current) => (current.lossError === message ? current : { ...current, lossError: message }));
    }
  }, []);

  const pullClosing = useCallback(async () => {
    try {
      const rows = await loadClosingQueue();
      setData((current) => {
        if (rows == null) return current.closing == null ? current : { ...current, closing: null };
        const same = JSON.stringify(current.closing) === JSON.stringify(rows);
        return same ? current : { ...current, closing: rows };
      });
    } catch (err) {
      toastRef.current((err as Error).message, 'error');
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([pullQueue(), pullReplies(), pullLosses(), pullClosing()]);
  }, [pullQueue, pullReplies, pullLosses, pullClosing]);

  useEffect(() => {
    if (!enabled) return;
    void refreshAll();
  }, [enabled, refreshAll]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => { void pullQueue(); }, 3000);
    return () => window.clearInterval(timer);
  }, [enabled, pullQueue]);

  useLive(enabled ? ['requests'] : [], () => {
    if (!enabled) return;
    void pullReplies();
    void pullLosses();
    void pullClosing();
  }, 15000, { realtime: enabled });

  return { ...data, reload: refreshAll };
}
