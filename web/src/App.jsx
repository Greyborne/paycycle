import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Onboarding from './pages/Onboarding.jsx';
import Dashboard from './pages/Dashboard.jsx';
import PeriodDetail from './pages/PeriodDetail.jsx';
import Categories from './pages/Categories.jsx';
import Settings from './pages/Settings.jsx';
import Import from './pages/Import.jsx';
import Reports from './pages/Reports.jsx';
import NotificationsBell from './components/NotificationsBell.jsx';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

function Shell({ children }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
    navigate('/login');
  };
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">Pay<span>Cycle</span></Link>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/period/current">Pay Period</NavLink>
          <NavLink to="/categories">Categories</NavLink>
          <NavLink to="/import">Import</NavLink>
          <NavLink to="/reports">Reports</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="topbar-user">
          <NotificationsBell />
          <span className="muted small">
            {user.email}
            {user.household?.name ? ` · ${user.household.name}` : ''}
          </span>
          <button className="btn btn-ghost" onClick={logout}>Sign out</button>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const data = await api('/auth/me');
      setUser(data.user);
      setRegistrationOpen(data.registrationOpen);
      return data.user;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  useEffect(() => {
    refreshUser().finally(() => setLoading(false));
  }, [refreshUser]);

  if (loading) return <div className="page-loading">Loading…</div>;

  const ctx = { user, setUser, refreshUser, registrationOpen };

  return (
    <AuthContext.Provider value={ctx}>
      {!user ? (
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      ) : !user.onboardingComplete ? (
        <Routes>
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="*" element={<Navigate to="/onboarding" replace />} />
        </Routes>
      ) : (
        <Shell>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/period/:start" element={<PeriodDetail />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/import" element={<Import />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      )}
    </AuthContext.Provider>
  );
}
