# CourseNotif Operations Runbook

Last updated: March 10, 2026

## Scope

This runbook covers common production/runtime incidents for:

- worker crash loops
- VSB session expiry loops
- SMTP/provider outages
- DB connectivity failures
- API and worker health degradation

## Quick health checks

```bash
# API health
curl -sS http://localhost:3000/api/health

# Worker health (API surface)
curl -sS http://localhost:3000/api/worker-health

# Worker health (local CLI)
npm run monitor:health

# Metrics
curl -sS http://localhost:3000/api/metrics
```

If `METRICS_BEARER_TOKEN` is configured:

```bash
curl -sS -H "Authorization: Bearer $METRICS_BEARER_TOKEN" http://localhost:3000/api/metrics
curl -sS -H "Authorization: Bearer $METRICS_BEARER_TOKEN" http://localhost:3000/api/worker-health
```

## Alert conditions (recommended)

Use these as baseline thresholds; tune based on real traffic.

1. Worker unhealthy:
- Trigger when `/api/worker-health` returns non-200 for >= 2 consecutive checks.
- Trigger when `npm run monitor:health` exits non-zero.

2. Worker crash loop:
- Trigger when supervisor log shows repeated exits in a short window.
- Example signal: multiple lines like `worker exited with code` in `/tmp/coursenotif_monitor_supervisor.out.log` within 10 minutes.

3. Session expiry loop:
- Trigger when `coursenotif_worker_session_expired_loop_total` increases repeatedly (for example, >= 3 times in 15 minutes).
- Correlate with repeated session failure owner alerts.

4. Provider outage / send degradation:
- Trigger when `coursenotif_notification_email_send_failures_total` and `coursenotif_worker_dispatch_failed_total` increase while `coursenotif_notification_emails_sent_total` is flat.
- Watch for spikes in `coursenotif_worker_dispatch_retried_total`.

5. DB connectivity issues:
- Trigger on repeated worker fatal events (`coursenotif_worker_process_fatal_total` increasing) with DB connection errors in structured logs.
- Trigger on elevated API 5xx metrics (`coursenotif_api_http_server_errors_total`).

## Incident playbooks

### A) Worker crash loop

Detection:

- `npm run monitor:health` returns `ok: false`.
- Supervisor logs show rapid restart lines.

Immediate actions:

1. Inspect latest fatal logs:
```bash
tail -n 200 /tmp/coursenotif_monitor_supervisor.err.log
tail -n 200 /tmp/coursenotif_monitor_supervisor.out.log
```
2. Validate env and DB reachability.
3. Restart worker supervisor:
```bash
bash scripts/stop-monitor-supervisor.sh
bash scripts/start-monitor-supervisor.sh
```

Verification:

- `npm run monitor:health` returns `ok: true`.
- `coursenotif_worker_monitor_runs_total` increases.

### B) VSB session expiry loop

Detection:

- `coursenotif_worker_session_expired_loop_total` increasing.
- Logs show auto re-login skipped/failed repeatedly.

Immediate actions:

1. Reinitialize session manually:
```bash
npm run monitor:init-login:local
```
2. If auth flow changed, run with browser open:
```bash
npm run monitor:init-login:keep-open:local
```
3. Validate selectors/credentials in `.env.local`:
- `VSB_LOGIN_*`
- `VSB_LOGGED_OUT_SELECTOR`
- `VSB_URL`

Verification:

- Worker health returns `ok: true`.
- Session-loop metric stops increasing.

### C) SMTP/provider outage

Detection:

- `coursenotif_notification_email_send_failures_total` rising.
- `coursenotif_worker_dispatch_failed_total` rising.

Immediate actions:

1. Check SMTP credentials/env:
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
2. Check provider status and account limits.
3. If temporary provider issue, keep worker running to allow retries.
4. If credentials are broken, rotate app password and restart worker.

Verification:

- `coursenotif_notification_emails_sent_total` resumes increasing.
- Dispatch retry/failure rates return to baseline.

### D) DB connectivity failure

Detection:

- Worker/API logs include DB connection errors.
- Worker health endpoint goes stale or fatal.
- API 5xx increases.

Immediate actions:

1. Validate DB URL and network:
```bash
echo "$DATABASE_URL"
```
2. Test DB connection manually:
```bash
/opt/homebrew/opt/postgresql@16/bin/psql "$DATABASE_URL" -c "SELECT NOW();"
```
3. If DB recovered, restart API and worker.

Verification:

- `/api/health` returns `{"ok":true}`.
- `/api/worker-health` returns `ok: true`.
- API 5xx and fatal worker logs stop.

## Structured logs

Structured logging fields include:

- `ts`, `level`, `component`, `event`, `message`
- contextual IDs (such as `attemptId`, `userCourseId`, `cartId`) where available
- normalized error fields (`errorName`, `errorMessage`, `errorCode`, `errorStack`)

Recommended settings:

```bash
LOG_LEVEL=info
LOG_FORMAT=json
```
