import { Router } from 'express';
import { q } from '../db.js';
import { config } from '../config.js';

const router = Router();

// List every user with their household. Read-only (increment 2a). Never
// selects or returns password_hash.
router.get('/users', async (req, res, next) => {
  try {
    const { rows } = await q(`
      SELECT u.id, u.email, u.created_at,
             b.id AS budget_id, b.name AS household, m.role,
             (SELECT count(*)::int FROM budget_members m2 WHERE m2.budget_id = b.id) AS household_size
      FROM users u
      LEFT JOIN budget_members m ON m.user_id = u.id
      LEFT JOIN budgets b ON b.id = m.budget_id
      ORDER BY u.created_at
    `);
    const users = rows.map((r) => ({
      id: r.id,
      email: r.email,
      createdAt: r.created_at,
      household: r.household,
      role: r.role,
      householdSize: r.household_size,
      isAdmin: config.adminEmails.includes(String(r.email).toLowerCase()),
      isSelf: r.id === req.userId,
    }));
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

export default router;
