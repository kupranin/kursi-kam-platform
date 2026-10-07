export type Lang = 'ka' | 'en';

const STORAGE = 'kursi-lang';

function read(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE);
    if (saved === 'en' || saved === 'ka') return saved;
  } catch {
    /* private mode */
  }
  return 'ka';
}

let lang: Lang = typeof localStorage === 'undefined' ? 'ka' : read();
const listeners = new Set<() => void>();

if (typeof document !== 'undefined') {
  document.documentElement.lang = lang === 'en' ? 'en' : 'ka';
}

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang) {
  if (next !== 'ka' && next !== 'en') return;
  lang = next;
  try { localStorage.setItem(STORAGE, next); } catch { /* ignore */ }
  if (typeof document !== 'undefined') document.documentElement.lang = next === 'en' ? 'en' : 'ka';
  listeners.forEach((fn) => fn());
}

export function subscribeLang(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
