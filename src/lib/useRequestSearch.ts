import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { todayTbilisi } from './format';
import {
  readSearchState,
  searchEngaged,
  searchNeedle,
  writeSearchParams,
  type SearchDates,
  type SearchStatus,
} from './requestSearch';
import { searchKamRequests } from './requestSearchQuery';
import type { RequestRow } from './types';

/** Debounced text, server page of 25, and the address so a detail screen can come back. */
export function useRequestSearch(kamId: string | undefined) {
  const [params, setParams] = useSearchParams();
  const initial = useRef(readSearchState(params)).current;
  const [text, setText] = useState(initial.text);
  const [status, setStatus] = useState<SearchStatus>(initial.status);
  const [dates, setDates] = useState<SearchDates>(initial.dates);
  const [pair, setPair] = useState(initial.pair);
  const [needle, setNeedle] = useState(() => searchNeedle(initial.text));
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const ticket = useRef(0);
  const busy = useRef(false);
  const paramsRef = useRef(params);
  const rowsRef = useRef(rows);
  paramsRef.current = params;
  rowsRef.current = rows;

  useEffect(() => {
    const id = window.setTimeout(() => setNeedle(searchNeedle(text)), 300);
    return () => window.clearTimeout(id);
  }, [text]);

  useEffect(() => {
    const next = writeSearchParams(paramsRef.current, { text, status, dates, pair });
    if (next.toString() === paramsRef.current.toString()) return;
    setParams(next, { replace: true });
  }, [text, status, dates, pair, setParams]);

  const engaged = searchEngaged({ text: needle, status, dates, pair });

  useEffect(() => {
    const mine = ++ticket.current;
    if (!kamId || !engaged) {
      busy.current = false;
      setRows([]);
      setTotal(0);
      setLoading(false);
      setLoaded(false);
      setError('');
      return;
    }
    busy.current = true;
    setLoading(true);
    setError('');
    setRows([]);
    setLoaded(false);
    searchKamRequests({
      kamId,
      text: needle,
      status,
      dates,
      pair,
      offset: 0,
      today: todayTbilisi(),
    }).then((page) => {
      if (mine !== ticket.current) return;
      busy.current = false;
      setRows(page.rows);
      setTotal(page.total);
      setLoaded(true);
      setLoading(false);
    }).catch((err: unknown) => {
      if (mine !== ticket.current) return;
      busy.current = false;
      setRows([]);
      setTotal(0);
      setError(err instanceof Error ? err.message : '');
      setLoaded(true);
      setLoading(false);
    });
  }, [kamId, needle, status, dates, pair, engaged]);

  async function more() {
    if (!kamId || busy.current || rowsRef.current.length >= total) return;
    const offset = rowsRef.current.length;
    const mine = ++ticket.current;
    busy.current = true;
    setLoading(true);
    try {
      const page = await searchKamRequests({
        kamId,
        text: needle,
        status,
        dates,
        pair,
        offset,
        today: todayTbilisi(),
      });
      if (mine !== ticket.current) return;
      setRows((prev) => {
        const seen = new Set(prev.map((row) => row.id));
        return [...prev, ...page.rows.filter((row) => !seen.has(row.id))];
      });
      setTotal(page.total);
      setError('');
      setLoaded(true);
      setLoading(false);
      busy.current = false;
    } catch (err: unknown) {
      if (mine !== ticket.current) return;
      setError(err instanceof Error ? err.message : '');
      setLoading(false);
      busy.current = false;
    }
  }

  function patchRow(next: RequestRow) {
    setRows((prev) => prev.map((row) => (row.id === next.id ? { ...row, ...next } : row)));
  }

  function removeRow(id: number) {
    setRows((prev) => prev.filter((row) => row.id !== id));
    setTotal((count) => Math.max(0, count - 1));
  }

  return {
    text,
    setText,
    status,
    setStatus,
    dates,
    setDates,
    pair,
    setPair,
    rows,
    total,
    loading,
    loaded,
    error,
    engaged,
    more,
    patchRow,
    removeRow,
  };
}
