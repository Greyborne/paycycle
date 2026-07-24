# Upgrading to v0.8.0 — account-first pay periods

**Read this before upgrading. v0.8.0 ships a one-way database migration.**

v0.8.0 makes the **bank account** the primary pay-period entity. Each account
gets its own cadence, its own periods, and its own close/reopen lifecycle —
so you can close a pay period on one account while another stays open.

Migration `013_account_first_periods.sql` splits each household pay period
into one row per account and reattributes your line items and transactions to
them. It runs automatically when the new container starts.

**It cannot be undone in place.** The original household rows are deleted once
their data has moved. There is no down-migration. Your backup is the only way
back, so steps 1 and 2 below are not optional.

---

## Before you start

- **Platform:** published images are **linux/amd64 only**. On arm64 (e.g. a
  Raspberry Pi) `docker compose pull` will fail — arm64 is not supported;
  build locally with `build: .` instead. Check with `uname -m` on the host
  (`x86_64` = fine).
- **Downtime:** one container restart plus the migration, which runs before
  the server starts listening. Seconds for a typical household.
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
  | gzip > ~/paycycle-pre-v0.8.0-$(date +%F-%H%M%S).sql.gz

# both checks must print 1
gunzip -c ~/paycycle-pre-v0.8.0-*.sql.gz | grep -c "PostgreSQL database dump complete"
gunzip -c ~/paycycle-pre-v0.8.0-*.sql.gz | grep -c "COPY public.transactions"
```

The first check proves the dump is not truncated; the second proves it contains your data — a complete-but-empty dump is useless as a rollback.

#### Permission denied?

The `>` redirect runs in your shell before sudo, so `sudo !!` won't help. The command above uses `~` (your home directory, expanded before sudo runs) — the file is created there and you own it.

If the file must go beside the stack, use `sudo sh -c '... | gzip > paycycle-pre-v0.8.0-$(date +%F-%H%M%S).sql.gz'` instead (file is root-owned; later operations need sudo). `docker compose` must run from the stack directory — you cannot simply `cd ~` first.

Record a baseline to reconcile against afterwards:

```bash
docker compose exec -T db psql -U paycycle -d paycycle -tAc "
SELECT 'periods='||(SELECT count(*) FROM pay_periods)
   ||' configs='||(SELECT count(*) FROM pay_period_configs)
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

gunzip -c ~/paycycle-pre-v0.8.0-*.sql.gz | docker exec -i pc-dryrun psql -U paycycle -d paycycle

# the new image migrates on boot
docker run --rm --network host \
  -e PGHOST=localhost -e PGPORT=55432 -e PGUSER=paycycle -e PGPASSWORD=paycycle \
  -e PGDATABASE=paycycle -e SESSION_SECRET=dryrun \
  YOUR_DOCKERHUB_USER/paycycle:0.8.0
```

Watch for `[paycycle] applied migration 013_account_first_periods.sql`, then
run the **step 4 verification queries** against the copy (point them at
`pc-dryrun` instead of `db`). If they pass, prod will behave the same way.

```bash
docker rm -f pc-dryrun
```

## 3. Upgrade

Pin the exact version rather than `:latest`, so you always know what's running
and what to roll back to:

```yaml
  app:
    image: YOUR_DOCKERHUB_USER/paycycle:0.8.0
```

```bash
docker compose pull app
docker compose up -d
docker compose logs -f app
```

Expect, in this order:

```
[paycycle] applied migration 013_account_first_periods.sql
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
-- integrity: every one of these MUST be 0
SELECT 'accountless_periods='||(SELECT count(*) FROM pay_periods WHERE account_id IS NULL);
SELECT 'accountless_configs='||(SELECT count(*) FROM pay_period_configs WHERE account_id IS NULL);
SELECT 'orphan_line_items='||(SELECT count(*) FROM line_items li LEFT JOIN pay_periods pp ON pp.id=li.pay_period_id WHERE pp.id IS NULL);
SELECT 'orphan_txns='||(SELECT count(*) FROM transactions t LEFT JOIN pay_periods pp ON pp.id=t.pay_period_id WHERE pp.id IS NULL);
SELECT 'misattributed_li='||(SELECT count(*) FROM line_items li JOIN pay_periods pp ON pp.id=li.pay_period_id WHERE li.account_id IS NOT NULL AND li.account_id <> pp.account_id);
SELECT 'misattributed_txn='||(SELECT count(*) FROM transactions t JOIN pay_periods pp ON pp.id=t.pay_period_id WHERE t.account_id IS NOT NULL AND t.account_id <> pp.account_id);
SELECT 'cross_budget='||(SELECT count(*) FROM pay_periods pp JOIN accounts a ON a.id=pp.account_id WHERE a.budget_id <> pp.budget_id);"
```

- `pay_periods` and `pay_period_configs` **should grow** — they now hold one
  row per account.
- `line_items` and `transactions` **must not move at all**, in count or in
  summed cents. Not one cent. If they do, roll back and report it.

Then click through: log in, open **Settings → Pay schedule** (each account
listed with its own cadence), switch accounts in the top-bar switcher, open a
period and confirm the Close-out dialog names the account.

## 5. Rollback

**Reverting the image alone will not work.** v0.7.0 cannot run on the v0.8.0
schema — it upserts against a uniqueness constraint the migration drops, and
expects a single pay-period config per household where there are now several.
You must restore the database *and* revert the image:

```bash
docker compose stop app
gunzip -c ~/paycycle-pre-v0.8.0-*.sql.gz \
  | docker compose exec -T db psql -U paycycle -d paycycle
# revert image: to 0.7.0 in docker-compose.yml
docker compose up -d
```

(This is what `--clean --if-exists` in step 1 bought you.)

---

## What changes for you after upgrading

- **Each account has its own pay schedule.** Existing accounts inherit the
  cadence you already had, so nothing shifts until you change it in
  **Settings → Pay schedule**. New accounts pick a cadence when created
  (default biweekly); the "tracking from" date doubles as the anchor.
- **Closing is per account.** Closing one account's period leaves every other
  account's period open. The Close-out dialog names the account it will close.
- **Low-balance warnings are per account** — a healthy household total can
  hide an overdraft in one account.
- **Reports → periods CSV gains a leading `account` column**, with each
  account's running balance on its own chain. **If you have anything parsing
  that export, it needs updating.**
- **Net worth** stays a base-currency figure. Foreign-currency accounts remain
  tracked in their own currency and outside period budget math — the app does
  not guess exchange rates.

## Known gaps in this release

Documented rather than hidden:

- `POST /periods/:start/reopen` is not wrapped in a transaction the way close
  is; a crash mid-reopen could leave a period partially reopened.
- Malformed entity ids in some routes surface as a 500 rather than a 400.
- The Settings "Bank accounts" table has known accessibility violations.
- Focus can fall to the page body when the add-account cadence controls are
  hidden by a programmatic change (see `CONSTITUTION.md` §7 — unreachable in
  normal use).
