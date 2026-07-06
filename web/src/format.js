export function fmtMoney(cents, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

// Compact form for chart axes: $1.2K, -$800.
export function fmtMoneyCompact(cents, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1,
    }).format(cents / 100);
  } catch {
    return fmtMoney(cents, currency);
  }
}

// Parse a user-entered dollar string ("1,234.56", "$-20") into cents.
export function parseMoney(text) {
  const cleaned = String(text).replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

export function centsToInput(cents) {
  return (cents / 100).toFixed(2);
}

function localDate(iso) {
  return new Date(`${iso}T00:00:00`);
}

export function fmtDate(iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  return localDate(iso).toLocaleDateString(undefined, opts);
}

export function fmtRange(start, end) {
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const s = localDate(start).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `${s} – ${fmtDate(end)}`;
}

export function todayISO() {
  const t = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

export const HEALTH_LABELS = {
  negative: 'Negative',
  danger: 'Thin',
  ok: 'OK',
  healthy: 'Healthy',
  none: 'No data',
};
