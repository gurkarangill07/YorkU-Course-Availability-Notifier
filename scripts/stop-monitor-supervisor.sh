#!/usr/bin/env bash
set -euo pipefail

PID_FILE="/tmp/coursenotif_monitor_supervisor.pid"
WATCHDOG_PID_FILE="/tmp/coursenotif_monitor_watchdog.pid"

if [[ -f "${PID_FILE}" ]]; then
  pid="$(cat "${PID_FILE}")"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill "${pid}" || true
    sleep 1
    if kill -0 "${pid}" >/dev/null 2>&1; then
      kill -9 "${pid}" || true
    fi
    echo "Stopped monitor supervisor (pid=${pid})."
  fi
  rm -f "${PID_FILE}"
fi

pkill -f "scripts/monitor-supervisor.sh" >/dev/null 2>&1 || true

if [[ -f "${WATCHDOG_PID_FILE}" ]]; then
  pid="$(cat "${WATCHDOG_PID_FILE}")"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill "${pid}" || true
    sleep 1
    if kill -0 "${pid}" >/dev/null 2>&1; then
      kill -9 "${pid}" || true
    fi
    echo "Stopped monitor watchdog (pid=${pid})."
  fi
  rm -f "${WATCHDOG_PID_FILE}"
fi

pkill -f "scripts/monitor-watchdog.sh" >/dev/null 2>&1 || true
