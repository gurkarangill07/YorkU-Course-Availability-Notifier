# CourseNotif Roadmap (Implementation-Aligned)

Last updated: February 25, 2026

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

## Phase 1: Notification delivery reliability

Goal: harden live SMTP delivery for reliability and traceability.

- Keep SMTP provider integration configurable (currently Gmail-compatible).
- Persist delivery attempts and outcomes in DB.
- Add retry/backoff for transient send failures.
- Add idempotency guard for open-seat events.
- Add dedupe/suppression window policy.

Exit criteria:
- End-to-end open-seat flow sends real emails in production.
- Failed sends are retried and recorded with final status.
- Duplicate notifications for one event are prevented.

## Phase 2: Auth and access control

Goal: prevent unauthorized read/write of tracking data.

- Add account authentication (session or token).
- Bind tracked-course operations to authenticated identity.
- Remove dependency on email query/body ownership checks.
- Add route-level rate limiting and stricter input validation.
- Add deployment checklist for secret management.

Exit criteria:
- Only authenticated users can manage their own tracked courses.
- Unauthorized requests are blocked and auditable.

## Phase 3: Tests and CI quality gates

Goal: reduce regressions and raise deploy confidence.

- Add unit tests for `src/jspParser.js` payload variants.
- Add unit tests for `src/monitorService.js` session/error/notify paths.
- Add integration tests for API routes (`resolve`, list/add/delete tracking).
- Add fixtures for representative `getClassData.jsp` responses.
- Add CI checks for tests + syntax/static validation.

Exit criteria:
- Parser, monitor, and API core paths are covered by automated tests.
- CI blocks merges on failing checks.

## Phase 4: Observability and operations hardening

Goal: make runtime behavior visible and recoverable.

- Add structured logging for API and worker.
- Add metrics for scan counts, failures, notifications, and latencies.
- Add alerts for repeated worker crashes/session-expired loops.
- Add runbooks for VSB session recovery, provider outage, and DB connectivity failure.
- Add worker health checks for supervisor/launchd workflows.

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

1. Add delivery logging/retries/idempotency for SMTP notifications.
2. Add parser + monitor + API automated tests.
3. Introduce authentication and identity-bound ownership checks.
4. Add structured logs/metrics and operational alerts/runbooks.
