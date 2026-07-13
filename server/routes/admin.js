import { Router } from 'express';
import { pool, q } from '../db.js';
import { config } from '../config.js';

const router = Router();

async function logAdminAction(client, { actorId, actorEmail, action, targetId, targetEmail, detail }) {
  await client.query(
    `INSERT INTO admin_audit_log (actor_user_id, actor_email, action, target_user_id, target_email, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actorId, actorEmail, action, targetId, targetEmail, detail ? JSON.stringify(detail) : null]
  );
}

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

// Delete another user's account: transfers ownership if others remain in
// the household, or wipes the whole household (with an explicit confirm)
// if the target is its sole member. Guards against self-deletion and
// deleting an ADMIN_EMAILS admin. Every outcome is written to
// admin_audit_log in the same transaction.
router.delete('/users/:id', async (req, res, next) => {
  if (!/^[1-9][0-9]*$/.test(String(req.params.id))) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  const targetId = parseInt(req.params.id, 10);
  if (targetId === req.userId) {
    return res.status(400).json({ error: "You can't delete your own account here" });
  }

  const client = await pool.connect();
  try {
    const { rows: targetRows } = await client.query('SELECT id, email FROM users WHERE id = $1', [targetId]);
    if (!targetRows.length) return res.status(404).json({ error: 'User not found' });
    const target = targetRows[0];
    if (config.adminEmails.includes(String(target.email).toLowerCase())) {
      return res.status(400).json({ error: "Admins are managed via ADMIN_EMAILS and can't be deleted here" });
    }

    await client.query('BEGIN');
    const { rows: memberRows } = await client.query(
      'SELECT budget_id, role FROM budget_members WHERE user_id = $1',
      [targetId]
    );

    let mode = 'member';
    let newOwnerEmail = null;

    if (memberRows.length) {
      const { budget_id: budgetId, role } = memberRows[0];
      // Lock the budget row so a concurrent /household/join or /leave can't
      // slip a member in or out between our count and the conditional
      // cascade/transfer below (mirrors the onboarding account-delete lock).
      await client.query('SELECT id FROM budgets WHERE id = $1 FOR UPDATE', [budgetId]);
      const { rows: countRows } = await client.query(
        'SELECT count(*)::int AS n FROM budget_members WHERE budget_id = $1',
        [budgetId]
      );
      const householdSize = countRows[0].n;

      if (householdSize === 1) {
        if (req.body?.confirm !== true) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            needsConfirm: true,
            error: `This permanently deletes ${target.email}'s household and all its data.`,
          });
        }
        await client.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
        mode = 'cascade';
      } else if (role === 'owner') {
        // Promote the oldest remaining member to owner before the target
        // (and their membership row) is deleted below.
        const { rows: nextOwnerRows } = await client.query(
          `SELECT bm.user_id, u.email FROM budget_members bm
           JOIN users u ON u.id = bm.user_id
           WHERE bm.budget_id = $1 AND bm.user_id <> $2
           ORDER BY bm.created_at ASC LIMIT 1`,
          [budgetId, targetId]
        );
        if (nextOwnerRows.length) {
          await client.query(
            "UPDATE budget_members SET role = 'owner' WHERE budget_id = $1 AND user_id = $2",
            [budgetId, nextOwnerRows[0].user_id]
          );
          newOwnerEmail = nextOwnerRows[0].email;
        }
        mode = 'transfer';
      }
    }

    await client.query('DELETE FROM users WHERE id = $1', [targetId]);

    await logAdminAction(client, {
      actorId: req.userId,
      actorEmail: req.userEmail,
      action: 'delete_user',
      targetId,
      targetEmail: target.email,
      detail: mode === 'transfer' ? { mode, newOwner: newOwnerEmail } : { mode },
    });

    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

export default router;
