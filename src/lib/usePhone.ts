import { useEffect, useLayoutEffect, useState } from 'react';

/**
 * A phone in either orientation. The short side of the phones we support
 * (360–430 CSS pixels) stays under this, including landscape.
 * Tablets sit higher (iPad portrait is about 768).
 */
const PHONE_SHORT_MAX = 480;

/** Longer side of a phone in landscape (iPhone Pro Max ~932, Pixel ~915). */
const PHONE_LONG_MAX = 1000;

/** A desktop window dragged narrow still uses the phone shell. A real tablet does not. */
const NARROW_WIDTH = 800;

export function isPhoneLayout(width: number, height: number, coarse: boolean): boolean {
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  if (shortSide <= PHONE_SHORT_MAX && (longSide <= PHONE_LONG_MAX || coarse)) return true;
  if (width <= PHONE_SHORT_MAX) return true;
  if (width <= NARROW_WIDTH && !coarse) return true;
  return false;
}

function readCoarse(): boolean {
  return window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(any-pointer: coarse)').matches;
}

export function readPhone(): boolean {
  if (typeof window === 'undefined') return false;
  return isPhoneLayout(window.innerWidth, window.innerHeight, readCoarse());
}

function publish(phone: boolean) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('is-phone', phone);
}

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => {
    const next = readPhone();
    publish(next);
    return next;
  });

  useEffect(() => {
    const apply = () => {
      const next = readPhone();
      publish(next);
      setPhone(next);
    };
    apply();
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    const queries = ['(pointer: coarse)', '(any-pointer: coarse)', '(max-width: 800px)', '(max-height: 480px)']
      .map((query) => window.matchMedia(query));
    queries.forEach((media) => media.addEventListener('change', apply));
    return () => {
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
      queries.forEach((media) => media.removeEventListener('change', apply));
    };
  }, []);

  return phone;
}

/** Lifts the tab bar out of the way while a field is focused or the keyboard is open. */
export function usePhoneKeyboard(phone: boolean) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!phone) {
      root.classList.remove('kb-open');
      root.style.removeProperty('--keyboard-inset');
      root.style.removeProperty('--app-h');
      root.style.removeProperty('--vv-offset');
      return;
    }
    let alive = true;
    const sync = () => {
      if (!alive) return;
      const viewport = window.visualViewport;
      const visible = viewport ? viewport.height : window.innerHeight;
      const offset = viewport ? viewport.offsetTop : 0;
      const overlap = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
      root.style.setProperty('--app-h', Math.round(visible) + 'px');
      root.style.setProperty('--vv-offset', Math.round(offset) + 'px');
      root.style.setProperty('--keyboard-inset', Math.round(overlap) + 'px');
      const focused = document.activeElement;
      const typing = focused instanceof HTMLElement && focused.matches('input, textarea, select');
      root.classList.toggle('kb-open', overlap > 80 || typing);
      if (typing && focused instanceof HTMLElement) {
        const scroller = focused.closest('.m-scroll');
        if (scroller instanceof HTMLElement) {
          const rect = focused.getBoundingClientRect();
          const box = scroller.getBoundingClientRect();
          if (rect.bottom > box.bottom - 8 || rect.top < box.top + 8) {
            focused.scrollIntoView({ block: 'nearest' });
          }
        }
      }
    };
    const later = () => window.setTimeout(sync, 60);
    sync();
    window.visualViewport?.addEventListener('resize', sync);
    window.visualViewport?.addEventListener('scroll', sync);
    window.addEventListener('focusin', sync);
    window.addEventListener('focusout', later);
    return () => {
      alive = false;
      window.visualViewport?.removeEventListener('resize', sync);
      window.visualViewport?.removeEventListener('scroll', sync);
      window.removeEventListener('focusin', sync);
      window.removeEventListener('focusout', later);
      root.classList.remove('kb-open');
      root.style.removeProperty('--keyboard-inset');
      root.style.removeProperty('--app-h');
      root.style.removeProperty('--vv-offset');
    };
  }, [phone]);
}
