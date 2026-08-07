// Which categories are valid for a given account, mirroring the backend rule
// stated verbatim at server/services/budget.js:345-346:
//
//   a template belongs to account A when
//   (template.account_id ?? defaultAccountId) === A
//
// Plain JS, no React/JSX imports, so it can be unit-tested from the server
// suite as well as used from the web app.

// Annotates each category with a `displayName` so that same-named categories
// which reached this list only via the default-account fallback (no explicit
// `accountId`) can be told apart from an explicitly-scoped category sharing
// the same name. See CONSTITUTION.md §8 2026-08-06 for the full bug writeup.
// Display-only: does not touch `id`/`accountId`/any other field, and does
// not mutate the input array.
export function withDisplayNames(categories) {
  const list = categories || [];
  const counts = new Map();
  for (const c of list) counts.set(c.name, (counts.get(c.name) || 0) + 1);
  return list.map((c) => {
    const isFloating = c.accountId == null;
    const collides = (counts.get(c.name) || 0) > 1;
    return {
      ...c,
      displayName: collides && isFloating ? `${c.name} (default)` : c.name,
    };
  });
}

// Returns the categories from `categories` that belong to `accountId`,
// excluding archived ones. A null/undefined `accountId` is treated as the
// default account (mirrors the backend's `?? defaultAccountId` fallback).
export function categoriesForAccount(categories, accountId, defaultAccountId) {
  const target = accountId ?? defaultAccountId;
  const result = (categories || []).filter((c) => {
    if (c.archived) return false;
    return (c.accountId ?? defaultAccountId) === target;
  });
  return withDisplayNames(result);
}

// Categories valid for EVERY account in `accountIds` (set/array of account
// ids) - used when a bulk selection spans multiple accounts. If the
// selection has no accounts in common, or `accountIds` is empty, returns [].
export function categoriesForAccounts(categories, accountIds, defaultAccountId) {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return [];
  const [first, ...rest] = ids.map((id) => categoriesForAccount(categories, id, defaultAccountId));
  const result = first.filter((c) => rest.every((list) => list.some((other) => other.id === c.id)));
  return withDisplayNames(result);
}
