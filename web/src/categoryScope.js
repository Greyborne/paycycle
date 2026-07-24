// Which categories are valid for a given account, mirroring the backend rule
// stated verbatim at server/services/budget.js:345-346:
//
//   a template belongs to account A when
//   (template.account_id ?? defaultAccountId) === A
//
// Plain JS, no React/JSX imports, so it can be unit-tested from the server
// suite as well as used from the web app.

// Returns the categories from `categories` that belong to `accountId`,
// excluding archived ones. A null/undefined `accountId` is treated as the
// default account (mirrors the backend's `?? defaultAccountId` fallback).
export function categoriesForAccount(categories, accountId, defaultAccountId) {
  const target = accountId ?? defaultAccountId;
  return (categories || []).filter((c) => {
    if (c.archived) return false;
    return (c.accountId ?? defaultAccountId) === target;
  });
}

// Categories valid for EVERY account in `accountIds` (set/array of account
// ids) - used when a bulk selection spans multiple accounts. If the
// selection has no accounts in common, or `accountIds` is empty, returns [].
export function categoriesForAccounts(categories, accountIds, defaultAccountId) {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return [];
  const [first, ...rest] = ids.map((id) => categoriesForAccount(categories, id, defaultAccountId));
  return first.filter((c) => rest.every((list) => list.some((other) => other.id === c.id)));
}
