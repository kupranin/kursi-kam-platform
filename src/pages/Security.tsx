import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Factor { id: string; status: string; friendly_name?: string }

export default function Security() {
  const toast = useToast();
  const [factors, setFactors] = useState<Factor[]>([]);
  const [enrolling, setEnrolling] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');

  async function load() {
    const { data } = await supabase.auth.mfa.listFactors();
    setFactors((data?.totp ?? []) as Factor[]);
  }
  useEffect(() => { load(); }, []);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (pw.length < 12 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) { setError('Use at least 12 characters, with letters and a digit.'); return; }
    if (pw !== pw2) { setError('The two passwords are different.'); return; }
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) { setError(error.message); return; }
    setPw(''); setPw2('');
    toast('Password changed.');
  }

  async function startEnroll() {
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator ' + new Date().toISOString().slice(0, 10) });
    if (error || !data) { toast(error?.message ?? 'Could not start', 'error'); return; }
    setEnrolling({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function confirmEnroll(e: FormEvent) {
    e.preventDefault();
    if (!enrolling) return;
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolling.id, code: code.trim() });
    if (error) { toast('That code didn\'t work. Use the newest code from the app.', 'error'); return; }
    setEnrolling(null); setCode('');
    toast('Authenticator app added. You\'ll be asked for a code when you sign in.');
    load();
  }

  async function remove(id: string) {
    if (!window.confirm('Remove this authenticator app?')) return;
    const { error } = await supabase.auth.mfa.unenroll({ factorId: id });
    if (error) { toast(error.message, 'error'); return; }
    toast('Authenticator app removed.');
    load();
  }

  const verified = factors.filter((f) => f.status === 'verified');

  return (
    <>
      <div className="page-head"><div><h1>Password and sign-in</h1></div></div>
      <div className="cols">
        <section className="card col-main" aria-labelledby="pw-title">
          <h2 id="pw-title">Change password</h2>
          <form onSubmit={changePassword} className="stack-sm" noValidate style={{ maxWidth: 420 }}>
            <div className="field"><label htmlFor="npw">New password</label><input id="npw" className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
            <div className="field"><label htmlFor="npw2">Repeat it</label><input id="npw2" className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
            {error && <p className="hint error" role="alert">{error}</p>}
            <div><button type="submit" className="btn btn-dark">Change password</button></div>
          </form>
        </section>
        <section className="card col-side" aria-labelledby="mfa-title">
          <h2 id="mfa-title">Authenticator app</h2>
          <p className="small muted">A 6-digit code from an app like Google Authenticator, asked for at sign-in. Admins may be required to use one.</p>
          {verified.map((f) => (
            <div key={f.id} className="row-between" style={{ padding: '8px 0' }}>
              <span className="pill pill-ok">On</span>
              <button type="button" className="link danger" onClick={() => remove(f.id)}>Remove</button>
            </div>
          ))}
          {!verified.length && !enrolling && <button type="button" className="btn" onClick={startEnroll}>Add an authenticator app</button>}
          {enrolling && (
            <form onSubmit={confirmEnroll} className="stack-sm">
              <p className="small">Scan this with the app, then type the code it shows.</p>
              <img src={enrolling.qr} alt="QR code for the authenticator app" width={180} height={180} />
              <p className="tiny muted">Can't scan? Enter this key: <code>{enrolling.secret}</code></p>
              <div className="field"><label htmlFor="mfa-code">Code</label><input id="mfa-code" className="input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></div>
              <div className="row"><button type="submit" className="btn btn-dark" disabled={code.length !== 6}>Confirm</button><button type="button" className="link" onClick={() => setEnrolling(null)}>Cancel</button></div>
            </form>
          )}
        </section>
      </div>
    </>
  );
}
