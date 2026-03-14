# CourseNotif Deployment Checklist

Last updated: March 14, 2026

## Pre-deploy

1. Confirm secret store entries exist and are current: DATABASE_URL, SMTP_PASS, SMTP_PASS_AUTH, OTP_PEPPER, VSB_LOGIN_USERNAME, VSB_LOGIN_PASSWORD, METRICS_BEARER_TOKEN (if used).
2. Confirm DB role is least-privilege and uses a dedicated credential.
3. Confirm required envs for the target runtime. API should only receive DATABASE_URL, OTP_PEPPER, SMTP_PASS_AUTH, SMTP_HOST/PORT/SECURE, SMTP_USER, SMTP_FROM, APP_BASE_URL, and optional METRICS_BEARER_TOKEN. Worker should only receive DATABASE_URL, SMTP_PASS, SMTP_HOST/PORT/SECURE, SMTP_USER, SMTP_FROM, APP_BASE_URL, and VSB_* when browser mode is enabled.
4. Run `npm run ci` for the release candidate.
5. Apply schema: `psql "$DATABASE_URL" -f db/schema.sql`.
6. Run config validation for each runtime (`CONFIG_RUNTIME=api npm run config:validate` and `CONFIG_RUNTIME=worker npm run config:validate`). For mode-specific worker checks such as init-login, set `CONFIG_MODE=init_login`. This covers policy values like MIN_POLL_INTERVAL_SECONDS, MONITOR_EMERGENCY_DISABLE, MONITOR_EMERGENCY_REASON.

## Deploy

1. Deploy API and worker with updated env.
2. Run `npm run monitor:health` and check `/api/health` and `/api/worker-health`.
3. If browser mode is enabled, run `npm run monitor:init-login` to refresh the shared session.

## Post-deploy verification

1. Confirm `/api/metrics` and `/api/worker-health` return ok (bearer token if configured).
2. Trigger a test OTP send and confirm delivery.
3. Watch logs for SMTP failures and session-expiry loops.

## Rollback

1. Revert to previous build artifacts.
2. Restore previous secrets only if rollback requires them.
3. Verify health checks after rollback.

## Recordkeeping

1. Update the secret rotation log with date and owner.
2. Update docs/ROADMAP.md, README.md, and context if runtime behavior changed.
