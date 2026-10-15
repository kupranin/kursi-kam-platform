import { useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { useI18n } from './lib/i18n';
import { HOME, PAGES, phoneHome } from './lib/nav';
import { usePhone } from './lib/usePhone';
import { arrivedFrom, isConfigured } from './lib/supabase';
import { useViewAs } from './lib/viewAs';
import DesktopOnly, { PhoneGate } from './components/DesktopOnly';
import Layout from './components/Layout';
import LangSwitch from './components/LangSwitch';
import Login from './pages/Login';
import SetPassword from './pages/SetPassword';
import SecondFactor from './pages/SecondFactor';
import Security from './pages/Security';
import PhoneMore from './components/mobile/PhoneMore';
import RequestsSwitch from './pages/RequestsSwitch';
import FollowUps from './pages/FollowUps';
import RateDesk from './pages/RateDesk';
import QuoteProgress from './pages/QuoteProgress';
import LostRequests from './pages/LostRequests';
import DeskHistory from './pages/DeskHistory';
import Team from './pages/Team';
import Clients from './pages/Clients';
import Analytics from './pages/Analytics';
import Kpis from './pages/Kpis';
import MarketRates from './pages/MarketRates';
import Chat from './pages/Chat';
import RequestLog from './pages/RequestLog';
import Admin from './pages/admin/Admin';
import Analyst from './pages/Analyst';

export default function App() {
  const { loading, session, profile, profileUnavailable, needsSecondFactor, recovering, signOut } = useAuth();
  const { role } = useViewAs();
  const { t } = useI18n();
  const location = useLocation();
  const phone = usePhone();

  if (!isConfigured) return <SetupNeeded />;
  if (location.pathname === '/set-password' || recovering || arrivedFrom === 'invite' || arrivedFrom === 'recovery') return <SetPassword />;
  if (loading) return <div className="loading">{t('იტვირთება', 'Loading')}</div>;
  if (!session) return <Login />;
  if (needsSecondFactor) return <SecondFactor />;
  if (profileUnavailable) return <PlatformStarting />;
  if (!profile) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <LangSwitch />
          <h1>{t('წვდომა ჯერ არ არის', 'No access yet')}</h1>
          <p>{t('შესვლა მუშაობს, მაგრამ ანგარიში პლატფორმაზე არ არის აწყობილი ან გამორთულია. სთხოვეთ ადმინს, შეამოწმოს ხალხის სია.', 'Sign-in works, but this account is not set up on the platform, or it is switched off. Ask an admin to check the people list.')}</p>
          <button type="button" className="btn" onClick={signOut}>{t('გასვლა', 'Sign out')}</button>
        </div>
      </div>
    );
  }

  const allowed = PAGES[role];
  const can = (path: string) => allowed.includes(path);
  const screen = (path: string, element: ReactNode) => can(path)
    ? <Route key={path} path={path} element={<PhoneGate path={path}>{element}</PhoneGate>} />
    : null;
  const home = phone ? phoneHome(role) : HOME[role];

  return (
    <Layout>
      <Routes>
        <Route path="/" element={home ? <Navigate to={home} replace /> : <DesktopOnly />} />
        {can('/requests') ? <Route key="/requests" path="/requests/*" element={<PhoneGate path="/requests"><RequestsSwitch /></PhoneGate>} /> : null}
        {screen('/more', <PhoneMore />)}
        {screen('/follow-ups', <FollowUps />)}
        {screen('/rate-desk', <RateDesk />)}
        {screen('/quoted-progress', <QuoteProgress />)}
        {screen('/lost-requests', <LostRequests />)}
        {screen('/desk-history', <DeskHistory />)}
        {screen('/team', <Team />)}
        {screen('/clients', <Clients />)}
        {screen('/analytics', <Analytics />)}
        {screen('/analysis', <Analyst />)}
        {screen('/kpis', <Kpis />)}
        {screen('/rates', <MarketRates />)}
        {screen('/log', <RequestLog />)}
        {screen('/chat', <Chat />)}
        {screen('/admin', <Admin />)}
        <Route path="/security" element={<Security />} />
        <Route path="*" element={home ? <Navigate to={home} replace /> : <DesktopOnly />} />
      </Routes>
    </Layout>
  );
}

function PlatformStarting() {
  const { t } = useI18n();
  const { refresh } = useAuth();
  const [busy, setBusy] = useState(false);

  async function again() {
    setBusy(true);
    try {
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <LangSwitch />
        <h1>{t('პლატფორმა ჯერ ირთვება', 'The platform is still starting')}</h1>
        <p>{t('რამდენიმე წუთში სცადეთ თავიდან.', 'Try again in a few minutes.')}</p>
        <button type="button" className="btn" onClick={again} disabled={busy}>
          {busy ? t('მიმდინარეობს…', 'Trying…') : t('თავიდან ცდა', 'Try again')}
        </button>
      </div>
    </div>
  );
}

function SetupNeeded() {
  const { t } = useI18n();
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <LangSwitch />
        <h1>{t('თითქმის მზადაა', 'Almost ready')}</h1>
        <p>{t('აპლიკაციამ ჯერ არ იცის, რომელ Supabase პროექტს გამოიყენოს. დაამატეთ VITE_SUPABASE_URL და VITE_SUPABASE_ANON_KEY Vercel-ში (Project Settings, Environment Variables), შემდეგ თავიდან გააშვეთ.', 'The app does not know which Supabase project to use yet. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel (Project Settings, Environment Variables), then start it again.')}</p>
      </div>
    </div>
  );
}
