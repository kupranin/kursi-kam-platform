import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { isPhonePage, phoneHome } from '../lib/nav';
import { usePhone } from '../lib/usePhone';
import { useViewAs } from '../lib/viewAs';

export default function DesktopOnly() {
  const { signOut } = useAuth();
  const { t } = useI18n();
  const { role } = useViewAs();
  const phone = usePhone();
  const home = phone ? phoneHome(role) : null;
  const analyst = role === 'analyst';

  return (
    <section className="card">
      <h1>{t('ეს გვერდი კომპიუტერზეა', 'This page is on a computer')}</h1>
      <p>
        {analyst
          ? t('ანალიზი, ანალიტიკა და კურსები კომპიუტერზეა. ტელეფონზე ეს სამუშაო არ არის.', 'Analysis, analytics, and rates are on a computer. That work is not on the phone.')
          : t('ეს ნაწილი ტელეფონზე არ არის. გახსენით კომპიუტერზე.', 'This part is not on the phone. Open it on a computer.')}
      </p>
      {analyst ? (
        <button type="button" className="btn" onClick={signOut}>{t('გასვლა', 'Sign out')}</button>
      ) : home ? (
        <Link to={home} className="btn btn-primary">{t('მთავარზე', 'Home')}</Link>
      ) : null}
    </section>
  );
}

export function PhoneGate({ path, children }: { path: string; children: ReactNode }) {
  const phone = usePhone();
  const { role } = useViewAs();
  if (phone && !isPhonePage(role, path)) return <DesktopOnly />;
  return children;
}
