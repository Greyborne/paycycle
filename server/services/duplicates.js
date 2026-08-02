// Cross-source duplicate detection (CONSTITUTION.md, 2026-08-01 §8B). Manual
// entry, CSV import, and SimpleFIN sync each hash import_hash differently
// (or not at all), so the same real-world purchase entered via two paths can
// land as two separate rows with no existing cross-check. This is a
// deliberately loose, advisory heuristic: same account, same type, same
// amount_cents, dated within +/-3 days. Description is NOT part of the
// match - manual descriptions and raw bank strings for the same purchase
// routinely don't resemble each other (see the constitution entry for the
// full rationale). A match only flags `possible_duplicate_of`; it never
// blocks, merges, or deletes anything.
//
// Every call site runs this against its OWN open client/transaction (a pool
// client mid-BEGIN, or the pool itself for read-only callers) so the match
// and the flag-set stay atomic with the row's insert.

// Finds the best pre-existing candidate transaction for a possible-duplicate
// pair, or null if none exists. `excludeId` lets a caller that has already
// inserted the new row exclude it from matching against itself. Ties (more
// than one pre-existing candidate within the window) are broken by the
// smallest date difference, then lowest id, so exactly one row is ever
// picked.
export async function findPossibleDuplicate(db, { budgetId, accountId, type, amountCents, date, excludeId = null }) {
  const { rows } = await db.query(
    `SELECT id FROM transactions
     WHERE budget_id = $1
       AND account_id = $2
       AND type = $3
       AND amount_cents = $4
       AND date BETWEEN $5::date - INTERVAL '3 days' AND $5::date + INTERVAL '3 days'
       AND ($6::int IS NULL OR id != $6)
     ORDER BY ABS(date - $5::date) ASC, id ASC
     LIMIT 1`,
    [budgetId, accountId, type, amountCents, date, excludeId]
  );
  return rows.length ? rows[0].id : null;
}
