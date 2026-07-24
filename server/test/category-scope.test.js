import test from 'node:test';
import assert from 'node:assert/strict';
import { categoriesForAccount, categoriesForAccounts } from '../../web/src/categoryScope.js';

// Mirrors the backend rule stated verbatim at server/services/budget.js:345-346:
//   a template belongs to account A when (template.account_id ?? defaultAccountId) === A

const DEFAULT_ACCOUNT_ID = 34; // "Main Checking" in the dev data this mirrors

const categories = [
  { id: 1, name: 'Paycheck', accountId: null, archived: false },
  { id: 2, name: 'Electric', accountId: null, archived: false },
  { id: 3, name: 'Mortgage', accountId: null, archived: false },
  { id: 4, name: 'Electric (Savings)', accountId: 4, archived: false },
  { id: 5, name: 'Mortgage (Second Checking)', accountId: 6, archived: false },
  { id: 6, name: 'Abbott Paycheck', accountId: 6, archived: false },
  { id: 7, name: 'Explorer Payment', accountId: 6, archived: false },
  { id: 8, name: 'TestPayday', accountId: 110, archived: false },
  { id: 9, name: 'Old Archived Category', accountId: 110, archived: true },
];

test('categoriesForAccount: explicit-account category matches only its own account', () => {
  const result = categoriesForAccount(categories, 4, DEFAULT_ACCOUNT_ID);
  assert.deepEqual(result.map((c) => c.name), ['Electric (Savings)']);
});

test('categoriesForAccount: NULL-account category matches only the default account', () => {
  const result = categoriesForAccount(categories, DEFAULT_ACCOUNT_ID, DEFAULT_ACCOUNT_ID);
  assert.deepEqual(result.map((c) => c.name).sort(), ['Electric', 'Mortgage', 'Paycheck']);
});

test('categoriesForAccount: excludes archived categories', () => {
  const result = categoriesForAccount(categories, 110, DEFAULT_ACCOUNT_ID);
  assert.equal(result.some((c) => c.name === 'Old Archived Category'), false);
});

test('categoriesForAccount: a category for account B is excluded when scoping to account A', () => {
  const result = categoriesForAccount(categories, DEFAULT_ACCOUNT_ID, DEFAULT_ACCOUNT_ID);
  assert.equal(result.some((c) => c.accountId === 6), false);
  assert.equal(result.some((c) => c.accountId === 4), false);
  assert.equal(result.some((c) => c.accountId === 110), false);
});

test('categoriesForAccount: null accountId falls back to the default account', () => {
  const result = categoriesForAccount(categories, null, DEFAULT_ACCOUNT_ID);
  assert.deepEqual(result.map((c) => c.name).sort(), ['Electric', 'Mortgage', 'Paycheck']);
});

test('categoriesForAccounts: intersection of a single-account selection is just that account\'s list', () => {
  const result = categoriesForAccounts(categories, [4, 4], DEFAULT_ACCOUNT_ID);
  assert.deepEqual(result.map((c) => c.name), ['Electric (Savings)']);
});

test('categoriesForAccounts: intersection across accounts with nothing in common is empty', () => {
  const result = categoriesForAccounts(categories, [4, 110], DEFAULT_ACCOUNT_ID);
  assert.deepEqual(result, []);
});

test('categoriesForAccounts: two selected rows on the same account keep that account\'s full list', () => {
  // Common case: bulk selection where every row happens to share one account.
  const result = categoriesForAccounts(categories, [DEFAULT_ACCOUNT_ID, DEFAULT_ACCOUNT_ID], DEFAULT_ACCOUNT_ID);
  assert.deepEqual(result.map((c) => c.name).sort(), ['Electric', 'Mortgage', 'Paycheck']);
});

test('categoriesForAccounts: empty selection yields no options', () => {
  assert.deepEqual(categoriesForAccounts(categories, [], DEFAULT_ACCOUNT_ID), []);
});

// Regression coverage for `??` vs `||`: account id 0 and default account id 0
// are falsy-but-valid values. A `||` fallback would incorrectly treat them as
// "missing" and fall through to the other operand, misattributing categories.

const zeroAccountCategories = [
  { id: 10, name: 'Zero Account Only', accountId: 0, archived: false },
  { id: 11, name: 'Other Account Only', accountId: 42, archived: false },
  { id: 12, name: 'NULL-account (falls back to default)', accountId: null, archived: false },
];

test('categoriesForAccount: accountId 0 is a valid, distinct account id (not treated as missing)', () => {
  // With `??`, target = 0 ?? DEFAULT_ACCOUNT_ID = 0 (0 is not null/undefined).
  // With `||`, target = 0 || DEFAULT_ACCOUNT_ID = DEFAULT_ACCOUNT_ID (regression).
  const result = categoriesForAccount(zeroAccountCategories, 0, DEFAULT_ACCOUNT_ID);
  assert.deepEqual(result.map((c) => c.name), ['Zero Account Only']);
});

test('categoriesForAccount: a category with accountId 0 is excluded when scoping to a different account', () => {
  const result = categoriesForAccount(zeroAccountCategories, 42, DEFAULT_ACCOUNT_ID);
  assert.equal(result.some((c) => c.accountId === 0), false);
});

test('categoriesForAccount: defaultAccountId 0 is honored for a NULL-account category', () => {
  // With `??`, a NULL-account category's target = (null ?? 0) = 0, matching
  // accountId 0. With `||`, (null ?? 0) is unaffected here, but the
  // *per-category* `c.accountId ?? defaultAccountId` check inside the filter
  // would break: 0 || defaultAccountId would incorrectly resolve to
  // defaultAccountId instead of staying 0.
  const result = categoriesForAccount(zeroAccountCategories, 0, 0);
  assert.deepEqual(result.map((c) => c.name).sort(), ['NULL-account (falls back to default)', 'Zero Account Only']);
});

test('categoriesForAccounts: intersection works correctly when one account id is 0', () => {
  const shared = [
    { id: 20, name: 'Shared', accountId: 0, archived: false },
    { id: 21, name: 'Other', accountId: 5, archived: false },
  ];
  const result = categoriesForAccounts(shared, [0, 0], DEFAULT_ACCOUNT_ID);
  assert.deepEqual(result.map((c) => c.name), ['Shared']);
});
