#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="/tmp/coursenotif_monitor_supervisor.pid"
WATCHDOG_PID_FILE="/tmp/coursenotif_monitor_watchdog.pid"

new_pid=""
if [[ -f "${PID_FILE}" ]]; then
  existing_pid="$(cat "${PID_FILE}")"
  if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" >/dev/null 2>&1; then
    echo "Monitor supervisor already running (pid=${existing_pid})."
    new_pid="${existing_pid}"
  else
    rm -f "${PID_FILE}"
  fi
fi

if [[ -z "${new_pid}" ]]; then
  nohup bash "${ROOT_DIR}/scripts/monitor-supervisor.sh" >/tmp/coursenotif_monitor_supervisor.nohup.log 2>&1 &
  new_pid=$!
  echo "${new_pid}" > "${PID_FILE}"
  echo "Started monitor supervisor (pid=${new_pid})."
else
  echo "Monitor supervisor PID file: ${PID_FILE}"
fi

watchdog_pid=""
if [[ -f "${WATCHDOG_PID_FILE}" ]]; then
  existing_watchdog_pid="$(cat "${WATCHDOG_PID_FILE}")"
  if [[ -n "${existing_watchdog_pid}" ]] && kill -0 "${existing_watchdog_pid}" >/dev/null 2>&1; then
    echo "Monitor watchdog already running (pid=${existing_watchdog_pid})."
    watchdog_pid="${existing_watchdog_pid}"
  else
    rm -f "${WATCHDOG_PID_FILE}"
  fi
fi

if [[ -z "${watchdog_pid}" ]]; then
  nohup bash "${ROOT_DIR}/scripts/monitor-watchdog.sh" >/tmp/coursenotif_monitor_watchdog.nohup.log 2>&1 &
  watchdog_pid=$!
  echo "${watchdog_pid}" > "${WATCHDOG_PID_FILE}"
  echo "Started monitor watchdog (pid=${watchdog_pid})."
else
  echo "Monitor watchdog PID file: ${WATCHDOG_PID_FILE}"
fi

echo "Supervisor logs: /tmp/coursenotif_monitor_supervisor.out.log /tmp/coursenotif_monitor_supervisor.err.log"
echo "Watchdog logs: /tmp/coursenotif_monitor_watchdog.out.log /tmp/coursenotif_monitor_watchdog.err.log"
