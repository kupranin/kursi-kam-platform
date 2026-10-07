import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { arrivedFrom, isConfigured } from './lib/supabase';
import type { Role } from './lib/types';
import Layout from './components/Layout';
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
import Admin from './pages/admin/Admin';

const HOME: Record<Role, string> = {
  kam: '/requests',
  treasury: '/rate-desk',
  admin: '/team',
  manager: '/team',
};

const PAGES: Record<Role, string[]> = {
  kam: ['/requests', '/follow-ups', '/clients', '/team', '/rates'],
  treasury: ['/rate-desk', '/rates'],
  admin: ['/team', '/requests', '/rate-desk', '/follow-ups', '/clients', '/analytics', '/kpis', '/rates', '/admin'],
  manager: ['/team', '/requests', '/follow-ups', '/clients', '/analytics', '/kpis', '/rates'],
};

export default function App() {
  const { loading, session, profile, needsSecondFactor, recovering, signOut } = useAuth();
  const location = useLocation();

  if (!isConfigured) return <SetupNeeded />;
  if (location.pathname === '/set-password' || recovering || arrivedFrom === 'invite' || arrivedFrom === 'recovery') return <SetPassword />;
  if (loading) return <div className="loading">Loading…</div>;
  if (!session) return <Login />;
  if (needsSecondFactor) return <SecondFactor />;
  if (!profile) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1>No access yet</h1>
          <p>Your login works, but your account isn't set up on the platform or has been switched off. Ask an admin to check the People list.</p>
          <button type="button" className="btn" onClick={signOut}>Sign out</button>
        </div>
      </div>
    );
  }

  const allowed = PAGES[profile.role];
  const can = (path: string) => allowed.includes(path);

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to={HOME[profile.role]} replace />} />
        {can('/requests') && <Route path="/requests" element={<Requests />} />}
        {can('/follow-ups') && <Route path="/follow-ups" element={<FollowUps />} />}
        {can('/rate-desk') && <Route path="/rate-desk" element={<RateDesk />} />}
        {can('/team') && <Route path="/team" element={<Team />} />}
        {can('/clients') && <Route path="/clients" element={<Clients />} />}
        {can('/analytics') && <Route path="/analytics" element={<Analytics />} />}
        {can('/kpis') && <Route path="/kpis" element={<Kpis />} />}
        {can('/rates') && <Route path="/rates" element={<MarketRates />} />}
        {can('/admin') && <Route path="/admin" element={<Admin />} />}
        <Route path="/security" element={<Security />} />
        <Route path="*" element={<Navigate to={HOME[profile.role]} replace />} />
      </Routes>
    </Layout>
  );
}

function SetupNeeded() {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>Almost there</h1>
        <p>The app doesn't know which Supabase project to use yet. Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in Vercel (Project Settings, Environment Variables), then redeploy.</p>
      </div>
    </div>
  );
}
