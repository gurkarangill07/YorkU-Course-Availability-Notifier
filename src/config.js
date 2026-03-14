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

const BOOLEAN_ENV_VALUES = new Set([
  "1",
  "0",
  "true",
  "false",
  "yes",
  "no",
  "y",
  "n",
  "on",
  "off"
]);

function normalizeEnvString(value) {
  return String(value || "").trim();
}

function isNonEmptyEnvValue(value) {
  return normalizeEnvString(value) !== "";
}

function validateBooleanEnv(name, sourceEnv, errors) {
  if (!(name in sourceEnv)) {
    return;
  }
  const raw = normalizeEnvString(sourceEnv[name]);
  if (!raw) {
    errors.push(`${name} must be a boolean value (true/false).`);
    return;
  }
  const normalized = raw.toLowerCase();
  if (!BOOLEAN_ENV_VALUES.has(normalized)) {
    errors.push(
      `${name} must be one of: true, false, 1, 0, yes, no, on, off.`
    );
  }
}

function validateIntEnv(name, sourceEnv, { min, max } = {}, errors) {
  if (!(name in sourceEnv)) {
    return;
  }
  const raw = normalizeEnvString(sourceEnv[name]);
  if (!raw) {
    errors.push(`${name} must be a whole number.`);
    return;
  }
  if (!/^-?\d+$/.test(raw)) {
    errors.push(`${name} must be a whole number.`);
    return;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    errors.push(`${name} must be a whole number.`);
    return;
  }
  if (min !== undefined && parsed < min) {
    errors.push(`${name} must be at least ${min}.`);
  }
  if (max !== undefined && parsed > max) {
    errors.push(`${name} must be at most ${max}.`);
  }
}

function validateEnumEnv(name, sourceEnv, allowedValues, errors) {
  if (!(name in sourceEnv)) {
    return;
  }
  const raw = normalizeEnvString(sourceEnv[name]);
  if (!raw) {
    errors.push(`${name} must be one of: ${allowedValues.join(", ")}.`);
    return;
  }
  const normalized = raw.toLowerCase();
  if (!allowedValues.includes(normalized)) {
    errors.push(`${name} must be one of: ${allowedValues.join(", ")}.`);
  }
}

function validateUrlEnv(name, sourceEnv, errors) {
  if (!(name in sourceEnv)) {
    return;
  }
  const raw = normalizeEnvString(sourceEnv[name]);
  if (!raw) {
    errors.push(`${name} must be a valid URL.`);
    return;
  }
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      errors.push(`${name} must be an http or https URL.`);
    }
  } catch (_error) {
    errors.push(`${name} must be a valid URL.`);
  }
}

function requireEnv(name, sourceEnv, errors) {
  if (!isNonEmptyEnvValue(sourceEnv[name])) {
    errors.push(`Missing required environment variable: ${name}`);
  }
}

function warnIfMissing(name, sourceEnv, warnings, message) {
  if (!isNonEmptyEnvValue(sourceEnv[name])) {
    warnings.push(message || `${name} is recommended but not set.`);
  }
}

function resolveSourceMode(sourceEnv) {
  return normalizeEnvString(sourceEnv.VSB_SOURCE_MODE || "db").toLowerCase();
}

function formatConfigValidationErrors(errors) {
  if (!errors || errors.length === 0) {
    return "";
  }
  return ["Config validation failed:", ...errors.map((msg) => `- ${msg}`)].join(
    "\n"
  );
}

