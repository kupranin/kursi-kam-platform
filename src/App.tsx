import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { useI18n } from './lib/i18n';
import { HOME, PAGES } from './lib/nav';
import { arrivedFrom, isConfigured } from './lib/supabase';
import { useViewAs } from './lib/viewAs';
import Layout from './components/Layout';
import LangSwitch from './components/LangSwitch';
import Login from './pages/Login';
import SetPassword from './pages/SetPassword';
import SecondFactor from './pages/SecondFactor';
import Security from './pages/Security';
import Requests from './pages/Requests';
import FollowUps from './pages/FollowUps';
import RateDesk from './pages/RateDesk';
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
  const { loading, session, profile, needsSecondFactor, recovering, signOut } = useAuth();
  const { role } = useViewAs();
  const { t } = useI18n();
  const location = useLocation();

  if (!isConfigured) return <SetupNeeded />;
  if (location.pathname === '/set-password' || recovering || arrivedFrom === 'invite' || arrivedFrom === 'recovery') return <SetPassword />;
  if (loading) return <div className="loading">{t('იტვირთება…', 'Loading…')}</div>;
  if (!session) return <Login />;
  if (needsSecondFactor) return <SecondFactor />;
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

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to={HOME[role]} replace />} />
        {can('/requests') && <Route path="/requests" element={<Requests />} />}
        {can('/follow-ups') && <Route path="/follow-ups" element={<FollowUps />} />}
        {can('/rate-desk') && <Route path="/rate-desk" element={<RateDesk />} />}
        {can('/team') && <Route path="/team" element={<Team />} />}
        {can('/clients') && <Route path="/clients" element={<Clients />} />}
        {can('/analytics') && <Route path="/analytics" element={<Analytics />} />}
        {can('/analysis') && <Route path="/analysis" element={<Analyst />} />}
        {can('/kpis') && <Route path="/kpis" element={<Kpis />} />}
        {can('/rates') && <Route path="/rates" element={<MarketRates />} />}
        {can('/log') && <Route path="/log" element={<RequestLog />} />}
        {can('/chat') && <Route path="/chat" element={<Chat />} />}
        {can('/admin') && <Route path="/admin" element={<Admin />} />}
        <Route path="/security" element={<Security />} />
        <Route path="*" element={<Navigate to={HOME[role]} replace />} />
      </Routes>
    </Layout>
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
