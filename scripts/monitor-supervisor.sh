#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_LOG="/tmp/coursenotif_monitor_supervisor.out.log"
ERR_LOG="/tmp/coursenotif_monitor_supervisor.err.log"
STATE_PATH="${MONITOR_SUPERVISOR_STATE_PATH:-/tmp/coursenotif_monitor_supervisor_state.json}"
HEALTH_PATH="${WORKER_HEALTH_PATH:-/tmp/coursenotif_worker_health.json}"
BASE_SLEEP_SECONDS="${MONITOR_SUPERVISOR_RESTART_SECONDS:-5}"
WINDOW_SECONDS="${MONITOR_SUPERVISOR_CRASH_LOOP_WINDOW_SECONDS:-600}"
MAX_RESTARTS="${MONITOR_SUPERVISOR_CRASH_LOOP_MAX_RESTARTS:-5}"
MAX_SLEEP_SECONDS="${MONITOR_SUPERVISOR_MAX_RESTART_SECONDS:-300}"

window_started_epoch=0
restart_count_in_window=0
last_start_at=""
last_exit_at=""
last_exit_code="null"
next_restart_delay_seconds="${BASE_SLEEP_SECONDS}"
crash_loop_active="false"
window_started_at=""

format_epoch_utc() {
  local epoch="$1"
  if date -u -r "${epoch}" +"%Y-%m-%dT%H:%M:%SZ" >/dev/null 2>&1; then
    date -u -r "${epoch}" +"%Y-%m-%dT%H:%M:%SZ"
    return 0
  fi
  date -u -d "@${epoch}" +"%Y-%m-%dT%H:%M:%SZ"
}

write_state() {
  mkdir -p "$(dirname "${STATE_PATH}")"
  local temp_path="${STATE_PATH}.$$.$RANDOM.tmp"
  cat > "${temp_path}" <<EOF
{
  "lastStartAt": "${last_start_at}",
  "lastExitAt": "${last_exit_at}",
  "lastExitCode": ${last_exit_code},
  "restartCountInWindow": ${restart_count_in_window},
  "windowStartedAt": "${window_started_at}",
  "windowSeconds": ${WINDOW_SECONDS},
  "nextRestartDelaySeconds": ${next_restart_delay_seconds},
  "crashLoopActive": ${crash_loop_active}
}
EOF
  mv "${temp_path}" "${STATE_PATH}"
}

is_disabled_exit() {
  if [[ "${last_exit_code}" != "0" ]]; then
    return 1
  fi
  if [[ ! -f "${HEALTH_PATH}" ]]; then
    return 1
  fi
  grep -Eq '"state"[[:space:]]*:[[:space:]]*"disabled"' "${HEALTH_PATH}"
}

while true; do
  last_start_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  window_started_at="$(
    if [[ "${window_started_epoch}" -gt 0 ]]; then
      format_epoch_utc "${window_started_epoch}"
    else
      echo ""
    fi
  )"
  write_state
  echo "[${last_start_at}] starting worker" >> "${OUT_LOG}"
  set +e
  bash "${ROOT_DIR}/scripts/with-env.sh" node "${ROOT_DIR}/src/worker.js" >> "${OUT_LOG}" 2>> "${ERR_LOG}"
  exit_code=$?
  set -e
  now_epoch="$(date +%s)"
  last_exit_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  last_exit_code="${exit_code}"

  if is_disabled_exit; then
    window_started_epoch=0
    restart_count_in_window=0
    window_started_at=""
    next_restart_delay_seconds="${BASE_SLEEP_SECONDS}"
    crash_loop_active="false"
    write_state
    echo "[${last_exit_at}] worker exited in disabled state; checking again in ${next_restart_delay_seconds}s without crash-loop counting" >> "${OUT_LOG}"
    sleep "${next_restart_delay_seconds}"
    continue
  fi

  if [[ "${window_started_epoch}" -eq 0 ]] || (( now_epoch - window_started_epoch > WINDOW_SECONDS )); then
    window_started_epoch="${now_epoch}"
    restart_count_in_window=0
  fi

  restart_count_in_window=$((restart_count_in_window + 1))
  window_started_at="$(format_epoch_utc "${window_started_epoch}")"
  next_restart_delay_seconds="${BASE_SLEEP_SECONDS}"
  crash_loop_active="false"

  if (( restart_count_in_window > MAX_RESTARTS )); then
    overflow_count=$((restart_count_in_window - MAX_RESTARTS))
    next_restart_delay_seconds=$((BASE_SLEEP_SECONDS * (2 ** overflow_count)))
    if (( next_restart_delay_seconds > MAX_SLEEP_SECONDS )); then
      next_restart_delay_seconds="${MAX_SLEEP_SECONDS}"
    fi
    crash_loop_active="true"
  fi

  write_state
  echo "[${last_exit_at}] worker exited with code ${exit_code}; restarting in ${next_restart_delay_seconds}s (restartCountInWindow=${restart_count_in_window}, crashLoopActive=${crash_loop_active})" >> "${OUT_LOG}"
  sleep "${next_restart_delay_seconds}"
done
