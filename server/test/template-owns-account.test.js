import test from 'node:test';
import assert from 'node:assert/strict';
import { templateOwnsAccount } from '../services/budget.js';

// Mirrors the backend rule stated verbatim at server/services/budget.js:345-346
// (and the frontend mirror in web/src/categoryScope.js):
//   a template belongs to account A when (template.account_id ?? defaultAccountId) === A
//
// This is the predicate used to scope rule-application/preview (see
// server/routes/transactions.js /recategorize, server/routes/rules.js
// /preview, server/routes/import.js /preview, and
// server/services/simplefin.js insertSyncedTxn) so a rule can never assign a
// category owned by one account to a transaction on another account.

const DEFAULT_ACCOUNT_ID = 1; // "Primary account" in the reported bug shape

test('templateOwnsAccount: an account-owned category matches only its own account', () => {
  const template = { account_id: 110 }; // "Rent" owned by SimpleFin (110)
  assert.equal(templateOwnsAccount(template, 110, DEFAULT_ACCOUNT_ID), true);
  assert.equal(templateOwnsAccount(template, 1, DEFAULT_ACCOUNT_ID), false);
});

test('templateOwnsAccount: a NULL-account category matches only the default account', () => {
  const template = { account_id: null };
  assert.equal(templateOwnsAccount(template, DEFAULT_ACCOUNT_ID, DEFAULT_ACCOUNT_ID), true);
  assert.equal(templateOwnsAccount(template, 110, DEFAULT_ACCOUNT_ID), false);
});

test('templateOwnsAccount: a transaction on another account is not owned', () => {
  const template = { account_id: 110 };
  // Transaction posted to account 1 (Primary), category owned by account 110
  // (SimpleFin) - the exact shape of the reported bug (two "Rent"
  // transactions, ids 117 and 18, category 173 owned only by account 110).
  assert.equal(templateOwnsAccount(template, 1, DEFAULT_ACCOUNT_ID), false);
});

// Regression coverage for `??` vs `||`: account id 0 and default account id 0
// are falsy-but-valid values (see the equivalent zero-id tests in
// category-scope.test.js).
test('templateOwnsAccount: account id 0 is a valid, distinct account id (not treated as missing)', () => {
  const template = { account_id: 0 };
  assert.equal(templateOwnsAccount(template, 0, DEFAULT_ACCOUNT_ID), true);
  assert.equal(templateOwnsAccount(template, DEFAULT_ACCOUNT_ID, DEFAULT_ACCOUNT_ID), false);
});

test('templateOwnsAccount: defaultAccountId 0 is honored for a NULL-account category', () => {
  const template = { account_id: null };
  assert.equal(templateOwnsAccount(template, 0, 0), true);
  assert.equal(templateOwnsAccount(template, 1, 0), false);
});
