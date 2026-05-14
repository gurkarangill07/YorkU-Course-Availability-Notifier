# YorkU Course Availability Notifier

YorkU Course Availability Notifier monitors tracked courses and notifies users when seats open (`os > 0`) using VSB `getClassData.jsp` responses.

## Current status (implemented)

- PostgreSQL-backed persistence (`users`, `courses`, `user_courses`, shared JSP cache, shared session state).
- Express API + single-page web UI (`index.html`) for:
  - passwordless sign-in via email OTP
  - email input starts blank on unauthenticated page load (no localStorage prefill)
  - authenticated session view shows the signed-in email in the input
  - inline auth/session recovery guidance instead of generic browser alerts for most sign-in and session-expiry flows
  - adding/listing/removing tracked courses
  - per-user tracked-course cap of 3 saved tracked courses total, with inline guidance when the limit is reached
  - recent notification-attempt reporting for signed-in users
  - pause/resume tracking controls
  - per-course tracking status labels
  - stricter 6-character cart-id validation with inline input guidance
  - optional per-user custom course display name
- Auth hardening includes:
  - OTP resend cooldowns and max failed-attempt caps
  - route-level rate limits for OTP and authenticated write endpoints
  - shared DB-backed rate limiting across API instances
- Monitoring worker (`src/worker.js`) with modes:
  - `--init-login`
  - `--init-login --keep-open`
  - `--once`
  - loop mode (default)
  - resumed/newly-tracked courses force one fresh JSP capture before cache reuse
- VSB source modes:
  - `browser` (Playwright automation and live response capture)
  - `filesystem` (read JSP files from directory)
  - `db` (reuse latest cached JSP from DB)
- Session resilience in browser mode:
  - auto re-login support
  - shared session expiry tracking and owner alert emails
  - browser context auto-recovery when Playwright context/page is closed unexpectedly
- Notifications are sent using SMTP via `nodemailer` (`src/notification.js`) with:
  - persisted delivery attempts in `notification_attempts`
  - retry/backoff for transient delivery failures
  - idempotency guard per tracked open-seat event
  - suppression window policy to prevent near-duplicate sends
- Observability baseline is implemented:
  - structured logs for API/worker/monitor/notification/VSB flows
  - in-process metrics registry with Prometheus-style `/api/metrics`
  - worker heartbeat snapshots + health checks (`/api/worker-health`, `npm run monitor:health`)
  - worker-only metrics exposure for centralized scraping via `/api/worker-metrics`
  - watchdog alert/restart automation for unhealthy workers, session-expiry loops, and supervisor crash loops
  - supervisor crash-loop backoff plus launchd watchdog installation helpers
  - operations runbook (`docs/RUNBOOK.md`)
- Compliance/policy controls are implemented:
  - minimum monitor poll interval guardrail (`MIN_POLL_INTERVAL_SECONDS`)
  - emergency monitoring kill switch (`MONITOR_EMERGENCY_DISABLE`)
  - policy assumptions documented in `docs/POLICY.md`
- Secret management policy, rotation process, and deployment checklist are documented (`docs/SECRETS.md`, `docs/DEPLOYMENT.md`).
- Automated tests exist for parser, monitor dispatch logic, auth hardening, ops-hardening/watchdog logic, deterministic browser recovery paths, and API auth/course flows (`test/*.test.js`).
- CI workflow runs on PRs and `main` pushes and fails on smoke/test regressions (`.github/workflows/ci.yml`).

## Key files

- `src/apiServer.js`: API server + static UI serving
- `index.html`: frontend
- `src/worker.js`: monitor runner CLI
- `src/monitorService.js`: monitoring flow and session-failure handling
- `src/vsbBrowserSource.js`: Playwright automation and JSP capture
- `src/vsbSource.js`: source mode switcher (`browser` / `filesystem` / `db`)
- `src/jspParser.js`: parser for JSON/XML-like JSP payload variants
- `src/db.js`: PostgreSQL access layer
- `src/logger.js`: structured logging utility
- `src/metrics.js`: metrics registry and Prometheus renderer
- `src/workerHealth.js`: worker heartbeat file helpers and health evaluator
- `src/opsHardening.js`: watchdog thresholds, cooldowns, and restart decisions
- `db/schema.sql`: schema and compatibility migration guards
- `docs/RUNBOOK.md`: incident runbooks and alert conditions
- `docs/POLICY.md`: compliance guardrails and emergency disable policy
- `test/*.test.js`: unit + integration tests
- `.github/workflows/ci.yml`: CI gates (smoke + tests)
- `scripts/check-worker-health.js`: worker health CLI + alert/restart watchdog entrypoint
- `scripts/*.sh`: env loader, supervisor scripts, watchdog loop, and launchd helpers

