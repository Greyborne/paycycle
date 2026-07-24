# Upgrading to v0.11.0 — line-item actual amounts

**Read this before upgrading. v0.11.0 ships a one-way database migration.**

v0.11.0 records what your line items *actually* posted at, separate from what
was planned. Until now, when a paycheck was planned at $2,758.00 but actually
deposited $2,564.48, the account balance kept counting the plan. Now it counts
the actual — so your balance moves to reflect reality.

Migration `015_line_item_actuals.sql` adds `line_items.cleared_amount_cents`
(the actual posted amount when a transaction clears it) alongside the existing
`planned_amount_cents`. Account balances on open periods recalculate to use the
actual where it exists, falling back to the plan if there is none. It runs
automatically when the new container starts.

**It cannot be undone in place.** The balances it changes are permanent; there
is no down-migration. Your backup is the only way back, so steps 1 and 2 below
are not optional.

---

## Before you start

- **Expect balance changes on open periods.** The correction is the point. On
  the original author's data it moved totals by $387.04 across two pay periods
  (a payday planned at $2,758.00 that actually paid $2,564.48, twice). Your
  figures will move up or down depending on whether actuals ran above or below
  plan. Closed periods are not modified — their frozen snapshots stand.
- **Downtime:** one container restart plus the migration, which runs before the
  server starts listening. Seconds for a typical household.
- **Set aside one sitting.** Steps 1–4 belong together: the backup is your
  rollback, and it should be minutes old, not days.

## 1. Back up, and verify the backup

Take the dump **immediately before upgrading**. Note `--clean --if-exists` —
without it the dump can only be restored into a *fresh* database, which is
useless as a rollback for an in-place upgrade.

If any docker command below reports a permission error, your account is not in
the docker group. Add `sudo` to that command; for consistency, use it on all
docker commands or none.

```bash
docker compose exec -T db pg_dump -U paycycle -d paycycle --clean --if-exists \
  | gzip > ~/paycycle-pre-v0.11.0-$(date +%F-%H%M%S).sql.gz

# both checks must print 1
gunzip -c ~/paycycle-pre-v0.11.0-*.sql.gz | grep -c "PostgreSQL database dump complete"
gunzip -c ~/paycycle-pre-v0.11.0-*.sql.gz | grep -c "COPY public.transactions"
```

The first check proves the dump is not truncated; the second proves it contains your data — a complete-but-empty dump is useless as a rollback.

#### Permission denied?

The `>` redirect runs in your shell before sudo, so `sudo !!` won't help. The command above uses `~` (your home directory, expanded before sudo runs) — the file is created there and you own it.

If the file must go beside the stack, use `sudo sh -c '... | gzip > paycycle-pre-v0.11.0-$(date +%F-%H%M%S).sql.gz'` instead (file is root-owned; later operations need sudo). `docker compose` must run from the stack directory — you cannot simply `cd ~` first.

Record a baseline to reconcile against afterwards:

```bash
docker compose exec -T db psql -U paycycle -d paycycle -tAc "
SELECT 'periods='||(SELECT count(*) FROM pay_periods)
   ||' line_items='||(SELECT count(*) FROM line_items)
   ||' txns='||(SELECT count(*) FROM transactions);
SELECT 'li_cents='||COALESCE(SUM(planned_amount_cents),0) FROM line_items;
SELECT 'txn_cents='||COALESCE(SUM(amount_cents),0) FROM transactions;"
```

Also note the version you're on, so you know what to roll back to:

```bash
grep -n 'image:' docker-compose.yml
```

## 2. Rehearse the migration on a copy of your data

The highest-value step, and the easiest to skip. This runs the real migration
against *your* data with zero risk to prod.

```bash
docker run -d --name pc-dryrun \
  -e POSTGRES_USER=paycycle -e POSTGRES_PASSWORD=paycycle -e POSTGRES_DB=paycycle \
  -p 55432:5432 postgres:16-alpine
sleep 5

gunzip -c ~/paycycle-pre-v0.11.0-*.sql.gz | docker exec -i pc-dryrun psql -U paycycle -d paycycle

# the new image migrates on boot
docker run --rm --network host \
  -e PGHOST=localhost -e PGPORT=55432 -e PGUSER=paycycle -e PGPASSWORD=paycycle \
  -e PGDATABASE=paycycle -e SESSION_SECRET=dryrun \
  YOUR_DOCKERHUB_USER/paycycle:0.11.0
```

Watch for `[paycycle] applied migration 015_line_item_actuals.sql`, then run
the **step 4 verification queries** against the copy (point them at `pc-dryrun`
instead of `db`). If they pass, prod will behave the same way.

```bash
docker rm -f pc-dryrun
```

## 3. Upgrade

Pin the exact version rather than `:latest`, so you always know what's running
and what to roll back to:

