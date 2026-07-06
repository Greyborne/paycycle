import { Router } from 'express';
import { q } from '../db.js';
import { bad } from '../validation.js';
import { notificationsForUser } from '../services/notifications.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    res.json({ notifications: await notificationsForUser(req.userId, req.budget) });
  } catch (err) {
    next(err);
  }
});

router.post('/dismiss', async (req, res, next) => {
  try {
    const key = req.body?.key;
    if (typeof key !== 'string' || !key || key.length > 200) bad('key is required');
    await q(
      'INSERT INTO notification_dismissals (user_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.userId, key]
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
