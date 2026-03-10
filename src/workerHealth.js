const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_WORKER_HEALTH_PATH = "/tmp/coursenotif_worker_health.json";

function resolveWorkerHealthPath(env = process.env) {
  const configured = String(env.WORKER_HEALTH_PATH || "").trim();
  return configured || DEFAULT_WORKER_HEALTH_PATH;
}

async function writeWorkerHealthSnapshot(
  snapshot,
  { healthPath = resolveWorkerHealthPath(process.env) } = {}
) {
  const targetPath = String(healthPath || "").trim() || DEFAULT_WORKER_HEALTH_PATH;
  const directory = path.dirname(targetPath);
  await fs.mkdir(directory, { recursive: true });

  const payload = {
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    ...snapshot
  };
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, targetPath);
  return payload;
}

async function readWorkerHealthSnapshot(
  { healthPath = resolveWorkerHealthPath(process.env) } = {}
) {
  const targetPath = String(healthPath || "").trim() || DEFAULT_WORKER_HEALTH_PATH;
  const raw = await fs.readFile(targetPath, "utf8");
  return JSON.parse(raw);
}

function checkWorkerHealthStatus(
  snapshot,
  { nowMs = Date.now(), maxStaleSeconds = 300, requirePidAlive = false } = {}
) {
  if (!snapshot || typeof snapshot !== "object") {
    return {
      ok: false,
      reason: "missing_snapshot"
    };
  }

  const updatedAtMs = new Date(snapshot.updatedAt || snapshot.lastHeartbeatAt || 0).getTime();
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) {
    return {
      ok: false,
      reason: "invalid_updated_at"
    };
  }

  const staleSeconds = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000));
  if (staleSeconds > Math.max(1, Number(maxStaleSeconds) || 300)) {
    return {
      ok: false,
      reason: "stale_heartbeat",
      staleSeconds
    };
  }

  if (snapshot.state === "fatal") {
    return {
      ok: false,
      reason: "fatal_state"
    };
  }

  if (requirePidAlive && !isProcessRunning(snapshot.pid)) {
    return {
      ok: false,
      reason: "worker_pid_not_running",
      staleSeconds
    };
  }

  return {
    ok: true,
    reason: "healthy",
    staleSeconds
  };
}

function isProcessRunning(pidValue) {
  const pid = Number.parseInt(String(pidValue || ""), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  DEFAULT_WORKER_HEALTH_PATH,
  resolveWorkerHealthPath,
  writeWorkerHealthSnapshot,
  readWorkerHealthSnapshot,
  checkWorkerHealthStatus,
  isProcessRunning
};
