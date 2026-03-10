#!/usr/bin/env node

const {
  resolveWorkerHealthPath,
  readWorkerHealthSnapshot,
  checkWorkerHealthStatus,
  isProcessRunning
} = require("../src/workerHealth");

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function main() {
  const healthPath = resolveWorkerHealthPath(process.env);
  const maxStaleSeconds = parsePositiveInt(
    process.env.WORKER_HEALTH_MAX_STALE_SECONDS,
    300
  );

  let snapshot;
  try {
    snapshot = await readWorkerHealthSnapshot({ healthPath });
  } catch (error) {
    const payload = {
      ok: false,
      reason: "health_file_unreadable",
      healthPath,
      error: error && error.message ? error.message : String(error)
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
    return;
  }

  const status = checkWorkerHealthStatus(snapshot, {
    maxStaleSeconds,
    requirePidAlive: true
  });
  const pidRunning = isProcessRunning(snapshot && snapshot.pid);
  const ok = Boolean(status.ok);
  const reason = status.reason;

  const payload = {
    ok,
    reason,
    healthPath,
    maxStaleSeconds,
    pid: snapshot && snapshot.pid ? Number(snapshot.pid) : null,
    pidRunning,
    state: snapshot && snapshot.state ? snapshot.state : null,
    mode: snapshot && snapshot.mode ? snapshot.mode : null,
    updatedAt: snapshot && snapshot.updatedAt ? snapshot.updatedAt : null,
    staleSeconds:
      typeof status.staleSeconds === "number" ? status.staleSeconds : null
  };

  console.log(JSON.stringify(payload, null, 2));
  process.exit(ok ? 0 : 1);
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
