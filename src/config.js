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

function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadConfig() {
  const sourceMode = (process.env.VSB_SOURCE_MODE || "db").trim().toLowerCase();
  if (!["browser", "filesystem", "db"].includes(sourceMode)) {
    throw new Error("VSB_SOURCE_MODE must be one of: browser, filesystem, db");
  }

  return {
    databaseUrl: readRequiredEnv("DATABASE_URL"),
    monitorIntervalSeconds: parseIntEnv(process.env.MONITOR_INTERVAL_SECONDS, 60),
    ownerAlertEmail: process.env.OWNER_ALERT_EMAIL || process.env.ADMIN_ALERT_EMAIL || null,
    sessionDurationMinutes: parseIntEnv(process.env.SESSION_DURATION_MINUTES, 90),
    vsbSourceMode: sourceMode,
    jspSourceDir: process.env.JSP_SOURCE_DIR || null,
    vsbUrl: process.env.VSB_URL || null,
    vsbUserDataDir: process.env.VSB_USER_DATA_DIR || ".data/vsb-profile",
    vsbHeadless: parseBoolEnv(process.env.VSB_HEADLESS, false),
    vsbSearchSelector:
      process.env.VSB_SEARCH_SELECTOR ||
      "input[placeholder*='Course Number, Title']",
    vsbFallWinterSelector:
      process.env.VSB_FALL_WINTER_SELECTOR ||
      "input[type='radio']",
    vsbDropdownOptionSelector:
      process.env.VSB_DROPDOWN_OPTION_SELECTOR ||
      "[role='option'], .dropdown-item, .ui-menu-item, li",
    vsbCourseRowSelector:
      process.env.VSB_COURSE_ROW_SELECTOR ||
      "tr, li, .course, .course-row, .selection, .block, [class*='course']",
    vsbCoursePresenceSelector:
      process.env.VSB_COURSE_PRESENCE_SELECTOR ||
      "tr, li, .course, .course-row, .selection, .block, [class*='course']",
    vsbCourseCheckboxSelector:
      process.env.VSB_COURSE_CHECKBOX_SELECTOR ||
      "input[type='checkbox'], [role='checkbox']",
    vsbCheckboxTimeoutMs: parseIntEnv(process.env.VSB_CHECKBOX_TIMEOUT_MS, 6000),
    vsbSyncTrackedCoursesOnStart: parseBoolEnv(
      process.env.VSB_SYNC_TRACKED_COURSES_ON_START,
      true
    ),
    vsbSyncTrackedCoursesLimit: parseIntEnv(
      process.env.VSB_SYNC_TRACKED_COURSES_LIMIT,
      50
    ),
    vsbLoggedOutSelector:
      process.env.VSB_LOGGED_OUT_SELECTOR ||
      "input[type='password'], form[action*='login'], button[type='submit']",
    vsbAutoReloginEnabled: parseBoolEnv(
      process.env.VSB_AUTO_RELOGIN_ENABLED,
      true
    ),
    vsbLoginUsername: process.env.VSB_LOGIN_USERNAME || process.env.VSB_USERNAME || null,
    vsbLoginPassword: process.env.VSB_LOGIN_PASSWORD || process.env.VSB_PASSWORD || null,
    vsbLoginUsernameSelector:
      process.env.VSB_LOGIN_USERNAME_SELECTOR ||
      "input[type='email'], input[name='username'], input[name='user'], input[id*='user'], input[name*='email']",
    vsbLoginPasswordSelector:
      process.env.VSB_LOGIN_PASSWORD_SELECTOR ||
      "input[type='password']",
    vsbLoginSubmitSelector:
      process.env.VSB_LOGIN_SUBMIT_SELECTOR ||
      "button[type='submit'], input[type='submit'], button[name='login']",
    vsbLoginContinueSelector:
      process.env.VSB_LOGIN_CONTINUE_SELECTOR ||
      "a[href*='schedulebuilder.yorku.ca'], a:has-text('Visual Schedule Builder'), a:has-text('continue to Visual Schedule Builder')",
    vsbPostLoginWaitMs: parseIntEnv(process.env.VSB_POST_LOGIN_WAIT_MS, 1500),
    vsbSearchTimeoutMs: parseIntEnv(process.env.VSB_SEARCH_TIMEOUT_MS, 15000),
    vsbDropdownTimeoutMs: parseIntEnv(process.env.VSB_DROPDOWN_TIMEOUT_MS, 10000),
    vsbCaptureWaitMs: parseIntEnv(process.env.VSB_CAPTURE_WAIT_MS, 2000),
    vsbLoginWaitSeconds: parseIntEnv(process.env.VSB_LOGIN_WAIT_SECONDS, 600),
    vsbRefreshIntervalMinutes: parseIntEnv(
      process.env.VSB_REFRESH_INTERVAL_MINUTES,
      15
    ),
    notificationRetryBaseSeconds: parseIntEnvMin(
      process.env.NOTIFICATION_RETRY_BASE_SECONDS,
      30,
      1
    ),
    notificationRetryMaxSeconds: parseIntEnvMin(
      process.env.NOTIFICATION_RETRY_MAX_SECONDS,
      900,
      1
    ),
    notificationMaxAttempts: parseIntEnvMin(
      process.env.NOTIFICATION_MAX_ATTEMPTS,
      5,
      1
    ),
    notificationSuppressionWindowMinutes: parseIntEnvMin(
      process.env.NOTIFICATION_SUPPRESSION_WINDOW_MINUTES,
      30,
      0
    ),
    notificationDispatchBatchSize: parseIntEnvMin(
      process.env.NOTIFICATION_DISPATCH_BATCH_SIZE,
      25,
      1
    ),
    notificationDispatchLeaseSeconds: parseIntEnvMin(
      process.env.NOTIFICATION_DISPATCH_LEASE_SECONDS,
      300,
      1
    )
  };
}

module.exports = {
  loadConfig
};
