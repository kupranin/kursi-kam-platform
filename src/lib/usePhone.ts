import { useEffect, useState } from 'react';

const QUERY = '(max-width: 800px)';

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(QUERY).matches);

  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const apply = () => setPhone(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);

  return phone;
}
