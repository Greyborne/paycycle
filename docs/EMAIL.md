# Email setup (SMTP)

Email is **optional** for normal in-app use — all notifications appear in the app bell. However, **password reset and optional email digests require SMTP to be configured**.

## Environment variables

Set these in your `.env` file:

| Variable | Purpose |
|---|---|
| `SMTP_HOST` | Hostname or IP of your SMTP server (e.g. `smtp.gmail.com`). Leave empty to disable email entirely. |
| `SMTP_PORT` | Port number; typically `587` (TLS) or `465` (implicit TLS). Default is `587`. |
| `SMTP_SECURE` | Set to `true` for implicit TLS (port 465), `false` for STARTTLS (port 587). Default is `false`. |
| `SMTP_USER` | Username for SMTP authentication, if required by your server. |
| `SMTP_PASS` | Password for SMTP authentication, if required. Consider using a Docker secret or `SMTP_PASS_FILE` for sensitive values. |
| `SMTP_FROM` | The "from" address on outgoing emails, e.g. `PayCycle <paycycle@example.com>`. |
| `APP_URL` | **Required** for password-reset links to work: the public URL users see in their browser, e.g. `https://paycycle.example.com`. If not set, links will point to the container's internal address and fail from outside. |

## Example configuration

Copy this block into your `.env` and fill in your SMTP details:

```bash
# Email (SMTP) setup — required for password reset and optional email notifications
APP_URL=https://paycycle.example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=you@example.com
SMTP_PASS=your-app-password
SMTP_FROM=PayCycle <paycycle@example.com>
```

## Testing locally with mailpit

For local development or testing without a real SMTP server, `mailpit` is a lightweight mail server that captures outgoing email:

1. Add mailpit to your `docker-compose.yml` (before the `volumes:` section):

```yaml
  mailpit:
    image: axllent/mailpit:latest
    restart: unless-stopped
    ports:
      - "8025:8025"  # Web UI for viewing emails
```

2. In your `.env`, point PayCycle to mailpit:

```bash
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
```

3. Restart: `docker compose up -d`

4. Visit http://localhost:8025 to see captured emails. No real SMTP credentials needed.

## Common providers

### Gmail (with app password)

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your.email@gmail.com
SMTP_PASS=your-16-character-app-password
SMTP_FROM=PayCycle <your.email@gmail.com>
```

First enable 2-factor authentication on your Google account, then generate an "App Password" at https://myaccount.google.com/apppasswords.

### SendGrid

```bash
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=apikey
SMTP_PASS=SG.your-api-key
SMTP_FROM=PayCycle <noreply@example.com>
```

Use the literal string `apikey` as the user, and your SendGrid API key as the password.

## Checking if email is working

Once configured, triggering a password reset or enabling email notifications will test your setup. Check the app logs for send errors: `docker compose logs app | grep -i smtp` or `grep -i mail`.
