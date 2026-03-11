function parseIntEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return parsed;
}

function parseIntEnvMin(value, fallback, minValue) {
  return Math.max(minValue, parseIntEnv(value, fallback));
}

function parseBoolEnv(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readRequiredEnv(name, sourceEnv = process.env) {
  const value = sourceEnv[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readFirstNonEmptyStringEnv(names, fallback, sourceEnv = process.env) {
  for (const name of names) {
    if (!(name in sourceEnv)) {
      continue;
    }
    const value = String(sourceEnv[name] || "").trim();
    if (value) {
      return value;
    }
  }
  return fallback;
}

function resolveMonitorCadence(sourceEnv = process.env) {
  const requestedMonitorIntervalSeconds = parseIntEnv(
    sourceEnv.MONITOR_INTERVAL_SECONDS,
    60
  );
  const minPollIntervalSeconds = parseIntEnvMin(
    sourceEnv.MIN_POLL_INTERVAL_SECONDS,
    30,
    1
  );
  const monitorIntervalSeconds = Math.max(
    requestedMonitorIntervalSeconds,
    minPollIntervalSeconds
  );
  const monitorIntervalWasClamped =
    monitorIntervalSeconds !== requestedMonitorIntervalSeconds;

  return {
    requestedMonitorIntervalSeconds,
    minPollIntervalSeconds,
    monitorIntervalSeconds,
    monitorIntervalWasClamped
  };
}

function loadConfig(sourceEnv = process.env) {
  const sourceMode = (sourceEnv.VSB_SOURCE_MODE || "db").trim().toLowerCase();
  if (!["browser", "filesystem", "db"].includes(sourceMode)) {
    throw new Error("VSB_SOURCE_MODE must be one of: browser, filesystem, db");
  }
  const monitorCadence = resolveMonitorCadence(sourceEnv);
  const monitorEmergencyReason = readFirstNonEmptyStringEnv(
    ["MONITOR_EMERGENCY_REASON", "MONITOR_EMERGENCY_DISABLE_REASON"],
    "Monitoring is disabled by policy (MONITOR_EMERGENCY_DISABLE=true).",
    sourceEnv
  );

  return {
    databaseUrl: readRequiredEnv("DATABASE_URL", sourceEnv),
    monitorIntervalSeconds: monitorCadence.monitorIntervalSeconds,
    requestedMonitorIntervalSeconds: monitorCadence.requestedMonitorIntervalSeconds,
    minPollIntervalSeconds: monitorCadence.minPollIntervalSeconds,
    monitorIntervalWasClamped: monitorCadence.monitorIntervalWasClamped,
    monitorEmergencyDisable: parseBoolEnv(
      sourceEnv.MONITOR_EMERGENCY_DISABLE,
      false
    ),
    monitorEmergencyReason,
    ownerAlertEmail: sourceEnv.OWNER_ALERT_EMAIL || sourceEnv.ADMIN_ALERT_EMAIL || null,
    sessionDurationMinutes: parseIntEnv(sourceEnv.SESSION_DURATION_MINUTES, 90),
    vsbSourceMode: sourceMode,
    jspSourceDir: sourceEnv.JSP_SOURCE_DIR || null,
    vsbUrl: sourceEnv.VSB_URL || null,
    vsbUserDataDir: sourceEnv.VSB_USER_DATA_DIR || ".data/vsb-profile",
    vsbHeadless: parseBoolEnv(sourceEnv.VSB_HEADLESS, false),
    vsbSearchSelector:
      sourceEnv.VSB_SEARCH_SELECTOR ||
      "input[placeholder*='Course Number, Title']",
    vsbFallWinterSelector:
      sourceEnv.VSB_FALL_WINTER_SELECTOR ||
      "input[type='radio']",
    vsbDropdownOptionSelector:
      sourceEnv.VSB_DROPDOWN_OPTION_SELECTOR ||
      "[role='option'], .dropdown-item, .ui-menu-item, li",
    vsbCourseRowSelector:
      sourceEnv.VSB_COURSE_ROW_SELECTOR ||
      "tr, li, .course, .course-row, .selection, .block, [class*='course']",
    vsbCoursePresenceSelector:
      sourceEnv.VSB_COURSE_PRESENCE_SELECTOR ||
      "tr, li, .course, .course-row, .selection, .block, [class*='course']",
    vsbCourseCheckboxSelector:
      sourceEnv.VSB_COURSE_CHECKBOX_SELECTOR ||
      "input[type='checkbox'], [role='checkbox']",
    vsbCheckboxTimeoutMs: parseIntEnv(sourceEnv.VSB_CHECKBOX_TIMEOUT_MS, 6000),
    vsbSyncTrackedCoursesOnStart: parseBoolEnv(
      sourceEnv.VSB_SYNC_TRACKED_COURSES_ON_START,
      true
    ),
    vsbSyncTrackedCoursesLimit: parseIntEnv(
      sourceEnv.VSB_SYNC_TRACKED_COURSES_LIMIT,
      50
    ),
    vsbLoggedOutSelector:
      sourceEnv.VSB_LOGGED_OUT_SELECTOR ||
      "input[type='password'], form[action*='login'], button[type='submit']",
    vsbAutoReloginEnabled: parseBoolEnv(
      sourceEnv.VSB_AUTO_RELOGIN_ENABLED,
      true
    ),
    vsbLoginUsername: sourceEnv.VSB_LOGIN_USERNAME || sourceEnv.VSB_USERNAME || null,
    vsbLoginPassword: sourceEnv.VSB_LOGIN_PASSWORD || sourceEnv.VSB_PASSWORD || null,
    vsbLoginUsernameSelector:
      sourceEnv.VSB_LOGIN_USERNAME_SELECTOR ||
      "input[type='email'], input[name='username'], input[name='user'], input[id*='user'], input[name*='email']",
    vsbLoginPasswordSelector:
      sourceEnv.VSB_LOGIN_PASSWORD_SELECTOR ||
      "input[type='password']",
    vsbLoginSubmitSelector:
      sourceEnv.VSB_LOGIN_SUBMIT_SELECTOR ||
      "button[type='submit'], input[type='submit'], button[name='login']",
    vsbLoginContinueSelector:
      sourceEnv.VSB_LOGIN_CONTINUE_SELECTOR ||
      "a[href*='schedulebuilder.yorku.ca'], a:has-text('Visual Schedule Builder'), a:has-text('continue to Visual Schedule Builder')",
    vsbPostLoginWaitMs: parseIntEnv(sourceEnv.VSB_POST_LOGIN_WAIT_MS, 1500),
    vsbSearchTimeoutMs: parseIntEnv(sourceEnv.VSB_SEARCH_TIMEOUT_MS, 15000),
    vsbDropdownTimeoutMs: parseIntEnv(sourceEnv.VSB_DROPDOWN_TIMEOUT_MS, 10000),
    vsbCaptureWaitMs: parseIntEnv(sourceEnv.VSB_CAPTURE_WAIT_MS, 2000),
    vsbLoginWaitSeconds: parseIntEnv(sourceEnv.VSB_LOGIN_WAIT_SECONDS, 600),
    vsbRefreshIntervalMinutes: parseIntEnv(
      sourceEnv.VSB_REFRESH_INTERVAL_MINUTES,
      15
    ),
    notificationRetryBaseSeconds: parseIntEnvMin(
      sourceEnv.NOTIFICATION_RETRY_BASE_SECONDS,
      30,
      1
    ),
    notificationRetryMaxSeconds: parseIntEnvMin(
      sourceEnv.NOTIFICATION_RETRY_MAX_SECONDS,
      900,
      1
    ),
    notificationMaxAttempts: parseIntEnvMin(
      sourceEnv.NOTIFICATION_MAX_ATTEMPTS,
      5,
      1
    ),
    notificationSuppressionWindowMinutes: parseIntEnvMin(
      sourceEnv.NOTIFICATION_SUPPRESSION_WINDOW_MINUTES,
      30,
      0
    ),
    notificationDispatchBatchSize: parseIntEnvMin(
      sourceEnv.NOTIFICATION_DISPATCH_BATCH_SIZE,
      25,
      1
    ),
    notificationDispatchLeaseSeconds: parseIntEnvMin(
      sourceEnv.NOTIFICATION_DISPATCH_LEASE_SECONDS,
      300,
      1
    )
  };
}

module.exports = {
  loadConfig
};
