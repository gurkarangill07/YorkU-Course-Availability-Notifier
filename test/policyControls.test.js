const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../src/config");
const {
  getInitLoginBehaviorNote,
  parseCliArgs,
  isMonitoringMode,
  resolveRunMode,
  resolveEmergencyDisableState
} = require("../src/worker");

function loadPolicyConfig(overrides = {}) {
  return loadConfig({
    DATABASE_URL: "postgresql://user:pass@localhost:5432/coursenotif",
    ...overrides
  });
}

test("config clamps monitor interval to MIN_POLL_INTERVAL_SECONDS", () => {
  const config = loadPolicyConfig({
    MONITOR_INTERVAL_SECONDS: "10",
    MIN_POLL_INTERVAL_SECONDS: "45"
  });

  assert.equal(config.requestedMonitorIntervalSeconds, 10);
  assert.equal(config.minPollIntervalSeconds, 45);
  assert.equal(config.monitorIntervalSeconds, 45);
  assert.equal(config.monitorIntervalWasClamped, true);
});

test("config keeps requested interval when already above policy minimum", () => {
  const config = loadPolicyConfig({
    MONITOR_INTERVAL_SECONDS: "90",
    MIN_POLL_INTERVAL_SECONDS: "30"
  });

  assert.equal(config.requestedMonitorIntervalSeconds, 90);
  assert.equal(config.minPollIntervalSeconds, 30);
  assert.equal(config.monitorIntervalSeconds, 90);
  assert.equal(config.monitorIntervalWasClamped, false);
});

test("config enforces minimum poll floor of one second", () => {
  const config = loadPolicyConfig({
    MONITOR_INTERVAL_SECONDS: "1",
    MIN_POLL_INTERVAL_SECONDS: "0"
  });

  assert.equal(config.minPollIntervalSeconds, 1);
  assert.equal(config.monitorIntervalSeconds, 1);
  assert.equal(config.monitorIntervalWasClamped, false);
});

test("config reads emergency reason from alias env and trims whitespace", () => {
  const config = loadPolicyConfig({
    MONITOR_EMERGENCY_DISABLE: "true",
    MONITOR_EMERGENCY_DISABLE_REASON: "  Maintenance window active.  "
  });

  assert.equal(config.monitorEmergencyDisable, true);
  assert.equal(config.monitorEmergencyReason, "Maintenance window active.");
});

test("config falls back to default emergency reason when provided value is blank", () => {
  const config = loadPolicyConfig({
    MONITOR_EMERGENCY_DISABLE: "true",
    MONITOR_EMERGENCY_REASON: "   "
  });

  assert.equal(
    config.monitorEmergencyReason,
    "Monitoring is disabled by policy (MONITOR_EMERGENCY_DISABLE=true)."
  );
});

test("isMonitoringMode only returns true for monitoring execution modes", () => {
  assert.equal(isMonitoringMode("loop"), true);
  assert.equal(isMonitoringMode("once"), true);
  assert.equal(isMonitoringMode("check_new_course"), true);
  assert.equal(isMonitoringMode("init_login"), false);
  assert.equal(isMonitoringMode("init_login_keep_open"), false);
});

test("resolveEmergencyDisableState only disables monitoring modes", () => {
  const config = loadPolicyConfig({
    MONITOR_EMERGENCY_DISABLE: "true",
    MONITOR_EMERGENCY_REASON: "Emergency disable for incident response."
  });

  const monitoringModeState = resolveEmergencyDisableState({
    config,
    mode: "once"
  });
  assert.equal(monitoringModeState.active, true);
  assert.equal(
    monitoringModeState.reason,
    "Emergency disable for incident response."
  );

  const initModeState = resolveEmergencyDisableState({
    config,
    mode: "init_login"
  });
  assert.equal(initModeState.active, false);
});

test("parseCliArgs + resolveRunMode detect keep-open init-login mode", () => {
  const args = parseCliArgs(["--init-login", "--keep-open"]);

  assert.equal(args.initLogin, true);
  assert.equal(args.keepOpen, true);
  assert.equal(resolveRunMode(args), "init_login_keep_open");
});

test("getInitLoginBehaviorNote warns when init-login will close the browser", () => {
  const args = parseCliArgs(["--init-login"]);
  const note = getInitLoginBehaviorNote(args);

  assert.ok(note);
  assert.equal(note.event, "worker.init_login.browser_closes_on_exit");
  assert.match(note.message, /closes the browser/i);
  assert.match(note.message, /keep-open/i);
});

test("getInitLoginBehaviorNote explains keep-open behavior", () => {
  const args = parseCliArgs(["--init-login", "--keep-open"]);
  const note = getInitLoginBehaviorNote(args);

  assert.ok(note);
  assert.equal(note.event, "worker.init_login.keep_open_enabled");
  assert.match(note.message, /keep the browser open/i);
});
