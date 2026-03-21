const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const {
  evaluateWatchdog,
  readJsonFile,
  writeJsonFileAtomic
} = require("../src/opsHardening");

function createWatchdogConfig(overrides = {}) {
  return {
    unhealthyConsecutiveChecks: 2,
    sessionExpiryThreshold: 3,
    sessionExpiryWindowSeconds: 900,
    alertCooldownSeconds: 1800,
    restartConsecutiveChecks: 2,
    restartCooldownSeconds: 900,
    supervisorCrashLoopThreshold: 5,
    ...overrides
  };
}

function createSnapshotWithCounters(counters = {}) {
  return {
    metrics: {
      counters
    }
  };
}

test("writeJsonFileAtomic and readJsonFile round-trip watchdog state", async () => {
  const filePath = path.join(
    os.tmpdir(),
    `coursenotif_watchdog_state_${Date.now()}_${Math.floor(
      Math.random() * 100000
    )}.json`
  );
  const payload = {
    consecutiveUnhealthyChecks: 2,
    lastAlertAtByKey: {
      worker_unhealthy: new Date().toISOString()
    }
  };

  try {
    await writeJsonFileAtomic(filePath, payload);
    const loaded = await readJsonFile(filePath);
    assert.deepEqual(loaded, payload);
  } finally {
    await fs.rm(filePath, { force: true });
  }
});

test("evaluateWatchdog alerts and schedules restart after repeated unhealthy checks", () => {
  const nowMs = Date.parse("2026-03-21T18:00:00.000Z");
  const result = evaluateWatchdog({
    status: {
      ok: false,
      reason: "stale_heartbeat"
    },
    snapshot: createSnapshotWithCounters(),
    previousState: {
      consecutiveUnhealthyChecks: 1,
      sessionExpiredEventTimestamps: [],
      lastAlertAtByKey: {}
    },
    supervisorState: null,
    config: createWatchdogConfig(),
    restartTarget: "supervisor",
    nowMs
  });

  assert.equal(result.nextState.consecutiveUnhealthyChecks, 2);
  assert.deepEqual(
    result.alerts.map((alert) => alert.key),
    ["worker_unhealthy"]
  );
  assert.deepEqual(result.restart, {
    target: "supervisor",
    reason: "stale_heartbeat",
    scheduledAt: new Date(nowMs).toISOString()
  });
});

test("evaluateWatchdog deduplicates repeated session-expiry alerts within cooldown", () => {
  const firstNowMs = Date.parse("2026-03-21T18:05:00.000Z");
  const firstResult = evaluateWatchdog({
    status: {
      ok: true,
      reason: "healthy"
    },
    snapshot: createSnapshotWithCounters({
      coursenotif_worker_session_expired_loop_total: 3
    }),
    previousState: {},
    supervisorState: null,
    config: createWatchdogConfig({
      alertCooldownSeconds: 600
    }),
    nowMs: firstNowMs
  });

  assert.deepEqual(
    firstResult.alerts.map((alert) => alert.key),
    ["session_expiry_loop"]
  );
  assert.equal(firstResult.sessionExpiryEventsInWindow, 3);

  const secondResult = evaluateWatchdog({
    status: {
      ok: true,
      reason: "healthy"
    },
    snapshot: createSnapshotWithCounters({
      coursenotif_worker_session_expired_loop_total: 3
    }),
    previousState: firstResult.nextState,
    supervisorState: null,
    config: createWatchdogConfig({
      alertCooldownSeconds: 600
    }),
    nowMs: firstNowMs + 60 * 1000
  });

  assert.deepEqual(secondResult.alerts, []);
  assert.equal(secondResult.sessionExpiryEventsInWindow, 3);
});

test("evaluateWatchdog treats lower post-restart session counters as a reset, not as zero new events", () => {
  const nowMs = Date.parse("2026-03-21T18:10:00.000Z");
  const result = evaluateWatchdog({
    status: {
      ok: true,
      reason: "healthy"
    },
    snapshot: createSnapshotWithCounters({
      coursenotif_worker_session_expired_loop_total: 1
    }),
    previousState: {
      previousSessionExpiredCount: 5,
      sessionExpiredEventTimestamps: [],
      lastAlertAtByKey: {}
    },
    supervisorState: null,
    config: createWatchdogConfig({
      sessionExpiryThreshold: 1
    }),
    nowMs
  });

  assert.equal(result.sessionExpiredDelta, 1);
  assert.equal(result.sessionExpiryEventsInWindow, 1);
  assert.deepEqual(
    result.alerts.map((alert) => alert.key),
    ["session_expiry_loop"]
  );
});

test("evaluateWatchdog alerts on supervisor crash-loop state", () => {
  const nowMs = Date.parse("2026-03-21T18:15:00.000Z");
  const result = evaluateWatchdog({
    status: {
      ok: true,
      reason: "healthy"
    },
    snapshot: createSnapshotWithCounters(),
    previousState: {},
    supervisorState: {
      restartCountInWindow: 6,
      crashLoopActive: true,
      windowSeconds: 600,
      lastExitCode: 1
    },
    config: createWatchdogConfig(),
    nowMs
  });

  assert.deepEqual(
    result.alerts.map((alert) => alert.key),
    ["supervisor_crash_loop"]
  );
  assert.equal(result.alerts[0].restartCountInWindow, 6);
  assert.equal(result.restart, null);
});

test("evaluateWatchdog suppresses supervisor crash-loop alerts while worker is intentionally disabled", () => {
  const nowMs = Date.parse("2026-03-21T18:20:00.000Z");
  const result = evaluateWatchdog({
    status: {
      ok: true,
      reason: "disabled"
    },
    snapshot: createSnapshotWithCounters(),
    previousState: {},
    supervisorState: {
      restartCountInWindow: 6,
      crashLoopActive: true,
      windowSeconds: 600,
      lastExitCode: 0
    },
    config: createWatchdogConfig(),
    nowMs
  });

  assert.deepEqual(result.alerts, []);
  assert.equal(result.restart, null);
});
