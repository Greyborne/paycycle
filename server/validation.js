import { isValidISO } from './services/schedule.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function bad(message) {
  throw new HttpError(400, message);
}

export function requireCents(value, label) {
  if (!Number.isInteger(value) || Math.abs(value) > 1e12) bad(`${label} must be an integer amount in cents`);
  return value;
}

// Validate a route-param id: must be a positive int32. Non-numeric strings,
// NaN, Infinity, non-integers, zero, negatives, and anything above
// PostgreSQL's int32 max all become a clean 400 rather than a DB-level 500.
export function requireId(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 2147483647) bad(`${label} must be a valid id`);
  return value;
}

export function requireDate(value, label) {
  if (!isValidISO(value)) bad(`${label} must be a valid YYYY-MM-DD date`);
  return value;
}

export function requireCurrency(value) {
  if (!/^[A-Za-z]{3}$/.test(value || '')) bad('currency must be a 3-letter ISO 4217 code');
  return value.toUpperCase();
}

function requireDayOfMonth(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 31) bad(`${label} must be a day of month (1-31)`);
  return value;
}

// Normalize + validate a pay-period cadence config from a request body into
// pay_period_configs column values.
export function parseCadenceConfig(body) {
  const cadence = body.cadence;
  const out = { cadence, anchor_date: null, day_1: null, day_2: null, interval_days: null };
  switch (cadence) {
    case 'weekly':
    case 'biweekly':
      out.anchor_date = requireDate(body.anchorDate, 'anchorDate');
      break;
    case 'custom':
      out.anchor_date = requireDate(body.anchorDate, 'anchorDate');
      if (!Number.isInteger(body.intervalDays) || body.intervalDays < 2 || body.intervalDays > 185) {
        bad('intervalDays must be an integer between 2 and 185');
      }
      out.interval_days = body.intervalDays;
      break;
    case 'semimonthly':
      out.day_1 = requireDayOfMonth(body.day1, 'day1');
      out.day_2 = requireDayOfMonth(body.day2, 'day2');
      if (out.day_1 === out.day_2) bad('day1 and day2 must be different');
      break;
    case 'monthly':
      out.day_1 = requireDayOfMonth(body.day1, 'day1');
      break;
    default:
      bad('cadence must be one of weekly, biweekly, semimonthly, monthly, custom');
  }
  return out;
}
