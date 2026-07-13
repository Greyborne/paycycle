# Security Policy

PayCycle handles personal financial data, so security reports are taken
seriously and welcomed.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's
[**Report a vulnerability**](https://github.com/Greyborne/paycycle/security/advisories/new)
flow (the **Security** tab → *Report a vulnerability*). This opens a private
advisory visible only to you and the maintainers.

When reporting, please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof of concept.
- The version / image tag affected (e.g. `chazwall/paycycle:0.2.0`).
- Any suggested remediation, if you have one.

You can expect an initial acknowledgement within a few days. Once a fix is
released, we're happy to credit you in the advisory unless you'd prefer to stay
anonymous.

## Supported versions

PayCycle is a small project released as rolling versions. Security fixes land on
`main` and ship in the next tagged release (and the `:latest` image). Please
make sure you can reproduce an issue on the latest release before reporting.

| Version            | Supported |
| ------------------ | --------- |
| Latest release     | ✅        |
| Older releases     | ❌        |

## Deployment hardening

A few self-hosting reminders that prevent the most common issues:

- **Set a strong `SESSION_SECRET`.** Without it, sessions use a random
  per-boot secret (logins drop on restart) — never run production that way.
- **Keep the database private.** The bundled `docker-compose.yml` does not
  publish Postgres to the host; don't expose port 5432 publicly.
- **Terminate TLS in front of the app** (e.g. a reverse proxy) and set
  `SECURE_COOKIES=true` / `TRUST_PROXY=true` when behind one.
  `TRUST_PROXY=true` trusts exactly one proxy hop (the safe default for a
  single reverse proxy); if requests pass through more than one proxy before
  reaching the app, set `TRUST_PROXY=<number of proxies>` instead.
- **Restrict registration** with `ALLOW_REGISTRATION=false` once your accounts
  exist, so a public instance can't be signed up to by strangers.
