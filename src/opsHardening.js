const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_WATCHDOG_STATE_PATH = "/tmp/coursenotif_worker_watchdog_state.json";
const DEFAULT_SUPERVISOR_STATE_PATH = "/tmp/coursenotif_monitor_supervisor_state.json";

function parsePositiveInt(value, fallback, minValue = 1) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed < minValue) {
    return fallback;
  }
  return parsed;
}

function resolveWatchdogStatePath(env = process.env) {
  const configured = String(env.WORKER_WATCHDOG_STATE_PATH || "").trim();
  return configured || DEFAULT_WATCHDOG_STATE_PATH;
}

function resolveSupervisorStatePath(env = process.env) {
  const configured = String(env.MONITOR_SUPERVISOR_STATE_PATH || "").trim();
  return configured || DEFAULT_SUPERVISOR_STATE_PATH;
}

function buildOpsWatchdogConfig(env = process.env) {
  return {
    unhealthyConsecutiveChecks: parsePositiveInt(
      env.WORKER_HEALTH_ALERT_CONSECUTIVE_FAILURES,
      2
    ),
    sessionExpiryThreshold: parsePositiveInt(
      env.WORKER_SESSION_EXPIRED_ALERT_THRESHOLD,
      3
    ),
    sessionExpiryWindowSeconds: parsePositiveInt(
      env.WORKER_SESSION_EXPIRED_ALERT_WINDOW_SECONDS,
      900
    ),
    alertCooldownSeconds: parsePositiveInt(
      env.WORKER_ALERT_COOLDOWN_SECONDS,
      1800
    ),
    restartConsecutiveChecks: parsePositiveInt(
      env.WORKER_HEALTH_RESTART_CONSECUTIVE_FAILURES,
      3
    ),
    restartCooldownSeconds: parsePositiveInt(
      env.WORKER_RESTART_COOLDOWN_SECONDS,
      900
    ),
    supervisorCrashLoopThreshold: parsePositiveInt(
      env.MONITOR_SUPERVISOR_CRASH_LOOP_MAX_RESTARTS,
      5
    )
  };
}

async function readJsonFile(filePath, defaultValue = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return defaultValue;
    }
    throw error;
  }
}

async function writeJsonFileAtomic(filePath, payload) {
  const targetPath = String(filePath || "").trim();
  const directory = path.dirname(targetPath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, targetPath);
}

function pruneRecentTimestamps(values, { nowMs, windowMs }) {
  const threshold = Math.max(0, nowMs - windowMs);
  return (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= threshold);
}

function getWorkerMetricCounter(snapshot, metricName) {
  const counters =
    snapshot && snapshot.metrics && snapshot.metrics.counters
      ? snapshot.metrics.counters
      : null;
  const value = counters ? counters[metricName] : null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function isActionDue(isoTimestamp, { nowMs, cooldownMs }) {
  if (!isoTimestamp) {
    return true;
  }
  const lastTs = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(lastTs) || lastTs <= 0) {
    return true;
  }
  return nowMs - lastTs >= cooldownMs;
}

function canRestartForReason(reason) {
  return [
    "health_file_unreadable",
    "missing_snapshot",
    "invalid_updated_at",
    "stale_heartbeat",
    "fatal_state",
    "worker_pid_not_running",
    "health_check_crashed"
  ].includes(String(reason || ""));
}

