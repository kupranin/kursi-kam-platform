import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'signin' | 'forgot' | 'sent'>('signin');

  async function signIn(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) { setError('Enter your work email and password.'); return; }
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    setBusy(false);
    if (error) setError(error.message === 'Invalid login credentials' ? 'Email or password is wrong.' : error.message);
  }

  async function sendReset(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!email.trim()) { setError('Enter your work email.'); return; }
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: window.location.origin + '/set-password',
    });
    setBusy(false);
    if (error) setError(error.message);
    else setMode('sent');
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand"><span className="brand-mark">K</span><span>kursi business</span></div>
        {mode === 'signin' && (
          <form onSubmit={signIn} className="stack-sm" noValidate>
            <h1>Sign in</h1>
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <p className="hint error" role="alert">{error}</p>}
            <button type="submit" className="btn btn-dark btn-big" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
            <button type="button" className="link" onClick={() => { setMode('forgot'); setError(''); }}>Forgot your password?</button>
          </form>
        )}
        {mode === 'forgot' && (
          <form onSubmit={sendReset} className="stack-sm" noValidate>
            <h1>Reset password</h1>
            <p className="muted">We'll email you a link to choose a new password.</p>
            <div className="field">
              <label htmlFor="email2">Work email</label>
              <input id="email2" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {error && <p className="hint error" role="alert">{error}</p>}
            <button type="submit" className="btn btn-dark btn-big" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
            <button type="button" className="link" onClick={() => setMode('signin')}>Back to sign in</button>
          </form>
        )}
        {mode === 'sent' && (
          <div className="stack-sm">
            <h1>Check your email</h1>
            <p>If {email} has an account, a link to set a new password is on its way.</p>
            <button type="button" className="link" onClick={() => setMode('signin')}>Back to sign in</button>
          </div>
        )}
      </div>
    </div>
  );
}
