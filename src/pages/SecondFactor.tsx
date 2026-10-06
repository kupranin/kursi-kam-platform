import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';

export default function SecondFactor() {
  const { refresh, signOut } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp?.find((f) => f.status === 'verified');
    if (listError || !factor) { setBusy(false); setError('No authenticator app found for this account.'); return; }
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
    setBusy(false);
    if (error) { setError('That code didn\'t work. Use the newest code from the app.'); return; }
    await refresh();
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand"><span className="brand-mark">K</span><span>kursi business</span></div>
        <form onSubmit={verify} className="stack-sm" noValidate>
          <h1>Confirm it's you</h1>
          <p className="muted">Enter the 6-digit code from your authenticator app.</p>
          <div className="field">
            <label htmlFor="code">Code</label>
            <input id="code" className="input big" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </div>
          {error && <p className="hint error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-dark btn-big" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Confirm'}</button>
          <button type="button" className="link" onClick={signOut}>Sign out</button>
        </form>
      </div>
    </div>
  );
}
