import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';

export default function SetPassword() {
  const { session, refresh } = useAuth();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // the session arrives from the link in the address; give it a moment
  useEffect(() => {
    if (session) { setReady(true); return; }
    const t = window.setTimeout(() => setReady(true), 2500);
    return () => window.clearTimeout(t);
  }, [session]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 12) { setError('Use at least 12 characters.'); return; }
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) { setError('Use letters and at least one digit.'); return; }
    if (password !== repeat) { setError('The two passwords are different.'); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) { setError(error.message); return; }
    window.history.replaceState(null, '', '/');
    await refresh();
    navigate('/', { replace: true });
    window.location.reload();
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand"><span className="brand-mark">K</span><span>kursi business</span></div>
        {!ready && <p className="muted">Opening your link…</p>}
        {ready && !session && (
          <div className="stack-sm">
            <h1>This link has expired</h1>
            <p>Links work once and for a limited time. Ask an admin to send a new invite, or use "Forgot your password?" on the sign-in page.</p>
            <a className="btn" href="/">Go to sign in</a>
          </div>
        )}
        {ready && session && (
          <form onSubmit={save} className="stack-sm" noValidate>
            <h1>Choose your password</h1>
            <p className="muted small">For {session.user.email}. At least 12 characters, with letters and a digit. Nobody else, including admins, will see it.</p>
            <div className="field">
              <label htmlFor="pw1">New password</label>
              <input id="pw1" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="pw2">Repeat it</label>
              <input id="pw2" className="input" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            </div>
            {error && <p className="hint error" role="alert">{error}</p>}
            <button type="submit" className="btn btn-dark btn-big" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
          </form>
        )}
      </div>
    </div>
  );
}
