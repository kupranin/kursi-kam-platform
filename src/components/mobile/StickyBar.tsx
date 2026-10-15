import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Publishes the action bar's real height as `--sticky-h` so the field scroller can reserve exactly that much. */
export default function StickyBar({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!el) return;
    const publish = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      root.style.setProperty('--sticky-h', height + 'px');
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el, { box: 'border-box' });
    return () => {
      observer.disconnect();
      root.style.setProperty('--sticky-h', '0px');
    };
  }, []);

  return (
    <div ref={ref} className="m-sticky">
      {children}
    </div>
  );
}
