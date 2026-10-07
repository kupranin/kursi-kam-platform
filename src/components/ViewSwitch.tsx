import { useNavigate } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { HOME } from '../lib/nav';
import { useViewAs } from '../lib/viewAs';
import type { Role } from '../lib/types';

const CHOICES: { id: Role; ka: string; en: string }[] = [
  { id: 'admin', ka: 'ადმინი', en: 'Admin' },
  { id: 'treasury', ka: 'სახაზინო', en: 'Treasury' },
  { id: 'kam', ka: 'KAM', en: 'KAM' },
  { id: 'manager', ka: 'მენეჯერი', en: 'Manager' },
];

export default function ViewSwitch({ onPage = false }: { onPage?: boolean }) {
  const { profile } = useAuth();
  const { role, setView } = useViewAs();
  const { t } = useI18n();
  const navigate = useNavigate();
  if (profile?.role !== 'admin') return null;

  function choose(next: Role) {
    const value: Role = next === role && next !== 'admin' ? 'admin' : next;
    setView(value);
    navigate(HOME[value]);
  }

  return (
    <div className={'view-as' + (onPage ? ' on-page' : '')}>
      <span className="view-as-label">{t('ხედი', 'View')}</span>
      <div className={'view-switch' + (onPage ? ' on-page' : '')} role="group" aria-label={t('ხედი', 'View')}>
        {CHOICES.map((choice) => (
          <button key={choice.id} type="button" aria-pressed={role === choice.id} onClick={() => choose(choice.id)}>
            {t(choice.ka, choice.en)}
          </button>
        ))}
      </div>
    </div>
  );
}
