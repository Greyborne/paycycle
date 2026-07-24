import { Router } from 'express';
import { pool, q } from '../db.js';
import { bad, requireCents, requireDate, requireId } from '../validation.js';
import {
  getConfig, loadTemplates, effectiveAmount, ensureMaterialized, getDefaultAccountId, setAmountGoingForward,
} from '../services/budget.js';
import { periodContaining, todayISO } from '../services/schedule.js';

const router = Router();

function publicTemplate(t) {
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    categoryType: t.category_type,
    recurrence: t.recurrence,
    dueDay: t.due_day,
    accountId: t.account_id,
    startDate: t.start_date,
    endDate: t.end_date,
    archived: t.archived,
    sortOrder: t.sort_order,
    currentAmountCents: effectiveAmount(t.history, todayISO()),
    history: t.history.map((h) => ({
      id: h.id,
      amountCents: h.amount_cents,
      effectiveStartDate: h.effective_start_date,
    })),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const templates = await loadTemplates(req.budget.id, { includeArchived: true });
    res.json({ categories: templates.map(publicTemplate) });
  } catch (err) {
    next(err);
  }
});

function validateRecurrence(body) {
  const recurrence = body.recurrence === 'monthly' ? 'monthly' : 'every_period';
  let dueDay = null;
  if (recurrence === 'monthly') {
    dueDay = body.dueDay;
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) bad('dueDay must be a day of month (1-31)');
  }
  return { recurrence, dueDay };
}

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { name, type } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) bad('name is required');
    if (!['expense', 'income'].includes(type)) bad('type must be expense or income');
    const categoryType = req.body.categoryType === 'tag' ? 'tag' : 'recurring';
    const { recurrence, dueDay } = categoryType === 'tag'
      ? { recurrence: 'every_period', dueDay: null } // inert for tags
      : validateRecurrence(req.body);
    const amount = requireCents(req.body.amountCents ?? 0, 'amountCents');
    // Resolve the owning account (explicit or the default) so the category
    // can inherit its start date.
    let accountId = null;
    let account = null;
    if (req.body.accountId !== undefined && req.body.accountId !== null) {
      const { rows: acct } = await q(
        'SELECT id, started_on::text AS started_on FROM accounts WHERE id = $1 AND budget_id = $2 AND currency IS NULL',
        [req.body.accountId, req.budget.id]
      );
      if (!acct.length) bad('Categories can only clear to household-currency accounts');
      accountId = acct[0].id;
      account = acct[0];
    } else {
      const { rows: def } = await q(
        `SELECT id, started_on::text AS started_on FROM accounts
         WHERE budget_id = $1 AND is_default AND NOT archived AND currency IS NULL`,
        [req.budget.id]
      );
      account = def[0] || null;
    }
    const cfg = await getConfig(req.budget.id);
    // Valid-from defaults to the account's start date, so the category only
    // applies from when tracking began for that account.
    const startDate = req.body.startDate
      ? requireDate(req.body.startDate, 'startDate')
      : (account?.started_on ?? null);
    // The first amount takes effect from the category's start (or the current
    // period, if the account has no start date), so its tracked periods are
    // populated.
    const defaultEffective = startDate
      ?? (cfg ? periodContaining(cfg, todayISO()).start : todayISO());
    const effective = req.body.effectiveStartDate
      ? requireDate(req.body.effectiveStartDate, 'effectiveStartDate')
      : defaultEffective;

    await client.query('BEGIN');
    const { rows: maxOrder } = await client.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM category_templates WHERE budget_id = $1 AND type = $2',
      [req.budget.id, type]
    );
    const { rows } = await client.query(
      `INSERT INTO category_templates (budget_id, name, type, recurrence, due_day, sort_order, account_id, category_type, start_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [req.budget.id, name.trim(), type, recurrence, dueDay, maxOrder[0].next, accountId, categoryType, startDate]
    );
    // Tags have no planned amount, so no amount history either.
    if (categoryType !== 'tag') {
      await client.query(
        'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, $2, $3)',
        [rows[0].id, amount, effective]
      );
    }
    await client.query('COMMIT');

    if (cfg) await ensureMaterialized(req.budget.id, cfg); // adds the line item to the current period
    const templates = await loadTemplates(req.budget.id, { includeArchived: true });
    res.status(201).json({ category: publicTemplate(templates.find((t) => t.id === rows[0].id)) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = requireId(req.params.id, 'category');
    const { rows: existing } = await q(
      'SELECT * FROM category_templates WHERE id = $1 AND budget_id = $2', [id, req.budget.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Category not found' });

    const t = existing[0];
    const body = req.body || {};
    const name = body.name !== undefined
      ? (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : bad('name cannot be empty'))
      : t.name;
    let recurrence = t.recurrence;
    let dueDay = t.due_day;
    if (body.recurrence !== undefined || body.dueDay !== undefined) {
      ({ recurrence, dueDay } = validateRecurrence({
        recurrence: body.recurrence ?? t.recurrence,
        dueDay: body.dueDay ?? t.due_day,
      }));
    }
    const startDate = body.startDate !== undefined
      ? (body.startDate === null ? null : requireDate(body.startDate, 'startDate'))
      : t.start_date;
    const endDate = body.endDate !== undefined
      ? (body.endDate === null ? null : requireDate(body.endDate, 'endDate'))
      : t.end_date;
    const archived = body.archived !== undefined ? Boolean(body.archived) : t.archived;
    let categoryType = t.category_type;
    if (body.categoryType !== undefined && body.categoryType !== t.category_type) {
      if (!['recurring', 'tag'].includes(body.categoryType)) bad('categoryType must be recurring or tag');
      categoryType = body.categoryType;
    }
    let accountId = t.account_id;
    if (body.accountId !== undefined) {
      if (body.accountId === null) {
        accountId = null;
      } else {
        const { rows: acct } = await q(
          'SELECT id FROM accounts WHERE id = $1 AND budget_id = $2 AND currency IS NULL',
          [body.accountId, req.budget.id]
        );
        if (!acct.length) bad('Categories can only clear to household-currency accounts');
        accountId = body.accountId;
      }
    }

    await q(
      `UPDATE category_templates SET name = $1, recurrence = $2, due_day = $3, start_date = $4,
         end_date = $5, archived = $6, account_id = $7, category_type = $9 WHERE id = $8`,
      [name, recurrence, dueDay, startDate, endDate, archived, accountId, id, categoryType]
    );
    // Converting a recurring category to a tag withdraws its pending plan:
    // uncleared line items in open periods disappear (cleared history stays,
    // closed periods are never touched). Tag -> recurring starts planning at
    // $0 until an amount is recorded.
    if (categoryType === 'tag' && t.category_type === 'recurring') {
      await q(
        `DELETE FROM line_items li USING pay_periods pp
         WHERE pp.id = li.pay_period_id AND li.category_template_id = $1
           AND NOT li.cleared AND pp.closed_at IS NULL`,
        [id]
      );
    }
    const templates = await loadTemplates(req.budget.id, { includeArchived: true });
    res.json({ category: publicTemplate(templates.find((x) => x.id === id)) });
  } catch (err) {
    next(err);
  }
});

// Record a new effective-dated amount ("electric is $260 starting Aug 1").
// Same-date entries overwrite (correction); different dates append history.
router.post('/:id/amounts', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = requireId(req.params.id, 'category');
    const { rows: existing } = await q(
      'SELECT id, account_id FROM category_templates WHERE id = $1 AND budget_id = $2', [id, req.budget.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Category not found' });
    const amount = requireCents(req.body?.amountCents, 'amountCents');
    const effective = requireDate(req.body?.effectiveStartDate || todayISO(), 'effectiveStartDate');
    // Reprice with the template's OWN account's pay-period cfg, not the
    // household default (mirrors import.js's cfgForTemplate) - otherwise
    // future periods get walked against the wrong account's period
    // boundaries.
    const defaultAccountId = await getDefaultAccountId(req.budget.id);
    const acctId = existing[0].account_id ?? defaultAccountId;
    const cfg = await getConfig(req.budget.id, acctId);
    if (!cfg) bad('Complete setup first');

    await client.query('BEGIN');
    // setAmountGoingForward both appends the history row (same
    // insert-or-correct-on-same-date semantics as before) and walks every
    // non-closed materialized period from the effective date forward,
    // updating planned_amount_cents/line items - so no separate history
    // insert is needed here.
    await setAmountGoingForward(client, req.budget.id, cfg, id, amount, effective);
    await client.query('COMMIT');

    const templates = await loadTemplates(req.budget.id, { includeArchived: true });
    res.status(201).json({ category: publicTemplate(templates.find((t) => t.id === id)) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id/amounts/:historyId', async (req, res, next) => {
  try {
    const id = requireId(req.params.id, 'category');
    const historyId = requireId(req.params.historyId, 'amount entry');
    const { rows: count } = await q(
      `SELECT COUNT(*) AS n FROM category_amount_history h
       JOIN category_templates t ON t.id = h.category_template_id
       WHERE t.id = $1 AND t.budget_id = $2`,
      [id, req.budget.id]
    );
    if (Number(count[0].n) <= 1) bad('A category must keep at least one amount entry');
    const { rowCount } = await q(
      `DELETE FROM category_amount_history h USING category_templates t
       WHERE h.id = $1 AND h.category_template_id = t.id AND t.id = $2 AND t.budget_id = $3`,
      [historyId, id, req.budget.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Amount entry not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Reorder within one type: body { type, ids: [templateId, ...] } in the new order.
router.post('/reorder', async (req, res, next) => {
  try {
    const { type, ids } = req.body || {};
    if (!['expense', 'income'].includes(type)) bad('type must be expense or income');
    if (!Array.isArray(ids) || !ids.every(Number.isInteger)) bad('ids must be an array of category ids');
    for (let i = 0; i < ids.length; i++) {
      await q(
        'UPDATE category_templates SET sort_order = $1 WHERE id = $2 AND budget_id = $3 AND type = $4',
        [i, ids[i], req.budget.id, type]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
