# CourseNotif Secrets and Environment Hygiene

Last updated: March 11, 2026

## Scope

This document defines how secrets are stored, accessed, and rotated for CourseNotif.

## Secret inventory

| Secret | Purpose | Rotation target |
| --- | --- | --- |
| DATABASE_URL | DB connection string (includes password) | 90 days or on leak |
| SMTP_PASS | Course notification SMTP credential | 90 days |
| SMTP_PASS_AUTH | OTP auth SMTP credential | 90 days |
| OTP_PEPPER | OTP hash pepper | 180 days |
| VSB_LOGIN_USERNAME | VSB auto-login username | 90 days |
| VSB_LOGIN_PASSWORD | VSB auto-login password | 90 days |
| METRICS_BEARER_TOKEN | Protect /api/metrics and /api/worker-health | 180 days |

Note: if you use VSB_USERNAME or VSB_PASSWORD, treat them the same as VSB_LOGIN_*.

## Storage policy

1. Store all secrets in a managed secret store for each environment (dev, staging, prod).
2. Inject secrets at runtime via environment variables. Do not commit secrets to git.
3. .env.local is only for local development and must remain ignored by git.

## Access policy (least privilege)

1. Separate credentials per component when API and worker are deployed independently.
2. Use distinct SMTP credentials for OTP auth (SMTP_PASS_AUTH) and course notifications (SMTP_PASS) so revocation is scoped.
3. Provision a dedicated DB role with only the permissions needed by the app.

Example DB grants (PostgreSQL):

```sql
CREATE ROLE coursenotif_app LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE your_db TO coursenotif_app;
GRANT USAGE ON SCHEMA public TO coursenotif_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users,
  auth_otp_challenges,
  auth_sessions,
  courses,
  user_courses,
  notification_attempts,
  shared_latest_jsp_file,
  shared_vsb_session
TO coursenotif_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO coursenotif_app;
```

## Rotation process

1. Create a new secret value in the secret store.
2. Deploy updated secret to runtime configuration.
3. Verify app health and SMTP delivery.
4. Revoke the old secret.
5. Record rotation date and owner.

## Incident response

1. Rotate affected secrets immediately.
2. Invalidate sessions or tokens if applicable.
3. Audit access logs in the secret store and infrastructure.
