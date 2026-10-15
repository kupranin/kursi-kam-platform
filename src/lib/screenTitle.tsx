import { createContext, useContext, useEffect } from 'react';

export const ScreenTitleContext = createContext<(title: string | null) => void>(() => {});

/** Replaces the phone header title while this screen is open. */
export function useScreenTitle(title: string | null) {
  const setTitle = useContext(ScreenTitleContext);
  useEffect(() => {
    setTitle(title);
    return () => setTitle(null);
  }, [setTitle, title]);
}
