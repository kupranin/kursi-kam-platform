import { Navigate, useLocation } from 'react-router-dom';
import TreasuryBetter from '../components/mobile/TreasuryBetter';
import TreasuryHome from '../components/mobile/TreasuryHome';
import TreasuryQuote from '../components/mobile/TreasuryQuote';
import TreasuryWrite from '../components/mobile/TreasuryWrite';
import { usePhone } from '../lib/usePhone';
import { useViewAs } from '../lib/viewAs';
import RateDesk from './RateDesk';

function clean(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** Phone treasury and an admin opening the desk get the mobile queues. Everyone else keeps the desktop rate desk. */
export default function RateDeskSwitch() {
  const phone = usePhone();
  const { role } = useViewAs();
  const { pathname } = useLocation();
  const path = clean(pathname);
  const mobile = phone && (role === 'treasury' || role === 'admin');

  if (!mobile) {
    if (path !== '/rate-desk') return <Navigate to="/rate-desk" replace />;
    return <RateDesk />;
  }

  const quote = path.match(/^\/rate-desk\/quote\/(\d+)$/);
  if (quote) return <TreasuryQuote id={Number(quote[1])} />;
  const better = path.match(/^\/rate-desk\/better\/(\d+)$/);
  if (better) return <TreasuryBetter id={Number(better[1])} />;
  const written = path.match(/^\/rate-desk\/write\/(\d+)$/);
  if (written) return <TreasuryWrite id={Number(written[1])} />;
  if (path !== '/rate-desk') return <Navigate to="/rate-desk" replace />;
  return <TreasuryHome />;
}
