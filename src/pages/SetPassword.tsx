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
    if (password.length < 12) { setError('მინიმუმ 12 სიმბოლო.'); return; }
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) { setError('გამოიყენეთ ასოები და მინიმუმ ერთი ციფრი.'); return; }
    if (password !== repeat) { setError('ორი პაროლი არ ემთხვევა.'); return; }
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
        {!ready && <p className="muted">ბმული იხსნება…</p>}
        {ready && !session && (
          <div className="stack-sm">
            <h1>ეს ბმული ვადაგასულია</h1>
            <p>ბმული ერთხელ და შეზღუდული დროით მუშაობს. სთხოვეთ ადმინს ახალი მოწვევა, ან გამოიყენეთ „დაგავიწყდათ პაროლი?“ შესვლის გვერდზე.</p>
            <a className="btn" href="/">შესვლაზე გადასვლა</a>
          </div>
        )}
        {ready && session && (
          <form onSubmit={save} className="stack-sm" noValidate>
            <h1>აირჩიეთ პაროლი</h1>
            <p className="muted small">{session.user.email}-ისთვის. მინიმუმ 12 სიმბოლო, ასოებით და ციფრით. სხვა არავინ, ადმინიც, ვერ ნახავს.</p>
            <div className="field">
              <label htmlFor="pw1">ახალი პაროლი</label>
              <input id="pw1" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="pw2">გაიმეორეთ</label>
              <input id="pw2" className="input" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            </div>
            {error && <p className="hint error" role="alert">{error}</p>}
            <button type="submit" className="btn btn-dark btn-big" disabled={busy}>{busy ? 'ინახება…' : 'პაროლის შენახვა'}</button>
          </form>
        )}
      </div>
    </div>
  );
}
