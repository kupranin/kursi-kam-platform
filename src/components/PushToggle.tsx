import { useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { disablePush, enablePush, readPushState, type PushUi } from '../lib/push';

export default function PushToggle() {
  const { t, lang } = useI18n();
  const [state, setState] = useState<PushUi | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let gone = false;
    void readPushState().then((next) => {
      if (!gone) setState(next);
    });
    return () => { gone = true; };
  }, []);

  if (!state || state.kind === 'hidden') return null;

  async function turnOn() {
    setBusy(true);
    setError('');
    try {
      const next = await enablePush(lang);
      setState(next === 'denied' ? { kind: 'denied' } : { kind: 'on' });
    } catch (err) {
      if (err instanceof Error && err.message === 'unconfigured') setState({ kind: 'unconfigured' });
      else setError(t('შეტყობინებები ვერ ჩაირთო.', 'Notifications could not be turned on.'));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError('');
    try {
      await disablePush();
      setState({ kind: 'off' });
    } catch {
      setError(t('შეტყობინებები ვერ გამოირთო.', 'Notifications could not be turned off.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bell-push">
      {state.kind === 'ios' && (
        <p className="small">{t('ტელეფონზე შეტყობინებები მუშაობს მას შემდეგ, რაც საიტს მთავარ ეკრანზე დაამატებთ (Add to Home Screen).', 'On iPhone, add this site to the Home Screen (Add to Home Screen) before notifications work.')}</p>
      )}
      {state.kind === 'unconfigured' && (
        <p className="small">{t('შეტყობინებები ჯერ არ არის ჩართული.', 'Notifications are not turned on yet.')}</p>
      )}
      {state.kind === 'denied' && (
        <p className="small">{t('შეტყობინებები დაბლოკილია. ჩართეთ ისინი ბრაუზერის პარამეტრებში.', 'Notifications are blocked. Turn them on in the browser settings.')}</p>
      )}
      {state.kind === 'on' && (
        <p className="small">{t('შეტყობინებები ჩართულია ამ მოწყობილობაზე.', 'Notifications are on for this device.')}</p>
      )}
      {state.kind === 'off' && (
        <button type="button" className="btn btn-primary" onClick={turnOn} disabled={busy}>
          {busy ? t('იტვირთება', 'Loading') : t('შეტყობინებების ჩართვა', 'Turn notifications on')}
        </button>
      )}
      {state.kind === 'on' && (
        <button type="button" className="btn" onClick={turnOff} disabled={busy}>
          {busy ? t('იტვირთება', 'Loading') : t('შეტყობინებების გამორთვა', 'Turn notifications off')}
        </button>
      )}
      {error && <p className="small" role="alert">{error}</p>}
    </div>
  );
}
