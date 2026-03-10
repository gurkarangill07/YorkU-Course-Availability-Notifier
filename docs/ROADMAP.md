# CourseNotif Roadmap (Implementation-Aligned)

Last updated: March 9, 2026

Planning note: keep this file aligned with `README.md` and `context` after major implementation changes.

## Current baseline (already done)

- PostgreSQL schema and DB layer are implemented (`db/schema.sql`, `src/db.js`).
- Express API exists for user resolve and tracked-course CRUD (`src/apiServer.js`).
- Web UI exists and is connected to `/api/*` (`index.html`).
- Monitoring worker exists with `--init-login`, `--once`, loop mode, and immediate check mode (`src/worker.js`).
- VSB source modes exist (`browser`, `filesystem`, `db`) via `src/vsbSource.js`.
- Browser mode includes:
  - live `getClassData.jsp` capture
  - tracked-course sync into VSB
  - cached JSP reuse within refresh window
  - auto re-login fallback flow
  - Playwright browser-context auto recovery when context/page closes
- Local env runners exist (`web:local`, `monitor:*:local`) through `scripts/with-env.sh`.
- Background worker ops scripts exist:
  - supervisor loop (`scripts/start-monitor-supervisor.sh`, `scripts/stop-monitor-supervisor.sh`)
  - macOS launchd install/uninstall helpers
- Notification functions send SMTP email via `nodemailer` (Gmail-compatible).
- Notification delivery reliability is implemented via `notification_attempts`:
  - persisted delivery attempts/outcomes
  - transient-failure retry/backoff
  - idempotency guard for open-seat events
  - suppression-window duplicate prevention
- Passwordless email OTP auth + session cookie flow exists for API access control.
- Automated tests are in place for parser, monitor dispatch logic, and API auth/course CRUD basics.
- CI checks run smoke + tests on PRs and main pushes.

## Phase 1: Notification delivery reliability (completed)

Goal: harden live SMTP delivery for reliability and traceability.

Delivered:

- SMTP provider integration remains configurable (currently Gmail-compatible).
- Delivery attempts and outcomes are persisted in DB.
- Retry/backoff for transient send failures is implemented.
- Idempotency guard for open-seat events is implemented.
- Dedupe/suppression window policy is implemented.

Exit criteria:
- End-to-end open-seat flow sends real emails in production.
- Failed sends are retried and recorded with final status.
- Duplicate notifications for one event are prevented.

## Phase 2: Auth and access control

Goal: prevent unauthorized read/write of tracking data.

- Keep passwordless auth/session flow and harden it for production.
- Enforce stronger abuse controls (IP/device limits, lockouts, throttling).
- Add session management and revocation UX.
- Add route-level rate limiting and stricter input validation.
- Add deployment checklist for secret management.

Exit criteria:
- Only authenticated users can manage their own tracked courses.
- Unauthorized requests are blocked and auditable.

## Phase 3: Tests and CI quality gates (in progress)

Goal: reduce regressions and raise deploy confidence.

Delivered so far:

- Unit tests for `src/jspParser.js` payload variants.
- Unit tests for `src/monitorService.js` dispatch retry/success/failure paths.
- Integration test for API auth + tracked-course CRUD.
- CI workflow runs schema apply + smoke + tests and fails on regressions.

Remaining:

- Expand parser fixtures for more real-world `getClassData.jsp` variants.
- Add monitor tests for session recovery branches and full scan loops.
- Add broader API integration coverage for negative/error cases and authorization edges.

Exit criteria:
- Parser, monitor, and API core paths are covered by automated tests.
- CI blocks merges on failing checks.

## Phase 4: Observability and operations hardening

Goal: make runtime behavior visible and recoverable.

Delivered so far:

- Structured logs are implemented across API, worker, monitor, notification, and VSB source modules.
- API exposes Prometheus-style metrics at `/api/metrics` (optional bearer auth).
- Worker heartbeat snapshots and health evaluation are implemented:
  - `/api/worker-health`
  - `npm run monitor:health`
- Initial operations runbook is documented (`docs/RUNBOOK.md`).

Remaining:

- Extend metrics export strategy for worker-only counters into centralized scrape pipelines.
- Wire concrete alert automation (for example, cron/monitor jobs) for crash loops/session-expired loops.
- Add supervisor/launchd-specific health checks and restart policies tied to alert thresholds.
- Expand runbook automation scripts for common remediation tasks.

Exit criteria:
- Operators can detect, diagnose, and recover common failures quickly.
- On-call recovery steps are documented and tested.

## Phase 5: Product/UX improvements

Goal: improve user trust and self-serve troubleshooting.

- Show per-course status (last checked time, latest `os`, alert state).
- Add pause/resume tracking controls.
- Add clearer UI errors for session/auth failures.
- Add optional immediate recheck action from UI.
- Improve cart ID validation and feedback.

Exit criteria:
- Users can manage common tracking and recovery tasks from UI without manual support.

## Parallel compliance/policy track

- Confirm acceptable monitoring cadence and access constraints.
- Enforce minimum poll interval guardrails.
- Add emergency feature kill switch.
- Document compliance assumptions and periodic review process.

## Immediate next actions (recommended order)

1. Expand automated test coverage depth (parser fixtures, monitor session branches, API negative cases).
2. Introduce authentication and identity-bound ownership checks.
3. Add structured logs/metrics and operational alerts/runbooks.