## Setup

1. Install dependencies and browser

```bash
npm install
npx playwright install chromium
```

2. Configure environment variables

You can start from the template:

```bash
cp .env.example .env.local
```

Minimum required:

```bash
export DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DB_NAME"
```

If your Postgres provider requires TLS but uses a self-signed/intermediate cert chain (common with hosted/Supabase setups), optionally set:

```bash
export PG_SSL_REJECT_UNAUTHORIZED="false"
```

Common runtime settings:

```bash
export PORT="3000"
export APP_BASE_URL="http://localhost:3000"      # used in notification email links; required for worker monitoring modes
export MONITOR_INTERVAL_SECONDS="60"
export MIN_POLL_INTERVAL_SECONDS="30"             # enforces minimum monitor cadence
export MONITOR_EMERGENCY_DISABLE="false"          # true disables loop/once/immediate check modes
export MONITOR_EMERGENCY_REASON="Monitoring paused for incident response."
export SESSION_DURATION_MINUTES="90"
export VSB_REFRESH_INTERVAL_MINUTES="30"
export OWNER_ALERT_EMAIL="you@example.com"   # optional owner alert target
```

SMTP notification settings (Gmail example):

```bash
export SMTP_HOST="smtp.gmail.com"
export SMTP_PORT="465"
export SMTP_SECURE="true"
export SMTP_USER="yourgmail@gmail.com"
export SMTP_PASS="your_gmail_app_password"
export SMTP_PASS_AUTH="your_auth_gmail_app_password"
export SMTP_FROM="YorkU Course Availability Notifier <yourgmail@gmail.com>"
```

Notification reliability policy (optional overrides):

```bash
export NOTIFICATION_RETRY_BASE_SECONDS="30"
export NOTIFICATION_RETRY_MAX_SECONDS="900"
export NOTIFICATION_MAX_ATTEMPTS="5"
export NOTIFICATION_SUPPRESSION_WINDOW_MINUTES="30"
export NOTIFICATION_DISPATCH_BATCH_SIZE="25"
export NOTIFICATION_DISPATCH_LEASE_SECONDS="300"
export INVALID_CODE_MAX_ATTEMPTS="2"             # after N invalid detections, mark as invalid
```

Passwordless auth settings:

```bash
export AUTH_OTP_TTL_MINUTES="10"
export AUTH_OTP_RESEND_COOLDOWN_SECONDS="60"
export AUTH_OTP_MAX_FAILED_ATTEMPTS="5"
export AUTH_SESSION_DAYS="30"
export AUTH_COOKIE_SECURE="true"              # set to false only for local HTTP development
export AUTH_RATE_LIMIT_WINDOW_SECONDS="600"
export AUTH_SEND_OTP_MAX_PER_IP="5"
export AUTH_SEND_OTP_MAX_PER_EMAIL="3"
export AUTH_VERIFY_OTP_MAX_PER_IP="10"
export AUTH_VERIFY_OTP_MAX_PER_EMAIL="5"
export AUTH_VERIFY_OTP_LOCKOUT_SECONDS="900"
export AUTHENTICATED_WRITE_RATE_LIMIT_WINDOW_SECONDS="60"
export AUTHENTICATED_WRITE_RATE_LIMIT_MAX="30"
export OTP_PEPPER="change_this_random_secret"
```

Observability and operations settings (optional but recommended):

