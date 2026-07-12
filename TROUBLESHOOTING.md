# Troubleshooting

Common self-hosting issues and how to fix them. All `docker compose` commands are
run from your stack directory (where `docker-compose.yml` / `compose.yaml` lives).
To see what the app is doing, start here:

```
docker compose logs -f app
```

> The app retries the database on startup and prints
> `waiting for database (attempt N/30)...`. That loop hides the underlying error
> until it gives up after ~60s — so if it's looping, work through the database
> section below.

## Login returns "Internal server error", or the app never starts

Almost always the app can't reach or authenticate to Postgres. The database
itself is usually fine. Check these in order.

### 1. You updated the image, but Docker is still running the old one

`docker compose up -d` does **not** re-pull a tag you already have cached. If you
changed your compose (for example switching to the discrete `PG*` variables in
0.4.1+) but are still running an older image, the old code ignores the new
settings and fails to connect. Always pull first:

```
docker compose pull
docker compose up -d
```

Pin a specific version instead of `latest` to avoid this ambiguity, e.g.
`image: chazwall/paycycle:0.4.1`.

### 2. The database password doesn't match

Postgres only applies `POSTGRES_PASSWORD` the **first** time its data volume is
created. If you changed the password later, the existing database role still has
the old one, so the app's login fails (`password authentication failed`).

Test what the role's password actually is (this forces a real password check over
TCP, unlike the default trusted local socket):

```
docker compose exec db psql -h localhost -U paycycle -d paycycle -W -c "select 'auth-ok'"
```

Enter a password at the prompt. `auth-ok` means that password is correct. To set
the role's password so it matches your `.env`:

```
docker compose exec db psql -U paycycle -d paycycle -c "ALTER USER paycycle PASSWORD 'your-password-here';"
```

Then make sure `POSTGRES_PASSWORD` in your `.env` is the **same** value and
restart: `docker compose up -d`.

### 3. Your password contains special characters

Passwords with `@ : / %` can break older URL-style configuration, and `$` is
interpreted by Docker Compose inside `.env` files. As of **0.4.1**, PayCycle
connects using discrete `PG*` variables, so `@ : / %` work with no escaping. For a
literal `$` in the password, either double it (`$$`) in `.env`, or supply the
password via a file with `PGPASSWORD_FILE` (see the commented Docker-secret block
in `docker-compose.yml`).

### 4. Stale Docker network after editing the stack in place

If you edited the compose and used an in-place restart, the app can end up on a
stale network and never reach the database. A full recreate rebuilds it cleanly:

```
docker compose down
docker compose up -d
```

`docker compose down` (without `-v`) does **not** delete your data volume — your
data is safe.

## Everyone is logged out after every restart

`SESSION_SECRET` isn't set, so the app generates a new random one on each boot,
which invalidates all existing sessions. Set a fixed value in `.env`:

```
SESSION_SECRET=<paste the output of: openssl rand -hex 32>
```

## The UI didn't change after updating

Your browser cached the old files. Hard-refresh with `Ctrl`+`Shift`+`R` (or
`Cmd`+`Shift`+`R`). Also confirm you actually pulled the new image
(`docker compose pull`, then `docker compose up -d`).

## Still stuck?

Grab the app logs (`docker compose logs --tail=100 app`) and open an issue at
https://github.com/Greyborne/paycycle/issues.
