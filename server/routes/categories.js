import { Router } from 'express';
import { pool, q } from '../db.js';
import { bad, requireCents, requireDate } from '../validation.js';
import { getConfig, loadTemplates, effectiveAmount, ensureMaterialized } from '../services/budget.js';
import { periodContaining, todayISO } from '../services/schedule.js';

const router = Router();

function publicTemplate(t) {
  return {
    id: t.id,
    name: t.name,
    type: t.type,
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
    const { recurrence, dueDay } = validateRecurrence(req.body);
    const amount = requireCents(req.body.amountCents ?? 0, 'amountCents');
    let accountId = null;
    if (req.body.accountId !== undefined && req.body.accountId !== null) {
      const { rows: acct } = await q(
        'SELECT id FROM accounts WHERE id = $1 AND budget_id = $2', [req.body.accountId, req.budget.id]
      );
      if (!acct.length) bad('Unknown account');
      accountId = req.body.accountId;
    }
    // Default the first amount to be effective from the start of the current
    // period, so the category shows up in the period the user is looking at.
    const cfg = await getConfig(req.budget.id);
    const defaultEffective = cfg ? periodContaining(cfg, todayISO()).start : todayISO();
    const effective = req.body.effectiveStartDate
      ? requireDate(req.body.effectiveStartDate, 'effectiveStartDate')
      : defaultEffective;

    await client.query('BEGIN');
    const { rows: maxOrder } = await client.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM category_templates WHERE budget_id = $1 AND type = $2',
      [req.budget.id, type]
    );
    const { rows } = await client.query(
      `INSERT INTO category_templates (budget_id, name, type, recurrence, due_day, sort_order, account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.budget.id, name.trim(), type, recurrence, dueDay, maxOrder[0].next, accountId]
    );
    await client.query(
      'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, $2, $3)',
      [rows[0].id, amount, effective]
    );
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
    const id = Number(req.params.id);
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
    let accountId = t.account_id;
    if (body.accountId !== undefined) {
      if (body.accountId === null) {
        accountId = null;
      } else {
        const { rows: acct } = await q(
          'SELECT id FROM accounts WHERE id = $1 AND budget_id = $2', [body.accountId, req.budget.id]
        );
        if (!acct.length) bad('Unknown account');
        accountId = body.accountId;
      }
    }

    await q(
      `UPDATE category_templates SET name = $1, recurrence = $2, due_day = $3, start_date = $4,
         end_date = $5, archived = $6, account_id = $7 WHERE id = $8`,
      [name, recurrence, dueDay, startDate, endDate, archived, accountId, id]
    );
    const templates = await loadTemplates(req.budget.id, { includeArchived: true });
    res.json({ category: publicTemplate(templates.find((x) => x.id === id)) });
  } catch (err) {
    next(err);
  }
});

// Record a new effective-dated amount ("electric is $260 starting Aug 1").
// Same-date entries overwrite (correction); different dates append history.
router.post('/:id/amounts', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows: existing } = await q(
      'SELECT id FROM category_templates WHERE id = $1 AND budget_id = $2', [id, req.budget.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Category not found' });
    const amount = requireCents(req.body?.amountCents, 'amountCents');
    const effective = requireDate(req.body?.effectiveStartDate || todayISO(), 'effectiveStartDate');
    await q(
      `INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (category_template_id, effective_start_date) DO UPDATE SET amount_cents = $2`,
      [id, amount, effective]
    );
    const templates = await loadTemplates(req.budget.id, { includeArchived: true });
    res.status(201).json({ category: publicTemplate(templates.find((t) => t.id === id)) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/amounts/:historyId', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
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
      [Number(req.params.historyId), id, req.budget.id]
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
