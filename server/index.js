import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { pool } from './db.js';
import { waitForDb, migrate } from './migrate.js';
import { requireAuth, requireAdmin, attachBudget } from './auth.js';
import { getMembership } from './services/budget.js';
import { startEmailScheduler } from './services/mailer.js';
import { HttpError } from './validation.js';
import authRoutes from './routes/auth.js';
import setupRoutes from './routes/setup.js';
import dashboardRoutes from './routes/dashboard.js';
import periodRoutes from './routes/periods.js';
import categoryRoutes from './routes/categories.js';
import transactionRoutes from './routes/transactions.js';
import settingsRoutes from './routes/settings.js';
import importRoutes from './routes/import.js';
import reportRoutes from './routes/reports.js';
import householdRoutes from './routes/household.js';
import accountRoutes from './routes/accounts.js';
import notificationRoutes from './routes/notifications.js';
import simplefinRoutes from './routes/simplefin.js';
import ruleRoutes from './routes/rules.js';
import adminRoutes from './routes/admin.js';

const app = express();
app.set('trust proxy', config.trustProxy);
app.use(express.json());
app.use(cookieParser());

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'database unavailable' });
  }
});

// Blast-radius cap for the authenticated financial API, distinct in purpose
// (and in key) from authRoutes' authLimiter. That one guards credential
// endpoints against brute force and is keyed by IP. This one guards routes
// that are already behind requireAuth - the risk here isn't a credential
// attacker, it's cost: buildProjection (services/budget.js) walks 12-24
// months of periods per call and the reports year-walk (routes/reports.js)
// loops up to 400 iterations, so a runaway retry loop or a buggy frontend
// effect on one account can generate real database load.
//
// Keyed by the authenticated user id, NOT by IP. These routes only ever run
// after requireAuth, so req.userId (set there - see auth.js) is always
// populated in practice; the IP fallback below only matters for a
// theoretical request that reaches this middleware without it. Keying by IP
// instead would put every member of a household, and everyone behind a
// shared NAT or corporate egress, in one shared bucket - one person's
// dashboard-refresh habit would throttle their partner. Per-user keying
// means the cap actually tracks the client generating the load.
//
// The ceiling is intentionally generous and NOT configurable via env var
// (boss decision: every deployment gets this protection with no config
// surface to document or get wrong). 300 requests / 15 min is roughly 20x a
// full dashboard load's worth of calls (dashboard + periods + accounts list
// typically fire well under 15 requests together) - normal use, including
// switching between periods/reports/accounts repeatedly, should never come
// close to it. It exists to stop a loop, not to throttle a person.
//
// Storage note: this uses express-rate-limit's default in-memory store,
// which is per-process. That's correct for the current single-container
// deployment (the cap applies per instance), but it means the ceiling is NOT
// shared across replicas if this is ever scaled horizontally - revisit with
// a shared store (e.g. Redis) if that happens.
const financialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.userId ? `user:${req.userId}` : req.ip),
  message: { error: 'Too many requests, please slow down and try again shortly' },
});

// /api/import and /api/simplefin deliberately get no separate allowance or
// exemption. A CSV import is one POST regardless of row count (up to 2000
// rows validated server-side in routes/import.js) - it doesn't burst into
// many requests - and a SimpleFIN claim/sync flow is a handful of calls.
// Neither pattern comes close to the shared ceiling above, so a bespoke
// bucket would add complexity without addressing a real burst risk.
const budgetScoped = [requireAuth, financialLimiter, attachBudget(getMembership)];

app.use('/api/auth', authRoutes);
app.use('/api/setup', budgetScoped, setupRoutes);
app.use('/api/dashboard', budgetScoped, dashboardRoutes);
app.use('/api/periods', budgetScoped, periodRoutes);
app.use('/api/categories', budgetScoped, categoryRoutes);
app.use('/api/transactions', budgetScoped, transactionRoutes);
app.use('/api/settings', budgetScoped, settingsRoutes);
app.use('/api/import', budgetScoped, importRoutes);
app.use('/api/reports', budgetScoped, reportRoutes);
app.use('/api/household', budgetScoped, householdRoutes);
app.use('/api/accounts', budgetScoped, accountRoutes);
app.use('/api/notifications', budgetScoped, notificationRoutes);
app.use('/api/simplefin', budgetScoped, simplefinRoutes);
app.use('/api/rules', budgetScoped, ruleRoutes);
app.use('/api/admin', requireAuth, requireAdmin, adminRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Static SPA bundle (built by Vite into web/dist), with history fallback.
const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
app.use(express.static(distDir));
app.get('*', (req, res) => res.sendFile(path.join(distDir, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

await waitForDb();
await migrate();
try {
  const { backfillClosedSnapshots } = await import('./services/budget.js');
  const n = await backfillClosedSnapshots();
  if (n) console.log(`[paycycle] froze cleared-balance snapshots for ${n} closed period(s)`);
} catch (err) {
  console.error('[paycycle] snapshot backfill failed:', err);
}
app.listen(config.port, () => {
  console.log(`[paycycle] listening on port ${config.port}`);
});
startEmailScheduler();
