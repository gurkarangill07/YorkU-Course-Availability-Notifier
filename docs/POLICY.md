# CourseNotif Compliance and Policy Controls

Last updated: March 11, 2026

## Scope

This document defines runtime guardrails for monitor execution cadence and emergency stop behavior.

## Policy controls

1. Minimum poll interval guardrail
- `MONITOR_INTERVAL_SECONDS` is the requested monitor cadence.
- `MIN_POLL_INTERVAL_SECONDS` is the enforced lower bound.
- Effective cadence is `max(MONITOR_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS)`.
- When clamped, worker logs `worker.policy.poll_interval_clamped` and increments `coursenotif_worker_policy_poll_interval_clamped_total`.

2. Emergency monitoring disable
- `MONITOR_EMERGENCY_DISABLE=true` disables monitoring execution modes:
  - default loop mode
  - `--once`
  - `--check-new-course <userId> <cartId>`
- `MONITOR_EMERGENCY_REASON` documents why monitoring is disabled.
- While disabled, worker logs `worker.policy.emergency_disable_skip`, writes worker health state `disabled`, and increments `coursenotif_worker_emergency_disable_skips_total`.

3. Allowed recovery operation during emergency disable
- `--init-login` and `--init-login --keep-open` remain enabled.
- This allows session/login troubleshooting without resuming seat monitoring.

## Operational procedure

1. Enable emergency disable
```bash
export MONITOR_EMERGENCY_DISABLE=true
export MONITOR_EMERGENCY_REASON="Incident ticket INC-123: provider outage."
```
2. Restart worker process/supervisor so new env is loaded.
3. Verify:
```bash
npm run monitor:health
curl -sS -H "Authorization: Bearer $METRICS_BEARER_TOKEN" http://localhost:3000/api/metrics
```
4. Disable emergency mode after remediation:
```bash
export MONITOR_EMERGENCY_DISABLE=false
```

## Policy assumptions

- Monitoring cadence must not be set below approved operational limits.
- Emergency disable is a temporary safety control, not a long-term operating mode.
- Any emergency-disable period should include an incident reference in `MONITOR_EMERGENCY_REASON`.

## Review cadence

- Review this policy quarterly or after any major incident.
- Keep this document aligned with `README.md`, `context`, and `docs/ROADMAP.md`.