function validateRuntimeConfig({ env = process.env, runtime, mode } = {}) {
  const errors = [];
  const warnings = [];
  const normalizedRuntime = normalizeEnvString(runtime).toLowerCase();

  if (!normalizedRuntime) {
    errors.push("Runtime is required. Use \"api\" or \"worker\".");
    return { errors, warnings };
  }

  if (!["api", "worker"].includes(normalizedRuntime)) {
    errors.push(`Unknown runtime "${runtime}". Use "api" or "worker".`);
    return { errors, warnings };
  }

  requireEnv("DATABASE_URL", env, errors);

  validateIntEnv("MONITOR_INTERVAL_SECONDS", env, { min: 1 }, errors);
  validateIntEnv("MIN_POLL_INTERVAL_SECONDS", env, { min: 1 }, errors);
  validateBooleanEnv("MONITOR_EMERGENCY_DISABLE", env, errors);
  validateIntEnv("SESSION_DURATION_MINUTES", env, { min: 1 }, errors);
  validateIntEnv("VSB_REFRESH_INTERVAL_MINUTES", env, { min: 1 }, errors);
  validateIntEnv("VSB_CHECKBOX_TIMEOUT_MS", env, { min: 1 }, errors);
  validateIntEnv("VSB_SYNC_TRACKED_COURSES_LIMIT", env, { min: 1 }, errors);
  validateIntEnv("VSB_POST_LOGIN_WAIT_MS", env, { min: 0 }, errors);
  validateIntEnv("VSB_SEARCH_TIMEOUT_MS", env, { min: 1 }, errors);
  validateIntEnv("VSB_DROPDOWN_TIMEOUT_MS", env, { min: 1 }, errors);
  validateIntEnv("VSB_CAPTURE_WAIT_MS", env, { min: 0 }, errors);
  validateIntEnv("VSB_LOGIN_WAIT_SECONDS", env, { min: 1 }, errors);
  validateIntEnv("NOTIFICATION_RETRY_BASE_SECONDS", env, { min: 1 }, errors);
  validateIntEnv("NOTIFICATION_RETRY_MAX_SECONDS", env, { min: 1 }, errors);
  validateIntEnv("NOTIFICATION_MAX_ATTEMPTS", env, { min: 1 }, errors);
  validateIntEnv(
    "NOTIFICATION_SUPPRESSION_WINDOW_MINUTES",
    env,
    { min: 0 },
    errors
  );
  validateIntEnv("NOTIFICATION_DISPATCH_BATCH_SIZE", env, { min: 1 }, errors);
  validateIntEnv("NOTIFICATION_DISPATCH_LEASE_SECONDS", env, { min: 1 }, errors);
  validateIntEnv("INVALID_CODE_MAX_ATTEMPTS", env, { min: 1 }, errors);
  validateIntEnv("AUTH_OTP_TTL_MINUTES", env, { min: 1 }, errors);
  validateIntEnv("AUTH_OTP_RESEND_COOLDOWN_SECONDS", env, { min: 1 }, errors);
  validateIntEnv("AUTH_OTP_MAX_FAILED_ATTEMPTS", env, { min: 1 }, errors);
  validateIntEnv("AUTH_SESSION_DAYS", env, { min: 1 }, errors);
  validateIntEnv("WORKER_HEALTH_MAX_STALE_SECONDS", env, { min: 1 }, errors);
  validateIntEnv("PORT", env, { min: 1, max: 65535 }, errors);
  validateIntEnv("SMTP_PORT", env, { min: 1, max: 65535 }, errors);
  validateIntEnv("DB_COMPATIBILITY_RETRY_ATTEMPTS", env, { min: 1 }, errors);
  validateIntEnv("DB_COMPATIBILITY_RETRY_DELAY_MS", env, { min: 1 }, errors);

  validateBooleanEnv("VSB_HEADLESS", env, errors);
  validateBooleanEnv("VSB_SYNC_TRACKED_COURSES_ON_START", env, errors);
  validateBooleanEnv("VSB_AUTO_RELOGIN_ENABLED", env, errors);
  validateBooleanEnv("SMTP_SECURE", env, errors);
  validateBooleanEnv("AUTH_COOKIE_SECURE", env, errors);
  validateBooleanEnv("PG_SSL_REJECT_UNAUTHORIZED", env, errors);

  validateEnumEnv("VSB_SOURCE_MODE", env, ["browser", "filesystem", "db"], errors);


  if (normalizedRuntime === "api") {
    requireEnv("OTP_PEPPER", env, errors);
    requireEnv("SMTP_USER", env, errors);
    const hasAuthPass = isNonEmptyEnvValue(env.SMTP_PASS_AUTH);
    const hasFallbackPass = isNonEmptyEnvValue(env.SMTP_PASS);
    if (!hasAuthPass && !hasFallbackPass) {
      errors.push("SMTP_PASS_AUTH (or SMTP_PASS) is required for OTP email.");
    }
    if (!hasAuthPass && hasFallbackPass) {
      warnings.push(
        "SMTP_PASS_AUTH is not set; OTP email will reuse SMTP_PASS."
      );
    }
    warnIfMissing(
      "SMTP_FROM",
      env,
      warnings,
      "SMTP_FROM is recommended to avoid ambiguous sender addresses."
    );
    if (isNonEmptyEnvValue(env.APP_BASE_URL)) {
      validateUrlEnv("APP_BASE_URL", env, errors);
    }
    if (!isNonEmptyEnvValue(env.APP_BASE_URL)) {
      warnings.push(
        "APP_BASE_URL is not set; notification links will default to http://localhost:3000."
      );
    }
  }

  if (normalizedRuntime === "worker") {
    const normalizedMode = normalizeEnvString(mode).toLowerCase();
    const requiresNotifications =
      !normalizedMode || ["loop", "once", "check_new_course"].includes(normalizedMode);

    if (requiresNotifications) {
      requireEnv("SMTP_USER", env, errors);
      requireEnv("SMTP_PASS", env, errors);
      requireEnv("APP_BASE_URL", env, errors);
      warnIfMissing(
        "SMTP_FROM",
        env,
        warnings,
        "SMTP_FROM is recommended to avoid ambiguous sender addresses."
      );
      if (isNonEmptyEnvValue(env.APP_BASE_URL)) {
        validateUrlEnv("APP_BASE_URL", env, errors);
      }
    }

    const sourceMode = resolveSourceMode(env);
    if (sourceMode === "browser") {
      requireEnv("VSB_URL", env, errors);
      if (isNonEmptyEnvValue(env.VSB_URL)) {
        validateUrlEnv("VSB_URL", env, errors);
      }
      const autoReloginEnabled = parseBoolEnv(
        env.VSB_AUTO_RELOGIN_ENABLED,
        true
      );
      if (
        autoReloginEnabled &&
        (!isNonEmptyEnvValue(env.VSB_LOGIN_USERNAME) ||
          !isNonEmptyEnvValue(env.VSB_LOGIN_PASSWORD))
      ) {
        warnings.push(
          "VSB_AUTO_RELOGIN_ENABLED is true but VSB_LOGIN_USERNAME/VSB_LOGIN_PASSWORD are missing; auto relogin will be skipped."
        );
      }
    }
    if (sourceMode === "filesystem") {
      requireEnv("JSP_SOURCE_DIR", env, errors);
    }
  }

  return { errors, warnings };
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
  loadConfig,
  validateRuntimeConfig,
  formatConfigValidationErrors
};







