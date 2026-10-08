import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getLang, setLang, subscribeLang, type Lang } from './lang';
import type { Role } from './types';

type Vars = Record<string, string | number>;

interface I18n {
  lang: Lang;
  setLang: (next: Lang) => void;
  t: (ka: string, en: string, vars?: Vars) => string;
  roleName: (role: Role | string) => string;
}

const Ctx = createContext<I18n | null>(null);

function fill(text: string, vars?: Vars) {
  if (!vars) return text;
  return Object.entries(vars).reduce((s, [key, value]) => s.split('{' + key + '}').join(String(value)), text);
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, set] = useState<Lang>(getLang);
  useEffect(() => subscribeLang(() => set(getLang())), []);

  const value = useMemo<I18n>(() => {
    const t = (ka: string, en: string, vars?: Vars) => fill(lang === 'en' ? en : ka, vars);
    const roleName = (role: Role | string) => {
      if (role === 'admin') return t('ადმინი', 'Admin');
      if (role === 'manager') return t('მენეჯერი', 'Manager');
      if (role === 'treasury') return t('სახაზინო', 'Treasury');
      if (role === 'kam') return 'KAM';
      if (role === 'analyst') return t('ანალიტიკოსი', 'Analyst');
      return String(role);
    };
    return { lang, setLang, t, roleName };
  }, [lang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n outside LanguageProvider');
  return ctx;
}
