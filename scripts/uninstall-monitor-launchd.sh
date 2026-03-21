#!/usr/bin/env bash
set -euo pipefail

LABEL="com.coursenotif.monitor"
WATCHDOG_LABEL="${LABEL}.watchdog"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
WATCHDOG_PLIST_PATH="${HOME}/Library/LaunchAgents/${WATCHDOG_LABEL}.plist"
GUI_DOMAIN="gui/$(id -u)"

if launchctl print "${GUI_DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${GUI_DOMAIN}/${LABEL}" || true
fi

if launchctl print "${GUI_DOMAIN}/${WATCHDOG_LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${GUI_DOMAIN}/${WATCHDOG_LABEL}" || true
fi

rm -f "${PLIST_PATH}"
rm -f "${WATCHDOG_PLIST_PATH}"

echo "Uninstalled ${LABEL}"
echo "Uninstalled ${WATCHDOG_LABEL}"
