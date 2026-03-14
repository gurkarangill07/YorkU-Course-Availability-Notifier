const { loadConfig, validateRuntimeConfig, formatConfigValidationErrors } = require("./config");
const { createDb } = require("./db");
const notifier = require("./notification");
const { createVsbSource } = require("./vsbSource");
const { createLogger } = require("./logger");
const { metrics } = require("./metrics");
const {
  resolveWorkerHealthPath,
  writeWorkerHealthSnapshot
} = require("./workerHealth");
const {
  monitorOnce,
  runImmediateCheckForNewCourse
} = require("./monitorService");

const workerLogger = createLogger({ component: "worker" });
const workerHealthPath = resolveWorkerHealthPath(process.env);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorPayload(error) {
  if (!error) {
    return null;
  }
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    code: error.code || null,
    stack: error.stack || null
  };
}

async function safeWriteWorkerHealth(snapshot) {
  try {
    await writeWorkerHealthSnapshot(
      {
        lastHeartbeatAt: new Date().toISOString(),
        ...snapshot
      },
      { healthPath: workerHealthPath }
    );
  } catch (error) {
    workerLogger.warn("failed to write worker heartbeat", {
      event: "worker.health.write_failed",
      healthPath: workerHealthPath,
      error
    });
  }
}

function resolveRunMode(args) {
  if (args.initLogin) {
    return args.keepOpen ? "init_login_keep_open" : "init_login";
  }
  if (args.checkNewCourse) {
    return "check_new_course";
  }
  if (args.once) {
    return "once";
  }
  return "loop";
}

function isMonitoringMode(mode) {
  return mode === "loop" || mode === "once" || mode === "check_new_course";
}

function resolveEmergencyDisableState({ config, mode }) {
  return {
    active: Boolean(config.monitorEmergencyDisable && isMonitoringMode(mode)),
    reason: config.monitorEmergencyReason
  };
}

