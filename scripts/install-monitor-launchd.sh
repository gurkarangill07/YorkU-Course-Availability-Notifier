#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
LABEL="com.coursenotif.monitor"
WATCHDOG_LABEL="${LABEL}.watchdog"
PLIST_PATH="${LAUNCH_DIR}/${LABEL}.plist"
WATCHDOG_PLIST_PATH="${LAUNCH_DIR}/${WATCHDOG_LABEL}.plist"
GUI_DOMAIN="gui/$(id -u)"
RUN_CMD="set -a; source \"${ROOT_DIR}/.env.local\"; set +a; exec node \"${ROOT_DIR}/src/worker.js\""
WATCHDOG_INTERVAL="${WORKER_WATCHDOG_INTERVAL_SECONDS:-60}"
WATCHDOG_CMD="set -a; source \"${ROOT_DIR}/.env.local\"; set +a; exec node \"${ROOT_DIR}/scripts/check-worker-health.js\" --alert-on-failure --restart launchd"

mkdir -p "${LAUNCH_DIR}"

cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>${RUN_CMD}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>/tmp/coursenotif_monitor.out.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/coursenotif_monitor.err.log</string>
</dict>
</plist>
EOF

cat > "${WATCHDOG_PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WATCHDOG_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>${WATCHDOG_CMD}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>StartInterval</key>
  <integer>${WATCHDOG_INTERVAL}</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>MONITOR_LAUNCHD_LABEL</key>
    <string>${LABEL}</string>
  </dict>

  <key>StandardOutPath</key>
  <string>/tmp/coursenotif_monitor_watchdog_launchd.out.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/coursenotif_monitor_watchdog_launchd.err.log</string>
</dict>
</plist>
EOF

if launchctl print "${GUI_DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${GUI_DOMAIN}/${LABEL}" || true
fi

if launchctl print "${GUI_DOMAIN}/${WATCHDOG_LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${GUI_DOMAIN}/${WATCHDOG_LABEL}" || true
fi

launchctl bootstrap "${GUI_DOMAIN}" "${PLIST_PATH}"
launchctl enable "${GUI_DOMAIN}/${LABEL}" || true
launchctl kickstart -k "${GUI_DOMAIN}/${LABEL}"

launchctl bootstrap "${GUI_DOMAIN}" "${WATCHDOG_PLIST_PATH}"
launchctl enable "${GUI_DOMAIN}/${WATCHDOG_LABEL}" || true
launchctl kickstart -k "${GUI_DOMAIN}/${WATCHDOG_LABEL}"

echo "Installed and started ${LABEL}"
echo "plist: ${PLIST_PATH}"
echo "status: launchctl print ${GUI_DOMAIN}/${LABEL}"
echo "Installed and started ${WATCHDOG_LABEL}"
echo "watchdog plist: ${WATCHDOG_PLIST_PATH}"
echo "watchdog status: launchctl print ${GUI_DOMAIN}/${WATCHDOG_LABEL}"
