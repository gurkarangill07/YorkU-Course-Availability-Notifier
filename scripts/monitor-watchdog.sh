#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_LOG="/tmp/coursenotif_monitor_watchdog.out.log"
ERR_LOG="/tmp/coursenotif_monitor_watchdog.err.log"
SLEEP_SECONDS="${MONITOR_SUPERVISOR_WATCHDOG_INTERVAL_SECONDS:-60}"

while true; do
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] running watchdog health check" >> "${OUT_LOG}"
  set +e
  bash "${ROOT_DIR}/scripts/with-env.sh" node "${ROOT_DIR}/scripts/check-worker-health.js" --alert-on-failure --restart supervisor >> "${OUT_LOG}" 2>> "${ERR_LOG}"
  exit_code=$?
  set -e
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] watchdog completed with code ${exit_code}; sleeping ${SLEEP_SECONDS}s" >> "${OUT_LOG}"
  sleep "${SLEEP_SECONDS}"
done
