// Minimal RFC-4180-ish CSV parsing plus the loose cell formats banks export.

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.length > 1 || row[0].trim() !== '') rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0].trim() !== '') rows.push(row);
  return rows;
}

const pad = (n) => String(n).padStart(2, '0');

// Bank date cells: ISO, or 1-2 digit day/month with /-. separators, in the
// column order the user picked ('mdy' or 'dmy').
export function parseDateCell(cell, order = 'mdy') {
  const s = String(cell || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [month, day] = order === 'dmy' ? [b, a] : [a, b];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${pad(month)}-${pad(day)}`;
  }
  return null;
}

// Bank amount cells: "$1,234.56", "-20.00", "(45.10)" (parens = negative).
export function parseAmountCell(cell) {
  let s = String(cell || '').trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[^0-9.\-]/g, '');
  if (!s || s === '-' || s === '.') return null;
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) * (negative ? -1 : 1);
}

// Turn a bank description into a reusable match pattern: strip digits (card
// numbers, dates, confirmation codes) and collapse whitespace, so "ELECTRIC
// CO PMT 070526 4821" matches next month's row too.
export function suggestedRulePattern(description) {
  const p = String(description || '').replace(/[#*\d]+/g, ' ').replace(/\s+/g, ' ').trim();
  return p.length >= 4 ? p : null;
}
