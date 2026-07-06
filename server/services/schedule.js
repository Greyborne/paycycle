// Pay-period schedule engine.
//
// All dates are plain ISO 'YYYY-MM-DD' strings; lexicographic comparison is
// chronological, and no timezone conversions ever apply. A "period" is
// { start, end }, both inclusive.
//
// The schedule defined by a pay_period_config partitions the entire calendar,
// extending infinitely in both directions, so any date maps to exactly one
// period. Cadences:
//   weekly / biweekly / custom : fixed-length runs anchored to anchor_date
//   semimonthly                : starts on day_1 and day_2 of every month
//   monthly                    : starts on day_1 of every month
// Day-of-month values are clamped into short months (day 31 -> Feb 28/29).

const DAY_MS = 86400000;

export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

export function toISO(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function toUTCms(iso) {
  const { y, m, d } = parseISO(iso);
  return Date.UTC(y, m - 1, d);
}

export function addDays(iso, n) {
  const t = new Date(toUTCms(iso) + n * DAY_MS);
  return toISO(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function daysBetween(a, b) {
  return Math.round((toUTCms(b) - toUTCms(a)) / DAY_MS);
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addMonths(iso, n) {
  const { y, m, d } = parseISO(iso);
  const total = m - 1 + n;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12 + 1;
  return toISO(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

// "Today" in the server's local timezone (set TZ to control this).
export function todayISO() {
  const t = new Date();
  return toISO(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

export function isValidISO(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return false;
  const { y, m, d } = parseISO(iso);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function intervalDays(cfg) {
  if (cfg.cadence === 'weekly') return 7;
  if (cfg.cadence === 'biweekly') return 14;
  return cfg.interval_days;
}

// Period-start dates falling in month (y, m) for calendar-based cadences.
function monthStarts(cfg, y, m) {
  const dim = daysInMonth(y, m);
  if (cfg.cadence === 'monthly') {
    return [toISO(y, m, Math.min(cfg.day_1, dim))];
  }
  const lo = Math.min(cfg.day_1, cfg.day_2);
  const hi = Math.max(cfg.day_1, cfg.day_2);
  const s1 = toISO(y, m, Math.min(lo, dim));
  const s2 = toISO(y, m, Math.min(hi, dim));
  return s1 === s2 ? [s1] : [s1, s2];
}

export function periodContaining(cfg, date) {
  if (cfg.cadence === 'weekly' || cfg.cadence === 'biweekly' || cfg.cadence === 'custom') {
    const n = intervalDays(cfg);
    const k = Math.floor(daysBetween(cfg.anchor_date, date) / n);
    const start = addDays(cfg.anchor_date, k * n);
    return { start, end: addDays(start, n - 1) };
  }
  // Calendar cadences: gather candidate starts around the date, then find the
  // pair of consecutive starts bracketing it.
  const { y, m } = parseISO(date);
  const months = [[m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1], [y, m], [m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1]];
  const starts = months.flatMap(([yy, mm]) => monthStarts(cfg, yy, mm));
  const i = starts.findIndex((s) => s > date);
  return { start: starts[i - 1], end: addDays(starts[i], -1) };
}

export function periodAfter(cfg, period) {
  return periodContaining(cfg, addDays(period.end, 1));
}

export function periodBefore(cfg, period) {
  return periodContaining(cfg, addDays(period.start, -1));
}

// Dates within [startISO, endISO] that are the given day-of-month (clamped
// into short months). A period can contain zero, one, or - for long custom
// periods - multiple occurrences.
export function monthlyOccurrences(dayOfMonth, startISO, endISO) {
  const out = [];
  let { y, m } = parseISO(startISO);
  const end = parseISO(endISO);
  while (y < end.y || (y === end.y && m <= end.m)) {
    const occ = toISO(y, m, Math.min(dayOfMonth, daysInMonth(y, m)));
    if (occ >= startISO && occ <= endISO) out.push(occ);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
