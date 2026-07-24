import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import {
  CalendarIcon, ChartIcon, CollapseIcon, GearIcon, HomeIcon, ImportIcon, ListIcon, MenuIcon,
  MonitorIcon, MoonIcon, ShieldIcon, SignOutIcon, SlidersIcon, SunIcon, TagIcon,
} from './icons.jsx';
import Login from './pages/Login.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import Onboarding from './pages/Onboarding.jsx';
import Dashboard from './pages/Dashboard.jsx';
import PeriodDetail from './pages/PeriodDetail.jsx';
import Categories from './pages/Categories.jsx';
import Settings from './pages/Settings.jsx';
import Import from './pages/Import.jsx';
import Reports from './pages/Reports.jsx';
import Transactions from './pages/Transactions.jsx';
import Rules from './pages/Rules.jsx';
import Admin from './pages/Admin.jsx';
import NotificationsBell from './components/NotificationsBell.jsx';
import { useAccounts } from './useAccounts.js';
import { applyInstanceColor } from './instanceColors.js';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

// Which base-currency account the dashboard and pay-period views are scoped
// to. Every balance/projection surface shows exactly one account (the whole
// point: a healthy total can hide an overdraft in one account); the server
// resolves null/stale ids to the default account.
const AccountContext = createContext({ accountId: null, setAccountId: () => {} });
export const useAccount = () => useContext(AccountContext);

// Theme: 'system' follows the OS; 'light'/'dark' are explicit overrides. The
// resolved theme is stamped on the <html> element as data-theme (also done by
// an inline script in index.html before first paint).
export const THEME_MODES = ['system', 'light', 'dark'];
const ThemeContext = createContext({ themeMode: 'system', setThemeMode: () => {} });
export const useTheme = () => useContext(ThemeContext);

// Instance branding (INSTANCE_LABEL/INSTANCE_COLOR): { label, color } as
// served by /auth/config, applied globally once at boot. Empty fields mean
// "no branding" - the production default, which must render nothing extra.
const InstanceContext = createContext({ label: '', color: '' });
export const useInstance = () => useContext(InstanceContext);

// Set by applyInstanceBranding() at boot so the theme-color meta tag stays
// tinted to the instance color across light/dark toggles, instead of
// reverting to the plain page-background value applyTheme() uses otherwise.
let instanceThemeColor = null;

function applyTheme(mode) {
  const dark = mode === 'dark'
    || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', instanceThemeColor || (dark ? '#0f0e0d' : '#f4f2ee'));
}

// Applies the /auth/config `instance` block globally: runtime tab title,
// favicon/apple-touch-icon tint, and the badge's CSS custom properties. A
// no-op (leaves the static defaults from index.html untouched) when both
// fields are empty - the production case.
function applyInstanceBranding({ label, color }) {
  if (label) document.title = `PayCycle | ${label}`;
  if (!color) return;
  const applied = applyInstanceColor(color);
  if (!applied) return;
  instanceThemeColor = applied.hex;
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) icon.setAttribute('href', applied.dataUri);
  const touchIcon = document.querySelector('link[rel="apple-touch-icon"]');
  if (touchIcon) touchIcon.setAttribute('href', applied.dataUri);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', applied.hex);
}