```bash
export LOG_LEVEL="info"                        # debug | info | warn | error
export LOG_FORMAT="text"                       # text | json
export METRICS_BEARER_TOKEN="change_this_metrics_token"  # required to enable /api/metrics, /api/worker-metrics, and /api/worker-health
export WORKER_HEALTH_PATH="/tmp/coursenotif_worker_health.json"
export WORKER_METRICS_PATH="/tmp/coursenotif_worker_metrics.prom"
export WORKER_HEALTH_MAX_STALE_SECONDS="300"
export WORKER_HEALTH_ALERT_CONSECUTIVE_FAILURES="2"
export WORKER_SESSION_EXPIRED_ALERT_THRESHOLD="3"
export WORKER_SESSION_EXPIRED_ALERT_WINDOW_SECONDS="900"
export WORKER_ALERT_COOLDOWN_SECONDS="1800"
export WORKER_HEALTH_RESTART_CONSECUTIVE_FAILURES="3"
export WORKER_RESTART_COOLDOWN_SECONDS="900"
export WORKER_WATCHDOG_STATE_PATH="/tmp/coursenotif_worker_watchdog_state.json"
export MONITOR_SUPERVISOR_STATE_PATH="/tmp/coursenotif_monitor_supervisor_state.json"
export MONITOR_SUPERVISOR_RESTART_SECONDS="5"
export MONITOR_SUPERVISOR_CRASH_LOOP_WINDOW_SECONDS="600"
export MONITOR_SUPERVISOR_CRASH_LOOP_MAX_RESTARTS="5"
export MONITOR_SUPERVISOR_MAX_RESTART_SECONDS="300"
export MONITOR_SUPERVISOR_WATCHDOG_INTERVAL_SECONDS="60"
export WORKER_WATCHDOG_INTERVAL_SECONDS="60"   # launchd watchdog interval
```

Compliance controls behavior:

- If `MONITOR_INTERVAL_SECONDS` is lower than `MIN_POLL_INTERVAL_SECONDS`, worker automatically clamps to the minimum.
- If `MONITOR_EMERGENCY_DISABLE=true`, worker skips monitoring modes (`--once`, default loop) and writes worker health with `state: "disabled"`.
- `--init-login` and `--init-login --keep-open` remain available during emergency disable so session recovery can still be performed.

Gmail requirement:

- Enable 2-Step Verification on the Gmail account.
- Generate an App Password and set it as `SMTP_PASS`.

Source mode:

```bash
export VSB_SOURCE_MODE="browser"             # browser | filesystem | db
```

Browser mode essentials:

```bash
export VSB_URL="https://your-vsb-url"
export VSB_USER_DATA_DIR=".data/vsb-profile"
export VSB_HEADLESS="false"
```

Browser mode selectors and timing (optional overrides):

```bash
export VSB_SEARCH_SELECTOR="input[placeholder*='Course Number, Title']"
export VSB_FALL_WINTER_SELECTOR="input[type='radio']"
export VSB_DROPDOWN_OPTION_SELECTOR="[role='option'], .dropdown-item, .ui-menu-item, li"
export VSB_COURSE_ROW_SELECTOR="tr, li, .course, .course-row, .selection, .block, [class*='course']"
export VSB_COURSE_PRESENCE_SELECTOR="tr, li, .course, .course-row, .selection, .block, [class*='course']"
export VSB_COURSE_CHECKBOX_SELECTOR="input[type='checkbox'], [role='checkbox']"
export VSB_CHECKBOX_TIMEOUT_MS="6000"
export VSB_SEARCH_TIMEOUT_MS="15000"
export VSB_DROPDOWN_TIMEOUT_MS="10000"
export VSB_CAPTURE_WAIT_MS="2000"
export VSB_LOGIN_WAIT_SECONDS="600"
```

Browser mode session and auto re-login (optional, recommended):

```bash
export VSB_SYNC_TRACKED_COURSES_ON_START="true"
export VSB_SYNC_TRACKED_COURSES_LIMIT="50"
export VSB_LOGGED_OUT_SELECTOR="input[type='password'], form[action*='login'], button[type='submit']"

export VSB_AUTO_RELOGIN_ENABLED="true"
export VSB_LOGIN_USERNAME="your_username_or_email"
export VSB_LOGIN_PASSWORD="your_password"
export VSB_LOGIN_USERNAME_SELECTOR="input[type='email'], input[name='username'], input[name='user']"
export VSB_LOGIN_PASSWORD_SELECTOR="input[type='password']"
export VSB_LOGIN_SUBMIT_SELECTOR="button[type='submit'], input[type='submit'], button[name='login']"
export VSB_LOGIN_CONTINUE_SELECTOR="a[href*='schedulebuilder.yorku.ca'], a:has-text('Visual Schedule Builder')"
export VSB_POST_LOGIN_WAIT_MS="1500"
```