```yaml
  app:
    image: YOUR_DOCKERHUB_USER/paycycle:0.11.0
```

```bash
docker compose pull app
docker compose up -d
docker compose logs -f app
```

Expect, in this order:

```
[paycycle] applied migration 015_line_item_actuals.sql
[paycycle] listening on port 8080
```

The migration completes **before** the server listens, so there is never a
moment where new code serves on the old schema. If the migration fails it
rolls back whole (it runs in one transaction), the container exits, and
`restart: unless-stopped` will loop it. That failure mode is an **outage with
your data intact** — not corruption. Roll back per step 5.

## 4. Verify

```bash
docker compose exec -T db psql -U paycycle -d paycycle -tAc "
-- conservation: these MUST equal your step 1 baseline exactly
SELECT 'line_items='||(SELECT count(*) FROM line_items)||' cents='||COALESCE(SUM(planned_amount_cents),0) FROM line_items;
SELECT 'txns='||(SELECT count(*) FROM transactions)||' cents='||COALESCE(SUM(amount_cents),0) FROM transactions;
-- integrity: orphaned transactions MUST be 0
SELECT 'orphan_txns='||(SELECT count(*) FROM transactions t LEFT JOIN pay_periods pp ON pp.id=t.pay_period_id WHERE pp.id IS NULL);"
```

- `line_items` and `transactions` **must not move at all**, in count or in
  summed cents. Not one cent. If they do, roll back and report it.
- The `cleared_amount_cents` column should now exist, with NULLs for items not
  yet cleared by a transaction, and populated amounts for the rest.

Then click through: log in, open a period with some cleared items, and confirm
the line-item balances moved (if any actuals differed from their plans).

## 5. Rollback

**Reverting the image alone will not work.** v0.10.0 cannot run on the v0.11.0
schema — it has no `cleared_amount_cents` column and cannot write actual amounts.
You must restore the database *and* revert the image:

```bash
docker compose stop app
gunzip -c ~/paycycle-pre-v0.11.0-*.sql.gz \
  | docker compose exec -T db psql -U paycycle -d paycycle
# revert image: to 0.10.0 in docker-compose.yml
docker compose up -d
```

(This is what `--clean --if-exists` in step 1 bought you.)

---

## What changes for you after upgrading

- **Open-period balances recalculate.** Any period currently open (not closed)
  will show new balance figures if transactions have cleared at amounts
  different from the line items' planned amounts. Closed periods are frozen
  and will not change.
- **Closed periods preserve their history.** A closed period's `closed_snapshot`
  was recorded at close time and remains unchanged. Its displayed balance does
  not move.
- **Hand-cleared line items (no transaction) work unchanged.** If you manually
  mark an item cleared without a linked transaction, it records no actual
  amount and continues counting its planned amount exactly as before.
- **Categorization rules now match by account.** A rule whose category is
  pinned to a specific account now only matches transactions on that account —
  previously, it incorrectly matched across accounts. Existing transactions
  assigned to the wrong account by those rules are **not** retroactively
  corrected; if you have line items on a period they don't belong to, you must
  move them by hand or delete and re-import.

  To find line items on the wrong account, run this diagnostic:

  ```bash
  docker compose exec -T db psql -U paycycle -d paycycle -c "
  SELECT li.id,
         ct.name              AS category,
         ct.account_id        AS category_account,
         pp.account_id        AS period_account,
         pp.start_date
  FROM line_items li
  JOIN pay_periods pp        ON pp.id = li.pay_period_id
  JOIN category_templates ct ON ct.id = li.category_template_id
  WHERE ct.account_id IS NOT NULL
    AND ct.account_id <> pp.account_id
  ORDER BY pp.start_date;"
  ```

  Each row is a line item whose category is pinned to one account but sits on a
  period belonging to another. Seeing rows here is expected if you used
  cross-account rules before v0.11.0. These are candidates for manual correction,
  not problems the migration created — a user who deliberately arranged something
  unusual may see rows legitimately. The query only catches categories with an
  explicit account; categories without an account belong to your household's
  default. Correct these manually: move each to the right period or delete and
  re-import on the correct account.
- **Rules report match counts.** During import or when running rules manually,
  you will see a notice like "Rules matched 5 of 12 uncategorized transaction(s)
  · 2 in closed periods skipped · 1 skipped (matched category belongs to a
  different account)." The per-account filtering means rules that matched
  across accounts before now skip those mismatched transactions.
- **Transactions page is account-scoped.** The Transactions table no longer has
  its own Account filter. It follows the top-bar account switcher — when you
  switch accounts, the transactions list filters to that account.

## Known gaps in this release

Documented rather than hidden:

- The status message shown after "Plan {amount} going forward" may not be
  announced by every screen reader. Keyboard focus moves correctly regardless,
  so the action is fully usable.
