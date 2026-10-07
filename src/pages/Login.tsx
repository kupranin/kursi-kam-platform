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
    if (!email.trim() || !password) { setError('შეიყვანეთ სამუშაო ელფოსტა და პაროლი.'); return; }
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    setBusy(false);
    if (error) setError(error.message === 'Invalid login credentials' ? 'ელფოსტა ან პაროლი არასწორია.' : error.message);
  }

  async function sendReset(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!email.trim()) { setError('შეიყვანეთ სამუშაო ელფოსტა.'); return; }
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
            <h1>შესვლა</h1>
            <div className="field">
              <label htmlFor="email">სამუშაო ელფოსტა</label>
              <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="password">პაროლი</label>
              <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <p className="hint error" role="alert">{error}</p>}
            <button type="submit" className="btn btn-dark btn-big" disabled={busy}>{busy ? 'შედის…' : 'შესვლა'}</button>
            <button type="button" className="link" onClick={() => { setMode('forgot'); setError(''); }}>დაგავიწყდათ პაროლი?</button>
          </form>
        )}
        {mode === 'forgot' && (
          <form onSubmit={sendReset} className="stack-sm" noValidate>
            <h1>პაროლის აღდგენა</h1>
            <p className="muted">გამოგიგზავნით ბმულს ახალი პაროლის ასარჩევად.</p>
            <div className="field">
              <label htmlFor="email2">სამუშაო ელფოსტა</label>
              <input id="email2" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {error && <p className="hint error" role="alert">{error}</p>}
            <button type="submit" className="btn btn-dark btn-big" disabled={busy}>{busy ? 'იგზავნება…' : 'აღდგენის ბმულის გაგზავნა'}</button>
            <button type="button" className="link" onClick={() => setMode('signin')}>შესვლაზე დაბრუნება</button>
          </form>
        )}
        {mode === 'sent' && (
          <div className="stack-sm">
            <h1>შეამოწმეთ ელფოსტა</h1>
            <p>თუ {email}-ს ანგარიში აქვს, ახალი პაროლის ბმული გზაშია.</p>
            <button type="button" className="link" onClick={() => setMode('signin')}>შესვლაზე დაბრუნება</button>
          </div>
        )}
      </div>
    </div>
  );
}