Filesystem mode only:

```bash
export JSP_SOURCE_DIR="/absolute/path/to/jsp/files"
```

3. Apply schema

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

If `psql` is not on PATH (common on macOS/Homebrew), use:

```bash
/opt/homebrew/opt/postgresql@16/bin/psql "$DATABASE_URL" -f db/schema.sql
```

4. Validate runtime config before starting services

API preflight:

```bash
npm run config:validate -- --runtime api
```

Worker preflight:

```bash
npm run config:validate -- --runtime worker
```

Worker init-login preflight:

```bash
npm run config:validate -- --runtime worker --mode init_login
```

If you keep env vars in `.env.local`, wrap the same command with `scripts/with-env.sh`, for example:

```bash
bash scripts/with-env.sh npm run config:validate -- --runtime worker
```

## Secrets and deployment hygiene

Secrets are not stored in the repo. Use a secret manager and inject env at runtime. The full policy, rotation process, and least-privilege guidance live in `docs/SECRETS.md`. The deployment checklist and preflight steps are in `docs/DEPLOYMENT.md`. If API and worker are deployed separately, provide each process only the env it requires and use distinct SMTP credentials for OTP auth (`SMTP_PASS_AUTH`) vs course notifications (`SMTP_PASS`).

## Run

Start API + UI:

```bash
npm run web
```

Open `http://localhost:3000`.

Initialize shared browser session (browser mode):

```bash
npm run monitor:init-login
```

Note: `monitor:init-login` exits after session setup and closes the Playwright browser context. For manual login verification, prefer `npm run monitor:init-login:keep-open`.

Keep browser open after login (manual verification/debug):

```bash
npm run monitor:init-login:keep-open
```

Single monitor pass:

```bash
npm run monitor:once
```

Continuous loop:

```bash
npm run monitor:loop
```

Worker health check (CLI):

```bash
npm run monitor:health
```

Syntax smoke check:

```bash
npm run smoke
```

Run automated tests:

```bash
npm run db:schema:apply
npm test
```

Run config validation explicitly:

```bash
npm run config:validate -- --runtime api
npm run config:validate -- --runtime worker
npm run config:validate -- --runtime worker --mode init_login
```

Run local CI-equivalent gate:

```bash
npm run ci
```

Metrics and health endpoints:

```bash
curl -sS -H "Authorization: Bearer $METRICS_BEARER_TOKEN" http://localhost:3000/api/metrics
curl -sS -H "Authorization: Bearer $METRICS_BEARER_TOKEN" http://localhost:3000/api/worker-metrics
curl -sS -H "Authorization: Bearer $METRICS_BEARER_TOKEN" http://localhost:3000/api/worker-health
```

These observability endpoints return `503` until `METRICS_BEARER_TOKEN` is configured.

## Local env helpers (`.env.local`)

Use wrapper scripts if you keep env vars in `.env.local`:

```bash
bash scripts/with-env.sh npm run config:validate -- --runtime api
bash scripts/with-env.sh npm run config:validate -- --runtime worker
bash scripts/with-env.sh npm run config:validate -- --runtime worker --mode init_login
npm run web:local
npm run monitor:init-login:local
npm run monitor:init-login:keep-open:local
npm run monitor:once:local
npm run monitor:loop:local
npm run monitor:health:local
```

The wrapper script is `scripts/with-env.sh`.

## Background worker operations

Supervisor loop (manual start/stop):

```bash
bash scripts/start-monitor-supervisor.sh
bash scripts/stop-monitor-supervisor.sh
```

One-shot watchdog health/alert check:

```bash
node scripts/check-worker-health.js --alert-on-failure --restart supervisor
```

Logs:

- `/tmp/coursenotif_monitor_supervisor.out.log`
- `/tmp/coursenotif_monitor_supervisor.err.log`
- `/tmp/coursenotif_monitor_watchdog.out.log`
- `/tmp/coursenotif_monitor_watchdog.err.log`

macOS launchd (auto restart / login session):

```bash
bash scripts/install-monitor-launchd.sh
bash scripts/uninstall-monitor-launchd.sh
```

## API endpoints