function ThemeToggle() {
  const { themeMode, setThemeMode } = useTheme();
  const Icon = themeMode === 'light' ? SunIcon : themeMode === 'dark' ? MoonIcon : MonitorIcon;
  const label = themeMode[0].toUpperCase() + themeMode.slice(1);
  const nextMode = THEME_MODES[(THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length];
  return (
    <button
      className="btn btn-ghost theme-toggle"
      title={`Theme: ${label} — click for ${nextMode[0].toUpperCase() + nextMode.slice(1)}`}
      aria-label={`Theme: ${label}`}
      onClick={() => setThemeMode(nextMode)}
    >
      <Icon />
    </button>
  );
}

const PAGE_TITLES = [
  ['/period', 'Pay Period'],
  ['/transactions', 'Transactions'],
  ['/rules', 'Rules'],
  ['/categories', 'Categories'],
  ['/import', 'Import'],
  ['/reports', 'Reports'],
  ['/settings', 'Settings'],
  ['/admin', 'Admin'],
];

const NAV_SECTIONS = [
  ['Main', [
    ['/', 'Dashboard', HomeIcon, { end: true }],
    ['/period/current', 'Pay Period', CalendarIcon],
    ['/transactions', 'Transactions', ListIcon],
    ['/reports', 'Reports', ChartIcon],
  ]],
  ['Manage', [
    ['/categories', 'Categories', TagIcon],
    ['/import', 'Import', ImportIcon],
    ['/rules', 'Rules', SlidersIcon],
  ]],
  ['Tools', [
    ['/settings', 'Settings', GearIcon],
  ]],
];

function AccountSwitcher() {
  const { accountId, setAccountId } = useAccount();
  const { base } = useAccounts();
  if (base.length < 2) return null;
  const selected = base.some((a) => a.id === accountId)
    ? accountId
    : (base.find((a) => a.isDefault)?.id ?? base[0].id);
  return (
    <select
      className="account-switcher"
      value={selected}
      onChange={(e) => setAccountId(Number(e.target.value))}
      aria-label="Account"
      title="Which account you're viewing"
    >
      {base.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
    </select>
  );
}

function InstanceBadge() {
  const { label } = useInstance();
  if (!label) return null;
  // title carries the full label to assistive tech / hover when the pill
  // truncates visually (styles.css caps its width); still plain text, not a
  // control - no tabindex/role added, so it stays out of the tab order.
  return <span className="badge instance-badge" title={label}>{label}</span>;
}

function Shell({ children }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === '1');

  useEffect(() => { setNavOpen(false); }, [location]);

  // The Admin section only shows up for the session's own account - admin
  // status here is purely a UX shortcut; the server re-derives and enforces
  // it independently on every /api/admin/* request.
  const navSections = user.isAdmin
    ? [...NAV_SECTIONS, ['Admin', [['/admin', 'Admin', ShieldIcon]]]]
    : NAV_SECTIONS;

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      localStorage.setItem('sidebarCollapsed', c ? '0' : '1');
      return !c;
    });
  };

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
    navigate('/login');
  };

  const title = PAGE_TITLES.find(([prefix]) => location.pathname.startsWith(prefix))?.[1] ?? 'Dashboard';

  return (
    <div className="shell">
      <aside className={`sidebar ${navOpen ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-brand">
          <span className="brand-group">
            <Link to="/" className="brand">Pay<span>Cycle</span></Link>
            <InstanceBadge />
          </span>
          <button
            className="btn btn-ghost collapse-btn"
            title={collapsed ? 'Expand sidebar' : 'Minimize sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Minimize sidebar'}
            aria-expanded={!collapsed}
            onClick={toggleCollapsed}
          >
            <CollapseIcon />
          </button>
        </div>
        <nav aria-label="Main">
          {navSections.map(([section, items]) => (
            <React.Fragment key={section}>
              <div className="nav-label">{section}</div>
              {items.map(([to, label, Glyph, extra]) => (
                <NavLink key={to} className="nav-item" to={to} title={label} {...extra}>
                  <Glyph /><span>{label}</span>
                </NavLink>
              ))}
            </React.Fragment>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user-chip">
            <div className="user-email" title={user.email}>{user.email}</div>
            {user.household?.name && <div className="muted small">{user.household.name}</div>}
          </div>
          <button className="btn btn-ghost" title="Sign out" onClick={logout}>
            <SignOutIcon /><span>Sign out</span>
          </button>
        </div>
      </aside>
      <button className="backdrop" aria-label="Close menu" onClick={() => setNavOpen(false)} tabIndex={navOpen ? 0 : -1} />
      <div className="main">
        <header className="content-header">
          <button className="btn btn-ghost menu-btn" aria-label="Open menu" onClick={() => setNavOpen(true)}>
            <MenuIcon />
          </button>
          <h1 className="page-title">{title}</h1>
          <div className="header-actions">
            <AccountSwitcher />
            <ThemeToggle />
            <NotificationsBell />
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [accountId, setAccountIdState] = useState(() => {
    const v = Number(localStorage.getItem('selectedAccountId'));
    return Number.isInteger(v) && v > 0 ? v : null;
  });

  const setAccountId = useCallback((id) => {
    setAccountIdState(id || null);
    if (id) localStorage.setItem('selectedAccountId', String(id));
    else localStorage.removeItem('selectedAccountId');
  }, []);

  const [themeMode, setThemeModeState] = useState(() => localStorage.getItem('theme') || 'system');
  const setThemeMode = useCallback((mode) => {
    setThemeModeState(mode);
    if (mode === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', mode);
    applyTheme(mode);
  }, []);
  useEffect(() => {
    applyTheme(themeMode);
    if (themeMode !== 'system') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [themeMode]);

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

  // Instance branding applies pre- and post-login, so it's fetched once here
  // rather than tied to auth state. A failed/empty response is a no-op - the
  // static index.html defaults (title "PayCycle", static /icon.svg) stand.
  const [instance, setInstance] = useState({ label: '', color: '' });
  useEffect(() => {
    api('/auth/config').then((data) => {
      const inst = data.instance || { label: '', color: '' };
      setInstance(inst);
      applyInstanceBranding(inst);
    }).catch(() => {});
  }, []);

  if (loading) return <div className="page-loading">Loading…</div>;

  const ctx = { user, setUser, refreshUser, registrationOpen };

  return (
    <AuthContext.Provider value={ctx}>
      <ThemeContext.Provider value={{ themeMode, setThemeMode }}>
      <InstanceContext.Provider value={instance}>
      <AccountContext.Provider value={{ accountId, setAccountId }}>
      {!user ? (
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/forgot" element={<ForgotPassword />} />
          <Route path="/reset" element={<ResetPassword />} />
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
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/import" element={<Import />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/admin" element={user.isAdmin ? <Admin /> : <Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      )}
      </AccountContext.Provider>
      </InstanceContext.Provider>
      </ThemeContext.Provider>
    </AuthContext.Provider>
  );
}
