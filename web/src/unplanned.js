// Groups a pay period's *unplanned* transactions (uncategorized or tagged
// with a tag category, as opposed to a recurring category's line item) by
// tag, for one account.
//
// "Unplanned" mirrors the backend's misc-income/misc-expense definition at
// server/services/budget.js:546-552: a transaction counts as misc when it
// has no category, or its category is a 'tag' category. A transaction on a
// recurring category is the record of that line item clearing and must be
// excluded here entirely, or its value would be counted twice.

// A tag belongs to `accountId` the same way a category template does
// (server/services/budget.js:901): (tag.accountId ?? defaultAccountId) ===
// accountId. If the household has no default account, there is nothing to
// fall back to, so every tag is included unscoped.
function tagsForAccount(categories, accountId, defaultAccountId) {
  const tags = (categories || []).filter((c) => c.categoryType === 'tag' && !c.archived);
  if (defaultAccountId == null) return tags;
  return tags.filter((t) => (t.accountId ?? defaultAccountId) === accountId);
}

export function groupUnplanned({ transactions, categories, accountId, defaultAccountId }) {
  const tags = tagsForAccount(categories, accountId, defaultAccountId);
  const tagIds = new Set(tags.map((t) => t.id));

  // Seed one group per in-scope tag so every tag gets a row even with zero
  // transactions (rule 3), plus the always-last Untagged group.
  const byTagId = new Map();
  for (const tag of tags) {
    byTagId.set(tag.id, {
      key: `tag-${tag.id}`,
      tagId: tag.id,
      name: tag.name,
      type: tag.type,
      sortOrder: tag.sortOrder,
      totalCents: 0,
      count: 0,
      transactions: [],
      hasUncounted: false,
      hasOrphans: false,
    });
  }
  const untagged = {
    key: 'untagged',
    tagId: null,
    name: 'Untagged',
    type: null,
    totalCents: 0,
    count: 0,
    transactions: [],
    hasUncounted: false,
    hasOrphans: false,
  };

  let incomeCents = 0;
  let expenseCents = 0;

  for (const t of transactions || []) {
    const isTag = t.category_template_id != null && t.category_type === 'tag';
    const isUncategorized = t.category_template_id == null;
    if (!isTag && !isUncategorized) continue; // recurring-category line item; excluded entirely

    // A tag that exists but was scoped out of this account still has to
    // hold onto its transaction somewhere — it lands in Untagged, flagged
    // as an orphan, rather than vanishing or inventing a row for it.
    const inScopeTag = isTag && tagIds.has(t.category_template_id);
    const group = inScopeTag ? byTagId.get(t.category_template_id) : untagged;
    if (isTag && !inScopeTag) group.hasOrphans = true;

    group.transactions.push(t);
    group.count += 1;

    const counted = !t.account_currency; // foreign-currency accounts never enter period totals
    if (!counted) {
      group.hasUncounted = true;
      continue;
    }

    const signed = t.type === 'income' ? t.amount_cents : -t.amount_cents;
    group.totalCents += signed;
    if (t.type === 'income') incomeCents += t.amount_cents;
    else expenseCents += t.amount_cents;
  }

  const income = [...byTagId.values()].filter((g) => g.type === 'income');
  const expense = [...byTagId.values()].filter((g) => g.type === 'expense');
  const bySortThenId = (a, b) => a.sortOrder - b.sortOrder || a.tagId - b.tagId;
  income.sort(bySortThenId);
  expense.sort(bySortThenId);

  const groups = [...income, ...expense].map(({ sortOrder, ...g }) => g);
  if (untagged.count > 0) groups.push(untagged);

  return { groups, incomeCents, expenseCents, totalCents: incomeCents - expenseCents };
}