function waitForTerminationSignal() {
  return new Promise((resolve) => {
    let settled = false;
    const onSignal = (signal) => {
      if (settled) {
        return;
      }
      settled = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      workerLogger.info("received shutdown signal", {
        event: "worker.signal.received",
        signal
      });
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

function parseCliArgs(argv) {
  const args = {
    once: false,
    initLogin: false,
    keepOpen: false,
    checkNewCourse: null
  };

  if (argv.includes("--once")) {
    args.once = true;
  }
  if (argv.includes("--init-login")) {
    args.initLogin = true;
  }
  if (argv.includes("--keep-open")) {
    args.keepOpen = true;
  }

  const idx = argv.indexOf("--check-new-course");
  if (idx !== -1) {
    const userId = argv[idx + 1];
    const cartId = argv[idx + 2];
    if (!userId || !cartId) {
      throw new Error("Usage: --check-new-course <userId> <cartId>");
    }
    const parsedUserId = Number.parseInt(userId, 10);
    if (Number.isNaN(parsedUserId) || parsedUserId <= 0) {
      throw new Error("userId must be a positive integer.");
    }
    args.checkNewCourse = {
      userId: parsedUserId,
      cartId: String(cartId).trim()
    };
  }

  if (args.keepOpen && !args.initLogin) {
    throw new Error("--keep-open can only be used with --init-login.");
  }

  return args;
}

async function run() {
  metrics.increment(
    "worker_process_starts_total",
    1,
    "Total worker process starts."
  );
  const startedAt = new Date().toISOString();
  const args = parseCliArgs(process.argv.slice(2));
  const mode = resolveRunMode(args);
  const validation = validateRuntimeConfig({ env: process.env, runtime: "worker", mode });
  if (validation.warnings.length) {
    workerLogger.warn("config validation warnings", {
      event: "worker.config.validation_warning",
      warnings: validation.warnings
    });
  }
  if (validation.errors.length) {
    const error = new Error(formatConfigValidationErrors(validation.errors));
    error.code = "CONFIG_VALIDATION_FAILED";
    throw error;
  }
  const config = loadConfig();
  let db = null;
  let vsbSource = null;

  if (config.monitorIntervalWasClamped) {
    metrics.increment(
      "worker_policy_poll_interval_clamped_total",
      1,
      "Total worker starts where monitor interval was clamped to policy minimum."
    );
    workerLogger.warn("monitor interval clamped to policy minimum", {
      event: "worker.policy.poll_interval_clamped",
      requestedSeconds: config.requestedMonitorIntervalSeconds,
      minSeconds: config.minPollIntervalSeconds,
      appliedSeconds: config.monitorIntervalSeconds
    });
  }

  const emergencyDisableState = resolveEmergencyDisableState({
    config,
    mode
  });
  if (emergencyDisableState.active) {
    metrics.increment(
      "worker_emergency_disable_skips_total",
      1,
      "Total worker monitoring runs skipped due to emergency disable policy."
    );
    workerLogger.warn("worker monitoring run skipped by emergency disable", {
      event: "worker.policy.emergency_disable_skip",
      mode,
      reason: emergencyDisableState.reason
    });
    await safeWriteWorkerHealth({
      state: "disabled",
      mode,
      startedAt,
      disabledAt: new Date().toISOString(),
      policy: {
        monitorEmergencyDisable: true,
        monitorEmergencyReason: emergencyDisableState.reason,
        requestedMonitorIntervalSeconds: config.requestedMonitorIntervalSeconds,
        minPollIntervalSeconds: config.minPollIntervalSeconds,
        monitorIntervalSeconds: config.monitorIntervalSeconds
      },
      metrics: metrics.snapshot()
    });
    return;
  }

  const notificationPolicy = {
    retryBaseSeconds: config.notificationRetryBaseSeconds,
    retryMaxSeconds: config.notificationRetryMaxSeconds,
    maxAttempts: config.notificationMaxAttempts,
    suppressionWindowMinutes: config.notificationSuppressionWindowMinutes,
    dispatchBatchSize: config.notificationDispatchBatchSize,
    dispatchLeaseSeconds: config.notificationDispatchLeaseSeconds
  };

  await safeWriteWorkerHealth({
    state: "starting",
    mode,
    startedAt,
    policy: {
      requestedMonitorIntervalSeconds: config.requestedMonitorIntervalSeconds,
      minPollIntervalSeconds: config.minPollIntervalSeconds,
      monitorIntervalSeconds: config.monitorIntervalSeconds,
      monitorIntervalWasClamped: config.monitorIntervalWasClamped
    },
    metrics: metrics.snapshot()
  });

  try {
    db = createDb({ databaseUrl: config.databaseUrl });
    await db.ensureCompatibility();
    vsbSource = createVsbSource(db, config);

    if (args.initLogin) {
      const result = await vsbSource.initLoginSession();
      workerLogger.info("init-login completed", {
        event: "worker.init_login.completed",
        mode,
        result
      });
      await safeWriteWorkerHealth({
        state: "running",
        mode,
        startedAt,
        lastInitLoginResult: result,
        metrics: metrics.snapshot()
      });
      if (args.keepOpen) {
        workerLogger.info("waiting for termination signal while keeping browser open", {
          event: "worker.init_login.keep_open_wait"
        });
        await waitForTerminationSignal();
      }
      await safeWriteWorkerHealth({
        state: "idle",
        mode,
        startedAt,
        metrics: metrics.snapshot()
      });
      return;
    }

    if (args.checkNewCourse) {
      const result = await runImmediateCheckForNewCourse({
        db,
        vsbSource,
        notifier,
        ownerAlertEmail: config.ownerAlertEmail,
        notificationPolicy,
        userId: args.checkNewCourse.userId,
        cartId: args.checkNewCourse.cartId
      });
      metrics.increment(
        "worker_immediate_checks_total",
        1,
        "Total worker immediate check executions."
      );
      workerLogger.info("immediate check completed", {
        event: "worker.immediate_check.completed",
        mode,
        userId: args.checkNewCourse.userId,
        cartId: args.checkNewCourse.cartId,
        result
      });
      await safeWriteWorkerHealth({
        state: "idle",
        mode,
        startedAt,
        lastImmediateCheckResult: result,
        metrics: metrics.snapshot()
      });
      return;
    }

    if (args.once) {
      const runStartedAtMs = Date.now();
      const summary = await monitorOnce({
        db,
        vsbSource,
        notifier,
        ownerAlertEmail: config.ownerAlertEmail,
        notificationPolicy
      });
      const durationMs = Date.now() - runStartedAtMs;
      workerLogger.info("single monitor pass completed", {
        event: "worker.once.completed",
        mode,
        durationMs,
        summary
      });
      await safeWriteWorkerHealth({
        state: "idle",
        mode,
        startedAt,
        lastMonitorRunAt: new Date().toISOString(),
        lastMonitorDurationMs: durationMs,
        lastMonitorSummary: summary,
        metrics: metrics.snapshot()
      });
      return;
    }

    while (true) {
      const runStartedAtMs = Date.now();
      const summary = await monitorOnce({
        db,
        vsbSource,
        notifier,
        ownerAlertEmail: config.ownerAlertEmail,
        notificationPolicy
      });
      const durationMs = Date.now() - runStartedAtMs;
      workerLogger.info("monitor loop pass completed", {
        event: "worker.loop.summary",
        mode,
        durationMs,
        summary
      });
      await safeWriteWorkerHealth({
        state: "running",
        mode,
        startedAt,
        lastMonitorRunAt: new Date().toISOString(),
        lastMonitorDurationMs: durationMs,
        lastMonitorSummary: summary,
        metrics: metrics.snapshot()
      });
      await sleep(config.monitorIntervalSeconds * 1000);
    }
  } finally {
    if (vsbSource && typeof vsbSource.close === "function") {
      await vsbSource.close();
    }
    if (db && typeof db.close === "function") {
      await db.close();
    }
    await safeWriteWorkerHealth({
      state: "stopped",
      mode,
      startedAt,
      stoppedAt: new Date().toISOString(),
      metrics: metrics.snapshot()
    });
  }
}

async function handleWorkerFatal(error) {
  metrics.increment(
    "worker_process_fatal_total",
    1,
    "Total worker process fatal crashes."
  );
  workerLogger.error("worker fatal error", {
    event: "worker.fatal",
    error
  });
  await safeWriteWorkerHealth({
    state: "fatal",
    fatalAt: new Date().toISOString(),
    lastError: toErrorPayload(error),
    metrics: metrics.snapshot()
  });
  process.exit(1);
}

if (require.main === module) {
  run().catch(handleWorkerFatal);
}

module.exports = {
  parseCliArgs,
  resolveRunMode,
  isMonitoringMode,
  resolveEmergencyDisableState,
  run
};


