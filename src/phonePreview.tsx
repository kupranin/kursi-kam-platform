import { useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import KamHome from './components/mobile/KamHome';
import KamNewRequest from './components/mobile/KamNewRequest';
import KamRequestDetail from './components/mobile/KamRequestDetail';
import PhoneMore from './components/mobile/PhoneMore';
import Chat from './pages/Chat';
import MarketRates from './pages/MarketRates';
import type { RequestRow } from './lib/types';

const now = Date.now();

function row(partial: Partial<RequestRow> & Pick<RequestRow, 'id' | 'client_name' | 'quote_state' | 'quote_status'>): RequestRow {
  return {
    kam_id: 'preview-kam',
    kam_name: 'ნინო ბერიძე',
    client_id: '405123456',
    client_kind: 'company',
    requested_at: new Date(now - 40 * 60000).toISOString(),
    request_date: '2026-10-15',
    sells_currency: 'USD',
    gets_currency: 'GEL',
    amount: 50000,
    gets_amount: null,
    client_rate: null,
    rate: null,
    note: null,
    loss_reason: null,
    source: 'app',
    went_through: false,
    outcome: 'waiting',
    asked_at: new Date(now - 18 * 60000).toISOString(),
    rate_valid_until: null,
    quoted_at: null,
    decline_reason: null,
    client_reply: null,
    bank: 'TBC',
    ...partial,
  };
}

const quoted = row({
  id: 1,
  client_name: 'შპს მზე',
  quote_state: 'quoted',
  quote_status: 'quoted',
  rate: 2.6521,
  quoted_at: new Date(now - 4 * 60000).toISOString(),
  rate_valid_until: new Date(now + 25 * 60000).toISOString(),
});

const waiting = row({
  id: 2,
  client_name: 'შპს ნავთობი',
  client_id: '404998877',
  quote_state: 'asking',
  quote_status: 'asking',
  amount: 120000,
  sells_currency: 'EUR',
  gets_currency: 'USD',
  asked_at: new Date(now - 12 * 60000).toISOString(),
});

const recent = row({
  id: 3,
  client_name: 'გიორგი ბერიძე',
  client_id: '01024012345',
  quote_state: 'declined',
  quote_status: 'declined',
  client_reply: 'declined',
  amount: 8000,
  went_through: false,
  outcome: 'did_not_go_through',
  loss_reason: 'price',
  asked_at: new Date(now - 3 * 3600000).toISOString(),
  requested_at: new Date(now - 3 * 3600000).toISOString(),
});

export default function PhonePreview() {
  const { pathname } = useLocation();
  const detail = pathname.match(/^\/requests\/(\d+)$/);
  let screen = <KamHome seed={{ action: [quoted], waiting: [waiting], active: [], recent: [recent] }} />;
  if (pathname === '/requests/new') screen = <KamNewRequest />;
  else if (detail) screen = <KamRequestDetail id={Number(detail[1])} seed={quoted} />;
  else if (pathname === '/more') screen = <PhoneMore />;
  else if (pathname === '/rates') screen = <MarketRates />;
  else if (pathname === '/chat') screen = <Chat />;
  return <Layout>{screen}</Layout>;
}
