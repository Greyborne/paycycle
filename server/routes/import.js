import crypto from 'node:crypto';
import { Router } from 'express';
import { pool, q } from '../db.js';
import { bad, requireCents, requireDate } from '../validation.js';
import { getConfig, ensureMaterialized, loadTemplates, getDefaultAccountId } from '../services/budget.js';

const router = Router();

function rowHash(userRow) {
  return crypto.createHash('sha256')
    .update(`${userRow.date}|${userRow.amountCents}|${(userRow.description || '').trim().toLowerCase()}`)
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

// Suggest categorization for parsed CSV rows before committing. For each row:
// duplicate detection (already-imported hash) and a suggested category —
// learned import rules first, then category-name substring match.
router.post('/preview', async (req, res, next) => {
  try {
    const rows = req.body?.rows;
    validateRows(rows);
    const [templates, { rows: rules }, { rows: existing }] = await Promise.all([
      loadTemplates(req.budget.id),
      q('SELECT * FROM import_rules WHERE budget_id = $1 ORDER BY length(pattern) DESC', [req.budget.id]),
      q('SELECT import_hash FROM transactions WHERE budget_id = $1 AND import_hash IS NOT NULL', [req.budget.id]),
    ]);
    const seen = new Set(existing.map((r) => r.import_hash));
    const activeTemplates = templates.filter((t) => !t.archived);

    const preview = rows.map((r) => {
      const hash = rowHash(r);
      const desc = (r.description || '').toLowerCase();
      let suggested = null;
      let matchedBy = null;
      for (const rule of rules) {
        if (desc.includes(rule.pattern.toLowerCase())) {
          suggested = rule.category_template_id;
          matchedBy = 'rule';
          break;
        }
      }
      if (!suggested) {
        const byName = activeTemplates.find((t) => desc.includes(t.name.toLowerCase()));
        if (byName) {
          suggested = byName.id;
          matchedBy = 'name';
        }
      }
      const duplicate = seen.has(hash);
      seen.add(hash); // also catches duplicates within the same file
      return { ...r, duplicate, suggestedCategoryId: suggested, matchedBy };
    });
    res.json({ rows: preview });
  } catch (err) {
    next(err);
  }
});

// Commit an import. Each row: { date, description, amountCents,
// categoryTemplateId (null = misc), rulePattern (optional: learn this
// substring -> category) }. Options: updatePlanned — when a row is linked to
// a category, set that period's line item to the actual amount as well as
// marking it cleared (mirrors typing the actual figure into the spreadsheet).
router.post('/commit', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const rows = req.body?.rows;
    validateRows(rows);
    const updatePlanned = req.body.updatePlanned !== false;
    const cfg = await getConfig(req.budget.id);
    if (!cfg) bad('Complete setup first');

    // The statement being imported belongs to one bank account.
    let accountId = req.body.accountId;
    if (accountId !== undefined && accountId !== null) {
      const { rows } = await q(
        'SELECT id FROM accounts WHERE id = $1 AND budget_id = $2 AND currency IS NULL',
        [accountId, req.budget.id]
      );
      if (!rows.length) bad('Statements can only be imported into household-currency accounts');
    } else {
      accountId = await getDefaultAccountId(req.budget.id);
    }

    await ensureMaterialized(req.budget.id, cfg);

    const templates = await loadTemplates(req.budget.id, { includeArchived: true });
    const templateById = new Map(templates.map((t) => [t.id, t]));

    const results = { imported: 0, duplicates: 0, skipped: 0, linked: 0 };
    await client.query('BEGIN');
    for (const r of rows) {
      const catId = r.categoryTemplateId ?? null;
      if (catId !== null && !templateById.has(catId)) bad(`Unknown category id ${catId}`);
      const amount = Math.abs(r.amountCents);
      if (amount === 0) continue;
      const type = catId !== null
        ? templateById.get(catId).type
        : (r.amountCents < 0 ? 'expense' : (r.type === 'expense' ? 'expense' : 'income'));

      const { rows: period } = await client.query(
        'SELECT id FROM pay_periods WHERE budget_id = $1 AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1',
        [req.budget.id, r.date]
      );
      if (!period.length) {
        // Future dates, or dates before the account's first recorded period.
        results.skipped += 1;
        continue;
      }

      const { rows: inserted } = await client.query(
        `INSERT INTO transactions (budget_id, user_id, pay_period_id, category_template_id, type, amount_cents, description, date, import_hash, account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (budget_id, import_hash) WHERE import_hash IS NOT NULL DO NOTHING
         RETURNING id`,
        [req.budget.id, req.userId, period[0].id, catId, type, amount,
         (r.description || '').trim() || null, r.date, rowHash(r), accountId]
      );
      if (!inserted.length) {
        results.duplicates += 1;
        continue;
      }
      results.imported += 1;

      if (catId !== null) {
        // The bank row is evidence the planned item posted: mark it cleared
        // (and optionally snap the planned amount to the actual figure).
        const { rowCount } = await client.query(
          `UPDATE line_items SET cleared = TRUE, cleared_date = $1, account_id = $4
             ${updatePlanned ? ', planned_amount_cents = $5' : ''}
           WHERE pay_period_id = $2 AND category_template_id = $3`,
          updatePlanned ? [r.date, period[0].id, catId, accountId, amount] : [r.date, period[0].id, catId, accountId]
        );
        if (rowCount) results.linked += 1;
        if (r.rulePattern && typeof r.rulePattern === 'string' && r.rulePattern.trim()) {
          await client.query(
            `INSERT INTO import_rules (budget_id, pattern, category_template_id) VALUES ($1, $2, $3)
             ON CONFLICT (budget_id, pattern) DO UPDATE SET category_template_id = $3`,
            [req.budget.id, r.rulePattern.trim(), catId]
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