function evaluateWatchdog({
  status,
  snapshot,
  previousState,
  supervisorState,
  config,
  restartTarget = "none",
  nowMs = Date.now()
}) {
  const watchdogConfig = config || buildOpsWatchdogConfig();
  const prior = previousState && typeof previousState === "object" ? previousState : {};
  const nextState = {
    previousSessionExpiredCount:
      prior.previousSessionExpiredCount && Number.isFinite(prior.previousSessionExpiredCount)
        ? prior.previousSessionExpiredCount
        : 0,
    sessionExpiredEventTimestamps: Array.isArray(prior.sessionExpiredEventTimestamps)
      ? prior.sessionExpiredEventTimestamps
      : [],
    consecutiveUnhealthyChecks: Number.isFinite(prior.consecutiveUnhealthyChecks)
      ? prior.consecutiveUnhealthyChecks
      : 0,
    lastAlertAtByKey:
      prior.lastAlertAtByKey && typeof prior.lastAlertAtByKey === "object"
        ? { ...prior.lastAlertAtByKey }
        : {},
    lastRestartAt: prior.lastRestartAt || null,
    lastStatusReason: status && status.reason ? status.reason : null,
    lastEvaluatedAt: new Date(nowMs).toISOString()
  };

  const currentSessionExpiredCount = getWorkerMetricCounter(
    snapshot,
    "coursenotif_worker_session_expired_loop_total"
  );
  const priorSessionExpiredCount = nextState.previousSessionExpiredCount;
  const sessionExpiredDelta =
    currentSessionExpiredCount < priorSessionExpiredCount
      ? currentSessionExpiredCount
      : Math.max(0, currentSessionExpiredCount - priorSessionExpiredCount);
  const sessionWindowMs = watchdogConfig.sessionExpiryWindowSeconds * 1000;
  const sessionExpiredEventTimestamps = pruneRecentTimestamps(
    nextState.sessionExpiredEventTimestamps,
    { nowMs, windowMs: sessionWindowMs }
  );
  for (let index = 0; index < sessionExpiredDelta; index += 1) {
    sessionExpiredEventTimestamps.push(nowMs);
  }

  nextState.previousSessionExpiredCount = currentSessionExpiredCount;
  nextState.sessionExpiredEventTimestamps = sessionExpiredEventTimestamps;
  nextState.consecutiveUnhealthyChecks =
    status && status.ok ? 0 : nextState.consecutiveUnhealthyChecks + 1;

  const alerts = [];
  const alertCooldownMs = watchdogConfig.alertCooldownSeconds * 1000;
  const restartCooldownMs = watchdogConfig.restartCooldownSeconds * 1000;

  const maybeQueueAlert = (key, details) => {
    if (
      !isActionDue(nextState.lastAlertAtByKey[key], {
        nowMs,
        cooldownMs: alertCooldownMs
      })
    ) {
      return;
    }
    const sentAt = new Date(nowMs).toISOString();
    nextState.lastAlertAtByKey[key] = sentAt;
    alerts.push({
      key,
      sentAt,
      ...details
    });
  };

  if (
    !(status && status.ok) &&
    nextState.consecutiveUnhealthyChecks >= watchdogConfig.unhealthyConsecutiveChecks
  ) {
    maybeQueueAlert("worker_unhealthy", {
      severity: "critical",
      reason: status && status.reason ? status.reason : "unknown",
      consecutiveUnhealthyChecks: nextState.consecutiveUnhealthyChecks
    });
  }

  if (
    sessionExpiredEventTimestamps.length >= watchdogConfig.sessionExpiryThreshold
  ) {
    maybeQueueAlert("session_expiry_loop", {
      severity: "warning",
      eventCount: sessionExpiredEventTimestamps.length,
      windowSeconds: watchdogConfig.sessionExpiryWindowSeconds
    });
  }

  if (
    supervisorState &&
    (!status || status.reason !== "disabled") &&
    Number(supervisorState.restartCountInWindow || 0) >=
      watchdogConfig.supervisorCrashLoopThreshold &&
    Boolean(supervisorState.crashLoopActive)
  ) {
    maybeQueueAlert("supervisor_crash_loop", {
      severity: "critical",
      restartCountInWindow: Number(supervisorState.restartCountInWindow || 0),
      windowSeconds: Number(supervisorState.windowSeconds || 0) || null,
      lastExitCode:
        supervisorState.lastExitCode === undefined
          ? null
          : Number(supervisorState.lastExitCode)
    });
  }

  let restart = null;
  if (
    restartTarget !== "none" &&
    !(status && status.ok) &&
    nextState.consecutiveUnhealthyChecks >= watchdogConfig.restartConsecutiveChecks &&
    canRestartForReason(status && status.reason) &&
    isActionDue(nextState.lastRestartAt, {
      nowMs,
      cooldownMs: restartCooldownMs
    })
  ) {
    restart = {
      target: restartTarget,
      reason: status.reason,
      scheduledAt: new Date(nowMs).toISOString()
    };
    nextState.lastRestartAt = restart.scheduledAt;
  }

  return {
    alerts,
    restart,
    nextState,
    sessionExpiredDelta,
    sessionExpiryEventsInWindow: sessionExpiredEventTimestamps.length
  };
}

module.exports = {
  DEFAULT_WATCHDOG_STATE_PATH,
  DEFAULT_SUPERVISOR_STATE_PATH,
  resolveWatchdogStatePath,
  resolveSupervisorStatePath,
  buildOpsWatchdogConfig,
  readJsonFile,
  writeJsonFileAtomic,
  evaluateWatchdog
};
