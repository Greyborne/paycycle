import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, addMonths, daysBetween, monthlyOccurrences, periodAfter, periodBefore, periodContaining,
} from '../services/schedule.js';
import { effectiveAmount, plannedForPeriod } from '../services/budget.js';

test('date helpers', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29'); // leap year
  assert.equal(daysBetween('2026-01-01', '2026-01-15'), 14);
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
});

test('biweekly periods anchor correctly', () => {
  const cfg = { cadence: 'biweekly', anchor_date: '2026-06-26' };
  assert.deepEqual(periodContaining(cfg, '2026-07-05'), { start: '2026-06-26', end: '2026-07-09' });
  assert.deepEqual(periodContaining(cfg, '2026-07-10'), { start: '2026-07-10', end: '2026-07-23' });
  // Dates before the anchor still resolve (schedule extends backwards).
  assert.deepEqual(periodContaining(cfg, '2026-06-20'), { start: '2026-06-12', end: '2026-06-25' });
  const p = periodContaining(cfg, '2026-07-05');
  assert.deepEqual(periodAfter(cfg, p), { start: '2026-07-10', end: '2026-07-23' });
  assert.deepEqual(periodBefore(cfg, p), { start: '2026-06-12', end: '2026-06-25' });
});

test('weekly and custom intervals', () => {
  const weekly = { cadence: 'weekly', anchor_date: '2026-07-03' };
  assert.deepEqual(periodContaining(weekly, '2026-07-09'), { start: '2026-07-03', end: '2026-07-09' });
  const custom = { cadence: 'custom', anchor_date: '2026-01-01', interval_days: 10 };
  assert.deepEqual(periodContaining(custom, '2026-01-10'), { start: '2026-01-01', end: '2026-01-10' });
  assert.deepEqual(periodContaining(custom, '2026-01-11'), { start: '2026-01-11', end: '2026-01-20' });
});

test('semimonthly periods have variable lengths', () => {
  const cfg = { cadence: 'semimonthly', day_1: 1, day_2: 15 };
  assert.deepEqual(periodContaining(cfg, '2026-07-04'), { start: '2026-07-01', end: '2026-07-14' });
  assert.deepEqual(periodContaining(cfg, '2026-07-20'), { start: '2026-07-15', end: '2026-07-31' });
  // Feb: the 15th-to-1st stretch is short.
  assert.deepEqual(periodContaining(cfg, '2026-02-20'), { start: '2026-02-15', end: '2026-02-28' });
  // Chain covers the calendar with no gaps or overlaps.
  let p = periodContaining(cfg, '2026-01-01');
  for (let i = 0; i < 30; i++) {
    const next = periodAfter(cfg, p);
    assert.equal(next.start, addDays(p.end, 1));
    p = next;
  }
});

test('semimonthly clamps days into short months', () => {
  const cfg = { cadence: 'semimonthly', day_1: 15, day_2: 31 };
  // Feb 2026: day 31 clamps to Feb 28.
  assert.deepEqual(periodContaining(cfg, '2026-02-20'), { start: '2026-02-15', end: '2026-02-27' });
  assert.deepEqual(periodContaining(cfg, '2026-02-28'), { start: '2026-02-28', end: '2026-03-14' });
});

test('monthly periods anchored to day 31 clamp sanely', () => {
  const cfg = { cadence: 'monthly', day_1: 31 };
  assert.deepEqual(periodContaining(cfg, '2026-02-10'), { start: '2026-01-31', end: '2026-02-27' });
  assert.deepEqual(periodContaining(cfg, '2026-02-28'), { start: '2026-02-28', end: '2026-03-30' });
  let p = periodContaining(cfg, '2026-01-05');
  for (let i = 0; i < 24; i++) {
    const next = periodAfter(cfg, p);
    assert.equal(next.start, addDays(p.end, 1));
    p = next;
  }
});

test('monthly occurrences within a range', () => {
  assert.deepEqual(monthlyOccurrences(5, '2026-07-01', '2026-07-14'), ['2026-07-05']);
  assert.deepEqual(monthlyOccurrences(5, '2026-07-06', '2026-07-20'), []);
  assert.deepEqual(monthlyOccurrences(31, '2026-02-01', '2026-02-28'), ['2026-02-28']);
  // Long window catches two occurrences.
  assert.deepEqual(monthlyOccurrences(5, '2026-07-01', '2026-08-31'), ['2026-07-05', '2026-08-05']);
});

test('effective-dated amounts pick the right value per date', () => {
  const history = [
    { amount_cents: 25000, effective_start_date: '2026-01-01' },
    { amount_cents: 26000, effective_start_date: '2026-08-01' },
  ];
  assert.equal(effectiveAmount(history, '2026-07-31'), 25000);
  assert.equal(effectiveAmount(history, '2026-08-01'), 26000);
  assert.equal(effectiveAmount(history, '2027-01-01'), 26000);
  // Before the first record: fall back to the earliest amount.
  assert.equal(effectiveAmount(history, '2025-06-01'), 25000);
});

test('plannedForPeriod handles recurrence, windows, and archival', () => {
  const period = { start: '2026-07-10', end: '2026-07-23' };
  const hist = [{ amount_cents: 10000, effective_start_date: '2026-01-01' }];
  const every = { recurrence: 'every_period', archived: false, start_date: null, end_date: null, history: hist };
  assert.equal(plannedForPeriod(every, period), 10000);
  assert.equal(plannedForPeriod({ ...every, archived: true }, period), null);
  assert.equal(plannedForPeriod({ ...every, start_date: '2026-08-01' }, period), null);
  assert.equal(plannedForPeriod({ ...every, end_date: '2026-07-01' }, period), null);

  const monthly = { ...every, recurrence: 'monthly', due_day: 15 };
  assert.equal(plannedForPeriod(monthly, period), 10000); // Jul 15 falls inside
  assert.equal(plannedForPeriod({ ...monthly, due_day: 5 }, period), null);
  // Amount change effective on the due date applies to that occurrence.
  const monthlyHist = [
    { amount_cents: 10000, effective_start_date: '2026-01-01' },
    { amount_cents: 12000, effective_start_date: '2026-07-15' },
  ];
  assert.equal(plannedForPeriod({ ...monthly, history: monthlyHist }, period), 12000);
});
