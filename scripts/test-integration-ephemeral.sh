#!/usr/bin/env bash
# One-command ephemeral integration-test database.
#
# Why this exists: server/test/integration/_env-guard.js (correctly) refuses
# to run the integration suite against anything that isn't recognizably a
# throwaway database - see that file's comment for the full reasoning. But on
# this project's dev setup, Postgres port 5432 is NOT published to the host
# (docker-compose.yml sets PGHOST: db, no `ports:` on the db service), so the
# only way to reach it from the host is over the compose bridge network - and
# hand-rolling that (`docker exec ... createdb`, guessing the bridge IP,
# remembering to drop it after) is exactly the friction that has previously
# tempted people into pointing the suite at the shared dev database instead.
# This script makes the safe path the one-command path.
#
# What it does:
#   1. Finds the running `db` compose service and asks Docker for its
#      CURRENT bridge IP (never hardcoded - docker-compose.yml pins no
#      subnet, so the address Docker assigns is not stable across a network
#      prune or a different machine).
#   2. Creates a uniquely-named database (a timestamp+PID suffix so two runs
#      in a row, or two runs on different machines, can't collide) whose name
#      contains "ephemeral" - satisfying the env-guard's marker-name rule.
#   3. Migrates it and runs `npm run test:integration` against it.
#   4. Drops the database on the way out - success, failure, or Ctrl-C alike.
#
# Deliberately does NOT set ALLOW_INTEGRATION_TESTS: the bridge IP is a
# private IPv4 literal (172.16.0.0/12) and the database name carries the
# "ephemeral" marker, so this satisfies the guard's condition (b) outright.
#
# Connects via the discrete PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE vars
# (server/config.js), NOT a DATABASE_URL. This is the same fix this project
# already made in v0.4.1 for the recurring prod 28P01 outage caused by a `$`/
# `@` in a password breaking a hand-built connection URL (see MEMORY: "DB
# password hardening") - a container's real POSTGRES_PASSWORD can contain
# `@`, `:`, `/`, `#`, etc., and any of those would silently corrupt the
# delimiter structure of `postgres://user:pass@host:port/db`. Discrete fields
# sidestep the parsing problem entirely instead of encoding around it.
set -euo pipefail

cd "$(dirname "$0")/.."

DB_SERVICE=db
DB_CONTAINER="$(docker compose ps "$DB_SERVICE" --format '{{.Name}}' 2>/dev/null || true)"

if [ -z "$DB_CONTAINER" ]; then
  echo "error: the '$DB_SERVICE' compose service isn't running." >&2
  echo "  Start it first:  docker compose up -d $DB_SERVICE" >&2
  exit 1
fi

DB_HOST="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$DB_CONTAINER")"
if [ -z "$DB_HOST" ]; then
  echo "error: could not determine the bridge IP of container '$DB_CONTAINER'." >&2
  exit 1
fi

DB_USER="$(docker exec "$DB_CONTAINER" printenv POSTGRES_USER)"
DB_PASSWORD="$(docker exec "$DB_CONTAINER" printenv POSTGRES_PASSWORD)"

# Marker-name required by _env-guard.js condition (b): must contain "test",
# "ephemeral", or "scratch". Suffix with timestamp+PID so back-to-back runs
# (or concurrent runs) never collide on the name.
DB_NAME="paycycle_ephemeral_$(date +%s)_$$"

echo "==> Creating ephemeral database '$DB_NAME' on $DB_HOST (container $DB_CONTAINER)"
docker exec "$DB_CONTAINER" createdb -U "$DB_USER" "$DB_NAME"

cleanup() {
  status=$?
  echo "==> Dropping ephemeral database '$DB_NAME'"
  docker exec "$DB_CONTAINER" dropdb -U "$DB_USER" --if-exists "$DB_NAME" || \
    echo "warning: failed to drop '$DB_NAME' - drop it by hand: docker exec $DB_CONTAINER dropdb -U $DB_USER --if-exists $DB_NAME" >&2
  exit $status
}
# Bash runs the EXIT trap on normal completion, on a failing command (set
# -e), AND when the script is killed by an unhandled signal like Ctrl-C
# (SIGINT) or SIGTERM - so this one trap alone covers all three. (Trapping
# INT/TERM separately too would just re-run the same cleanup a second time,
# harmlessly but noisily, once for the signal and once for the EXIT it
# causes.)
trap cleanup EXIT

# Unset first: config.js/db.js/the env-guard all give DATABASE_URL absolute
# priority over the discrete PG* vars ("if DATABASE_URL is set, it wins
# outright"). A stale DATABASE_URL exported earlier in the caller's shell
# (e.g. left over from a manual debugging session) would silently override
# everything below and point the run at whatever that stale value names.
unset DATABASE_URL
export PGHOST="$DB_HOST"
export PGPORT=5432
export PGUSER="$DB_USER"
export PGPASSWORD="$DB_PASSWORD"
export PGDATABASE="$DB_NAME"

echo "==> Migrating $DB_NAME"
npm run migrate

echo "==> Running integration tests against $DB_NAME"
npm run test:integration
