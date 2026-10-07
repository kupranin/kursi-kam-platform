import { useState, type FormEvent } from 'react';
import LangSwitch from '../components/LangSwitch';
import { useI18n } from '../lib/i18n';
import { supabase } from '../lib/supabase';

export default function Login() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'signin' | 'forgot' | 'sent'>('signin');

  async function signIn(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) { setError(t('შეიყვანეთ სამუშაო ელფოსტა და პაროლი.', 'Enter your work email and password.')); return; }
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    setBusy(false);
    if (error) setError(error.message === 'Invalid login credentials' ? t('ელფოსტა ან პაროლი არასწორია.', 'Email or password is wrong.') : error.message);
  }

  async function sendReset(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!email.trim()) { setError(t('შეიყვანეთ სამუშაო ელფოსტა.', 'Enter your work email.')); return; }
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
        <LangSwitch />
        <div className="brand"><span className="brand-mark">K</span><span>kursi business</span></div>
        {mode === 'signin' && (
          <form onSubmit={signIn} className="stack-sm" noValidate>
            <h1>{t('შესვლა', 'Sign in')}</h1>
            <div className="field">
              <label htmlFor="email">{t('სამუშაო ელფოსტა', 'Work email')}</label>
              <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="password">{t('პაროლი', 'Password')}</label>
              <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <p className="hint error" role="alert">{error}</p>}
            <button type="submit" className="btn btn-dark btn-big" disabled={busy}>{busy ? t('შედის…', 'Signing in…') : t('შესვლა', 'Sign in')}</button>
            <button type="button" className="link" onClick={() => { setMode('forgot'); setError(''); }}>{t('დაგავიწყდათ პაროლი?', 'Forgot password?')}</button>
          </form>
        )}
        {mode === 'forgot' && (
          <form onSubmit={sendReset} className="stack-sm" noValidate>
            <h1>{t('პაროლის აღდგენა', 'Reset password')}</h1>
            <p className="muted">{t('გამოგიგზავნით ბმულს ახალი პაროლის ასარჩევად.', 'We will send a link so you can choose a new password.')}</p>
            <div className="field">
              <label htmlFor="email2">{t('სამუშაო ელფოსტა', 'Work email')}</label>
              <input id="email2" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {error && <p className="hint error" role="alert">{error}</p>}
            <button type="submit" className="btn btn-dark btn-big" disabled={busy}>{busy ? t('იგზავნება…', 'Sending…') : t('აღდგენის ბმულის გაგზავნა', 'Send reset link')}</button>
            <button type="button" className="link" onClick={() => setMode('signin')}>{t('შესვლაზე დაბრუნება', 'Back to sign in')}</button>
          </form>
        )}
        {mode === 'sent' && (
          <div className="stack-sm">
            <h1>{t('შეამოწმეთ ელფოსტა', 'Check your email')}</h1>
            <p>{t('თუ {email}-ს ანგარიში აქვს, ახალი პაროლის ბმული გზაშია.', 'If {email} has an account, a link for a new password is on the way.', { email })}</p>
            <button type="button" className="link" onClick={() => setMode('signin')}>{t('შესვლაზე დაბრუნება', 'Back to sign in')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
