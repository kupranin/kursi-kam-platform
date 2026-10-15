import { Navigate, useLocation } from 'react-router-dom';
import { useViewAs } from '../lib/viewAs';
import { usePhone } from '../lib/usePhone';
import KamEarlier from '../components/mobile/KamEarlier';
import KamHome from '../components/mobile/KamHome';
import KamNewRequest from '../components/mobile/KamNewRequest';
import KamRequestDetail from '../components/mobile/KamRequestDetail';
import Requests from './Requests';

/** Phone KAM gets the mobile desk. Every other case keeps the desktop Requests page. */
export default function RequestsSwitch() {
  const phone = usePhone();
  const { role } = useViewAs();
  const { pathname } = useLocation();
  const kamPhone = phone && role === 'kam';

  if (!kamPhone) {
    if (pathname !== '/requests') return <Navigate to="/requests" replace />;
    return <Requests />;
  }
  if (pathname === '/requests/new') return <KamNewRequest />;
  if (pathname === '/requests/history') return <KamEarlier />;
  const detail = pathname.match(/^\/requests\/(\d+)$/);
  if (detail) return <KamRequestDetail id={Number(detail[1])} />;
  if (pathname !== '/requests') return <Navigate to="/requests" replace />;
  return <KamHome />;
}
