import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
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
import plaidRoutes from './routes/plaid.js';
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

const budgetScoped = [requireAuth, attachBudget(getMembership)];

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
app.use('/api/plaid', budgetScoped, plaidRoutes);
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
  const { encryptLegacyTokens } = await import('./services/plaid.js');
  const enc = await encryptLegacyTokens();
  if (enc) console.log(`[paycycle] encrypted ${enc} legacy bank token(s)`);
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
