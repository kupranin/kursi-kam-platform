import { useI18n } from '../lib/i18n';

export default function LangSwitch({ onPage = false }: { onPage?: boolean }) {
  const { lang, setLang, t } = useI18n();
  return (
    <div className={'lang-switch' + (onPage ? ' on-page' : '')} role="group" aria-label={t('ენა', 'Language')}>
      <button type="button" aria-pressed={lang === 'ka'} onClick={() => setLang('ka')}>ქართული</button>
      <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>English</button>
    </div>
  );
}