- `GET /api/health`
- `GET /api/metrics` (requires bearer auth; disabled until `METRICS_BEARER_TOKEN` is configured)
- `GET /api/worker-metrics` (requires bearer auth; disabled until `METRICS_BEARER_TOKEN` is configured)
- `GET /api/worker-health` (requires bearer auth; disabled until `METRICS_BEARER_TOKEN` is configured)
- `GET /api/auth/me`
- `POST /api/auth/send-otp`
- `POST /api/auth/verify-otp`
- `POST /api/auth/logout`
- `GET /api/tracked-courses` (auth required)
- `GET /api/notification-attempts` (auth required)
- `POST /api/tracked-courses` (auth required)
- `POST /api/tracked-courses/:id/pause` (auth required)
- `POST /api/tracked-courses/:id/resume` (auth required)
- `DELETE /api/tracked-courses/:id` (auth required)
- `POST /api/tracked-courses` currently caps each user at 3 tracked courses total; posting an already-tracked cart still updates/resumes that existing row

## Current limitations

- Notification-attempt reporting is recent-history and user-scoped today; there is no separate admin dashboard or export view yet.
- OTP auth is implemented, but no external identity provider yet.
- Deterministic browser-path coverage now exists for init-login and session-recovery flows, but CI still does not exercise the live VSB site or selector drift.
- Ops alerting is email/watchdog driven today; there is not yet a hosted dashboard or pager integration.

## Runbooks

- Incident runbooks and alert conditions live in `docs/RUNBOOK.md`.

## Contributors

### Gurkaran Gill (@gurkarangill07)
- **System Architecture:** Scaffolded the project, engineered the core Playwright-based VSB monitoring engine, and connected the API to the UI.
- **Data & Persistence:** Designed the initial PostgreSQL database schema and implemented session-bound course access.
- **Authentication System:** Built passwordless OTP authentication, implemented session persistence, and hardened route-level rate limits across API instances.
- **Notification Engine:** Built the resilient notification queue featuring exponential retry backoffs, idempotency guards, and suppression windows.
- **Operations & Hardening:** Developed watchdog recovery scripts, automated worker health checks, Prometheus-style metrics, and launchd management scripts.
- **Browser Resilience:** Engineered automatic recovery workflows for unexpected Playwright browser context closures and improved VSB sync reliability.
- **UX Improvements:** Implemented pause/resume tracking controls, notification attempt reporting, per-user tracked course caps, and auth recovery UX.
- **Compliance:** Integrated policy controls including minimum monitor cadence guardrails and emergency kill switches.
- **Testing & CI/CD:** Established foundational automated test gates, deterministic browser-path test coverage, and configured the GitHub Actions CI workflow.
- **Deployment:** Finalized Vercel web application deployment setup and supervised local worker integrations.

### Aqeelah (@Kot-ux)
- **Notification Delivery:** Engineered the email notification system utilizing `nodemailer` to dispatch alerts via Gmail SMTP.
- **Config Validation:** Designed and built the comprehensive runtime configuration validation framework (including API, worker, and init-login paths) alongside rigorous tests.
- **CI Stabilization:** Stabilized the CI pipeline by ensuring cross-platform compatibility for syntax smoke checks.
- **Cross-Platform Support:** Resolved critical Windows-specific environment path issues in the worker health test suite to guarantee reliable cross-platform execution.
- **Operations Documentation:** Authored the critical secrets management policy (`docs/SECRETS.md`) and deployment preflight checklists (`docs/DEPLOYMENT.md`).

### Fawad (@Fawad922)
- **Data Validation:** Developed the invalid course code detection system, supporting alphanumeric validation and dynamically purging bad inputs after consecutive failures.
- **Deployment Infrastructure:** Extended deployment tooling by authoring the Dockerfile for Render web hosting and establishing a scheduled GitHub Actions monitoring workflow.
- **UI Refinements:** Enhanced the web dashboard tracking flows, optimizing the live UI refresh logic, session logout handling, and track-again state recovery.
- **Notification Logic:** Refined the system to handle invalid-course email dispatches to alert users when a tracked course is consistently invalid.
- **State Management:** Implemented temporal tracking updates (`updated_at`) on user course records to manage active vs. stale monitoring data.
- **Env Cleanup:** Cleaned up deployment configuration files and refreshed the environment variable template for simpler onboarding.
