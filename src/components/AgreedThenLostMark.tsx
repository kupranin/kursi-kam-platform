import { useEffect, useState } from 'react';
import {
  agreedLostNote,
  EMPTY_AGREED_LOST,
  type AgreedThenLostMark,
} from '../lib/agreedThenLost';
import { fmtDateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { supabase } from '../lib/supabase';

const inflight = new Map<string, Promise<AgreedThenLostMark>>();

function clientIdOk(clientId: string): boolean {
  return /^([0-9]{9}|[0-9]{11})$/.test(clientId);
}

function idsOf(value: unknown): number[] {
  if (Array.isArray(value)) return value.map((item) => Number(item)).filter((n) => Number.isFinite(n));
  if (typeof value === 'string' && value.trim()) {
    return value.replace(/[{}]/g, '').split(',').map((part) => Number(part.trim())).filter((n) => Number.isFinite(n));
  }
  return [];
}

function asMark(raw: Record<string, unknown> | null): AgreedThenLostMark {
  if (!raw) return EMPTY_AGREED_LOST;
  const requestIds = idsOf(raw.request_ids);
  const count = Number(raw.loss_count);
  const latestId = raw.latest_request_id == null || raw.latest_request_id === '' ? null : Number(raw.latest_request_id);
  return {
    count: Number.isFinite(count) ? count : requestIds.length,
    latestAt: raw.latest_at ? String(raw.latest_at) : null,
    latestRequestId: latestId != null && Number.isFinite(latestId) ? latestId : (requestIds[0] ?? null),
    requestIds,
  };
}

export function loadAgreedThenLost(clientId: string): Promise<AgreedThenLostMark> {
  const pending = inflight.get(clientId);
  if (pending) return pending;
  const run = (async () => {
    const { data, error } = await supabase.rpc('client_agreed_then_lost', { p_client_id: clientId });
    if (error || data == null) return EMPTY_AGREED_LOST;
    const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : (data as Record<string, unknown>);
    return asMark(row ?? null);
  })();
  inflight.set(clientId, run);
  void run.finally(() => {
    if (inflight.get(clientId) === run) inflight.delete(clientId);
  });
  return run;
}

export function useAgreedThenLost(clientId: string | null | undefined): AgreedThenLostMark {
  const [mark, setMark] = useState<AgreedThenLostMark>(EMPTY_AGREED_LOST);
  useEffect(() => {
    const id = clientId?.trim() ?? '';
    if (!clientIdOk(id)) {
      setMark(EMPTY_AGREED_LOST);
      return;
    }
    let live = true;
    loadAgreedThenLost(id)
      .then((value) => { if (live) setMark(value); })
      .catch(() => { if (live) setMark(EMPTY_AGREED_LOST); });
    return () => { live = false; };
  }, [clientId]);
  return mark;
}

/** Short red label. One loss can add its time. Several add the count. */
export function AgreedThenLostLine({ count = 1, when }: { count?: number; when?: string | null }) {
  const { t } = useI18n();
  const label = t('კლიენტი დაეთანხმა და მერე დაიკარგა', 'Client agreed, then lost');
  const extra = count > 1 ? ` · ${count}` : when ? ` · ${fmtDateTime(when)}` : '';
  return <div className="small agreed-then-lost">{label}{extra}</div>;
}

/** Red note for KAMs and treasury. Hidden until setup 56 is pasted, and it does not block a new request. */
export default function ClientAgreedThenLost({
  clientId,
  excludeId,
}: {
  clientId: string | null | undefined;
  excludeId?: number | null;
}) {
  const mark = useAgreedThenLost(clientId);
  const note = agreedLostNote(mark, excludeId);
  if (!note) return null;
  return <AgreedThenLostLine count={note.count} when={note.latestAt} />;
}
