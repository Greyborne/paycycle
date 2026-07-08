import crypto from 'node:crypto';
import { Router } from 'express';
import { pool, q } from '../db.js';
import { bad, requireCents, requireDate } from '../validation.js';
import {
  getConfig, ensureMaterialized, loadTemplates, getDefaultAccountId, driftFor,
  clearLineItemForTransaction, setAmountGoingForward,
} from '../services/budget.js';
import { loadRules, firstMatchingCategory } from '../services/rules.js';

const router = Router();

// Dedup key: the bank's own transaction id when the mapping step identified
// one, else a hash of date|amount|normalized description.
function dedupKey(row) {
  if (row.bankId && String(row.bankId).trim()) return `bank:${String(row.bankId).trim()}`;
  return crypto.createHash('sha256')
    .update(`${row.date}|${row.amountCents}|${(row.description || '').trim().toLowerCase().replace(/\s+/g, ' ')}`)
    .digest('hex');
}

function validateRows(rows) {
  if (!Array.isArray(rows) || !rows.length) bad('rows must be a non-empty array');
  if (rows.length > 2000) bad('At most 2000 rows per import');
  for (const r of rows) {
    requireDate(r.date, 'date');
    requireCents(r.amountCents, 'amountCents');
  }
}

async function accountForImport(budgetId, accountId) {
  if (accountId !== undefined && accountId !== null) {
    const { rows } = await q(
      'SELECT * FROM accounts WHERE id = $1 AND budget_id = $2 AND currency IS NULL',
      [accountId, budgetId]
    );
    if (!rows.length) bad('Statements can only be imported into household-currency accounts');
    return rows[0];
  }
  const id = await getDefaultAccountId(budgetId);
  const { rows } = await q('SELECT * FROM accounts WHERE id = $1', [id]);
  return rows[0];
}

// Suggest categorization for parsed CSV rows before committing: duplicate
// detection plus the categorization rules (first match in user order wins).
router.post('/preview', async (req, res, next) => {
  try {
    const rows = req.body?.rows;
    validateRows(rows);
    const account = await accountForImport(req.budget.id, req.body?.accountId);
    const [rules, { rows: existing }] = await Promise.all([
      loadRules(req.budget.id),
      q('SELECT import_hash FROM transactions WHERE budget_id = $1 AND import_hash IS NOT NULL', [req.budget.id]),
    ]);
    const seen = new Set(existing.map((r) => r.import_hash));

    const preview = rows.map((r) => {
      const key = dedupKey(r);
      const suggested = firstMatchingCategory(rules, {
        description: r.description,
        amountCents: r.amountCents,
        account,
      });
      const duplicate = seen.has(key);
      seen.add(key); // also catches duplicates within the same file
      return {
        ...r,
        duplicate,
        suggestedCategoryId: suggested,
        matchedBy: suggested ? 'rule' : null,
      };
    });
    res.json({ rows: preview });
  } catch (err) {
    next(err);
  }
});

// Commit an import. Each row: { date, description, amountCents, bankId?,
// categoryTemplateId (null = uncategorized), categorizedBy ('rule' when an
// auto-suggestion was kept, 'manual' when the user picked), rulePattern?
// (learn this substring -> category as a new rule) }. updatePlanned: a
// recurring match also snaps that period's line item to the actual amount.
router.post('/commit', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const rows = req.body?.rows;
    validateRows(rows);
    const updatePlanned = req.body.updatePlanned !== false;
    const cfg = await getConfig(req.budget.id);
    if (!cfg) bad('Complete setup first');

    const account = await accountForImport(req.budget.id, req.body.accountId);
    await ensureMaterialized(req.budget.id, cfg);

    const templates = await loadTemplates(req.budget.id, { includeArchived: true });
    const templateById = new Map(templates.map((t) => [t.id, t]));

    const results = {
      imported: 0, duplicates: 0, skipped: 0, linked: 0, moved: 0, autoCategorized: 0, needReview: 0,
      replanned: 0, drift: [],
    };
    await client.query('BEGIN');
    for (const r of rows) {
      const catId = r.categoryTemplateId ?? null;
      const template = catId !== null ? templateById.get(catId) : null;
      if (catId !== null && !template) bad(`Unknown category id ${catId}`);
      const amount = Math.abs(r.amountCents);
      if (amount === 0) continue;
      const type = template
        ? template.type
        : (r.amountCents < 0 ? 'expense' : (r.type === 'expense' ? 'expense' : 'income'));

      const { rows: period } = await client.query(
        'SELECT id, closed_at FROM pay_periods WHERE budget_id = $1 AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1',
        [req.budget.id, r.date]
      );
      if (!period.length || period[0].closed_at) {
        // Future dates, pre-history, or a closed (frozen) period.
        results.skipped += 1;
        continue;
      }

      const categorizedBy = catId === null ? null : (r.categorizedBy === 'rule' ? 'rule' : 'manual');
      const { rows: inserted } = await client.query(
        `INSERT INTO transactions (budget_id, user_id, pay_period_id, category_template_id, type, amount_cents, description, date, import_hash, account_id, categorized_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (budget_id, import_hash) WHERE import_hash IS NOT NULL DO NOTHING
         RETURNING id`,
        [req.budget.id, req.userId, period[0].id, catId, type, amount,
         (r.description || '').trim() || null, r.date, dedupKey(r), account.id, categorizedBy]
      );
      if (!inserted.length) {
        results.duplicates += 1;
        continue;
      }
      results.imported += 1;
      if (catId === null) results.needReview += 1;
      else if (categorizedBy === 'rule') results.autoCategorized += 1;

      if (template && template.category_type === 'recurring') {
        // The bank row is evidence the planned item posted: mark it cleared
        // (and optionally snap the planned amount to the actual figure). A
        // bill that posted in the period after it was planned moves forward.
        const drift = driftFor(req.budget, template, amount, r.date);
        const { cleared, moved } = await clearLineItemForTransaction(client, template, {
          periodId: period[0].id,
          date: r.date,
          amountCents: amount,
          accountId: account.id,
          updatePlanned,
        });
        if (cleared) results.linked += 1;
        if (moved) results.moved += 1;
        // A material difference from plan auto-updates the recurring amount
        // going forward (when updating planned amounts is enabled).
        if (drift && updatePlanned) {
          await setAmountGoingForward(client, req.budget.id, cfg, template.id, amount, r.date);
          results.drift.push(drift);
          results.replanned += 1;
        }
      }
      if (catId !== null && r.rulePattern && typeof r.rulePattern === 'string' && r.rulePattern.trim()) {
        const pattern = r.rulePattern.trim();
        const { rows: dup } = await client.query(
          `SELECT id FROM category_rules WHERE budget_id = $1 AND category_template_id = $2
             AND lower(description_contains) = lower($3)`,
          [req.budget.id, catId, pattern]
        );
        if (!dup.length) {
          await client.query(
            `INSERT INTO category_rules (budget_id, category_template_id, sort_order, description_contains, notes)
             VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM category_rules WHERE budget_id = $1), $3, 'Learned during import')`,
            [req.budget.id, catId, pattern]
          );
        }
      }
    }
    await client.query('COMMIT');
    res.json(results);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

export default router;
