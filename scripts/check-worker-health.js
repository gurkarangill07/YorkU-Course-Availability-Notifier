#!/usr/bin/env node

const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  resolveWorkerHealthPath,
  readWorkerHealthSnapshot,
  checkWorkerHealthStatus,
  isProcessRunning
} = require("../src/workerHealth");
const {
  resolveWatchdogStatePath,
  resolveSupervisorStatePath,
  buildOpsWatchdogConfig,
  readJsonFile,
  writeJsonFileAtomic,
  evaluateWatchdog
} = require("../src/opsHardening");
const notifier = require("../src/notification");

const execFileAsync = promisify(execFile);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseCliArgs(argv) {
  const args = {
    alertOnFailure: false,
    restart: "none"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "").trim();
    if (arg === "--alert-on-failure") {
      args.alertOnFailure = true;
      continue;
    }
    if (arg === "--restart") {
      const nextValue = String(argv[index + 1] || "").trim().toLowerCase();
      if (!["none", "supervisor", "launchd"].includes(nextValue)) {
        throw new Error("Usage: --restart <none|supervisor|launchd>");
      }
      args.restart = nextValue;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function buildStatusPayload({
  snapshot,
  status,
  healthPath,
  maxStaleSeconds,
  fallbackReason = null,
  fallbackError = null
}) {
  return {
    ok: Boolean(status && status.ok),
    reason:
      status && status.reason
        ? status.reason
        : fallbackReason || "unknown",
    healthPath,
    maxStaleSeconds,
    pid: snapshot && snapshot.pid ? Number(snapshot.pid) : null,
    pidRunning: snapshot ? isProcessRunning(snapshot.pid) : false,
    state: snapshot && snapshot.state ? snapshot.state : null,
    mode: snapshot && snapshot.mode ? snapshot.mode : null,
    updatedAt: snapshot && snapshot.updatedAt ? snapshot.updatedAt : null,
    staleSeconds:
      status && typeof status.staleSeconds === "number"
        ? status.staleSeconds
        : null,
    error:
      fallbackError && fallbackError.message
        ? fallbackError.message
        : fallbackError
          ? String(fallbackError)
          : null
  };
}

function buildAlertSummary(alert) {
  if (alert.key === "worker_unhealthy") {
    return `Worker unhealthy (${alert.reason})`;
  }
  if (alert.key === "session_expiry_loop") {
    return "Repeated VSB session expiry loop detected";
  }
  if (alert.key === "supervisor_crash_loop") {
    return "Supervisor crash loop detected";
  }
  return "Operational alert";
}

function buildAlertDetails({ alert, payload, supervisorState }) {
  const details = {
    reason: payload.reason,
    staleSeconds: payload.staleSeconds,
    state: payload.state,
    mode: payload.mode
  };

  if (alert.key === "worker_unhealthy") {
    details.consecutiveUnhealthyChecks = alert.consecutiveUnhealthyChecks;
  }
  if (alert.key === "session_expiry_loop") {
    details.eventCount = alert.eventCount;
    details.windowSeconds = alert.windowSeconds;
  }
  if (alert.key === "supervisor_crash_loop") {
    details.restartCountInWindow = alert.restartCountInWindow;
    details.windowSeconds = alert.windowSeconds;
    details.lastExitCode = alert.lastExitCode;
    details.nextRestartDelaySeconds =
      supervisorState && supervisorState.nextRestartDelaySeconds !== undefined
        ? supervisorState.nextRestartDelaySeconds
        : null;
  }

  return details;
}

async function restartManagedWorker(target, rootDir) {
  if (target === "supervisor") {
    await execFileAsync("/bin/bash", [
      path.join(rootDir, "scripts", "stop-monitor-supervisor.sh")
    ]);
    await execFileAsync("/bin/bash", [
      path.join(rootDir, "scripts", "start-monitor-supervisor.sh")
    ]);
    return "supervisor_restarted";
  }

  if (target === "launchd") {
    const label = String(
      process.env.MONITOR_LAUNCHD_LABEL || "com.coursenotif.monitor"
    ).trim();
    const domain = `gui/${process.getuid()}`;
    await execFileAsync("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
    return `launchd_kickstart:${label}`;
  }

  return null;
}

async function maybeSendAlerts({
  alerts,
  payload,
  supervisorState
}) {
  const ownerAlertEmail = String(
    process.env.OWNER_ALERT_EMAIL || process.env.ADMIN_ALERT_EMAIL || ""
  ).trim();
  if (!alerts.length) {
    return {
      sent: [],
      skipped: [],
      errors: []
    };
  }

  if (!ownerAlertEmail) {
    return {
      sent: [],
      skipped: alerts.map((alert) => ({
        key: alert.key,
        reason: "owner_alert_email_not_configured"
      })),
      errors: []
    };
  }

  const sent = [];
  const skipped = [];
  const errors = [];
  for (const alert of alerts) {
    try {
      await notifier.sendOperationalAlertEmail({
        toEmail: ownerAlertEmail,
        alertKey: alert.key,
        severity: alert.severity,
        summary: buildAlertSummary(alert),
        details: buildAlertDetails({
          alert,
          payload,
          supervisorState
        })
      });
      sent.push(alert.key);
    } catch (error) {
      errors.push({
        key: alert.key,
        error: error && error.message ? error.message : String(error)
      });
      skipped.push({
        key: alert.key,
        reason: "alert_send_failed"
      });
    }
  }

  return { sent, skipped, errors };
}

async function readOptionalState(filePath, defaultValue) {
  try {
    return {
      value: await readJsonFile(filePath, defaultValue),
      error: null
    };
  } catch (error) {
    return {
      value: defaultValue,
      error: error && error.message ? error.message : String(error)
    };
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const rootDir = path.join(__dirname, "..");
  const healthPath = resolveWorkerHealthPath(process.env);
  const maxStaleSeconds = parsePositiveInt(
    process.env.WORKER_HEALTH_MAX_STALE_SECONDS,
    300
  );

  let snapshot = null;
  let status = null;
  let fallbackReason = null;
  let fallbackError = null;

  try {
    snapshot = await readWorkerHealthSnapshot({ healthPath });
    status = checkWorkerHealthStatus(snapshot, {
      maxStaleSeconds,
      requirePidAlive: true
    });
  } catch (error) {
    fallbackReason = "health_file_unreadable";
    fallbackError = error;
    status = {
      ok: false,
      reason: fallbackReason
    };
  }

  const payload = buildStatusPayload({
    snapshot,
    status,
    healthPath,
    maxStaleSeconds,
    fallbackReason,
    fallbackError
  });

  if (args.alertOnFailure || args.restart !== "none") {
    const watchdogStatePath = resolveWatchdogStatePath(process.env);
    const supervisorStateResult = await readOptionalState(
      resolveSupervisorStatePath(process.env),
      null
    );
    const previousStateResult = await readOptionalState(watchdogStatePath, {});
    const supervisorState = supervisorStateResult.value;
    const previousState = previousStateResult.value;
    const evaluation = evaluateWatchdog({
      status,
      snapshot,
      previousState,
      supervisorState,
      config: buildOpsWatchdogConfig(process.env),
      restartTarget: args.restart
    });

    const alertOutcome = args.alertOnFailure
      ? await maybeSendAlerts({
          alerts: evaluation.alerts,
          payload,
          supervisorState
        })
      : { sent: [], skipped: [], errors: [] };

    let restartAction = null;
    let restartError = null;
    if (evaluation.restart) {
      try {
        restartAction = await restartManagedWorker(
          evaluation.restart.target,
          rootDir
        );
      } catch (error) {
        restartError = error && error.message ? error.message : String(error);
      }
    }

    await writeJsonFileAtomic(watchdogStatePath, evaluation.nextState);
    payload.watchdogStatePath = watchdogStatePath;
    payload.alertsSent = alertOutcome.sent;
    payload.alertsSkipped = alertOutcome.skipped;
    payload.alertErrors = alertOutcome.errors;
    payload.sessionExpiryEventsInWindow =
      evaluation.sessionExpiryEventsInWindow;
    payload.restartAction = restartAction;
    payload.restartError = restartError;
    if (supervisorStateResult.error) {
      payload.supervisorStateReadError = supervisorStateResult.error;
    }
    if (previousStateResult.error) {
      payload.watchdogStateReadError = previousStateResult.error;
    }
  }

  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.ok ? 0 : 1);
}

main().catch((error) => {
  const payload = {
    ok: false,
    reason: "health_check_crashed",
    error: error && error.message ? error.message : String(error)
  };
  console.log(JSON.stringify(payload, null, 2));
  process.exit(1);
});
