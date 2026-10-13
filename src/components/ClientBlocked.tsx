import { useCallback, useEffect, useState } from 'react';
import { loadBlockedClientIds, setClientBlocked } from '../lib/clientBlocked';
import { useI18n } from '../lib/i18n';
import { useToast } from '../lib/toast';

/** Loads which of these clients are blocked. One read for the ids on the screen. */
export function useClientBlocked(clientIds: readonly string[]) {
  const toast = useToast();
  const { t } = useI18n();
  const key = [...new Set(clientIds.map((id) => id.trim()).filter(Boolean))].sort().join('\n');
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let gone = false;
    const ids = key ? key.split('\n') : [];
    if (!ids.length) {
      setBlocked(new Set());
      return;
    }
    loadBlockedClientIds(ids).then((next) => {
      if (!gone) setBlocked(next);
    });
    return () => { gone = true; };
  }, [key]);

  const toggle = useCallback(async (clientId: string, next: boolean) => {
    try {
      await setClientBlocked(clientId, next);
      setBlocked((prev) => {
        const copy = new Set(prev);
        if (next) copy.add(clientId);
        else copy.delete(clientId);
        return copy;
      });
      toast(next
        ? t('კლიენტი დაბლოკილია.', 'Client is blocked.')
        : t('კლიენტი აღარ არის დაბლოკილი.', 'The client is no longer blocked.'));
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }, [t, toast]);

  return { blocked, toggle };
}

/**
 * On a written rate, treasury or an admin can switch the client blocked flag.
 * Everyone else who can see the deal sees the on state, and cannot switch it.
 */
export default function ClientBlocked({
  clientId,
  blocked,
  written,
  canSwitch,
  onToggle,
}: {
  clientId: string;
  blocked: boolean;
  written: boolean;
  canSwitch: boolean;
  onToggle: (clientId: string, next: boolean) => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const label = t('კლიენტი დაბლოკილია', 'Client is blocked');

  if (written && canSwitch) {
    return (
      <span className="client-blocked">
        <button
          type="button"
          className={'btn' + (blocked ? ' is-on' : '')}
          aria-pressed={blocked}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try { await onToggle(clientId, !blocked); }
            finally { setBusy(false); }
          }}
        >
          {busy ? t('ინახება…', 'Saving…') : label}
        </button>
      </span>
    );
  }

  if (!blocked) return null;
  return <span className="pill pill-alert client-blocked">{label}</span>;
}
