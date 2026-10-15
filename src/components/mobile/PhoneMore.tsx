import { Link } from 'react-router-dom';
import LangSwitch from '../LangSwitch';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';

export default function PhoneMore() {
  const { t } = useI18n();
  const { signOut } = useAuth();

  return (
    <div className="m-more">
      <Link to="/rates" className="m-more-row">{t('კურსები', 'Rates')}</Link>
      <Link to="/clients" className="m-more-row">{t('კლიენტები', 'Clients')}</Link>
      <Link to="/follow-ups" className="m-more-row">{t('დაბრუნება', 'Follow-ups')}</Link>
      <button type="button" className="m-more-row" onClick={() => window.dispatchEvent(new Event('kursi-open-bell'))}>
        {t('შეტყობინებები', 'Notifications')}
      </button>
      <div className="m-more-block">
        <div className="m-more-label">{t('ენა', 'Language')}</div>
        <LangSwitch onPage />
      </div>
      <Link to="/security" className="m-more-row">{t('პაროლი და შესვლა', 'Password and sign-in')}</Link>
      <button type="button" className="m-more-row m-more-out" onClick={() => { void signOut(); }}>
        {t('გასვლა', 'Sign out')}
      </button>
    </div>
  );
}
