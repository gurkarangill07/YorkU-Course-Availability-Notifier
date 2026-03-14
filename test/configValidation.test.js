const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { validateRuntimeConfig } = require("../src/config");

const BASE_ENV = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/coursenotif",
  SMTP_USER: "mailer@example.com",
  SMTP_PASS: "smtp-pass",
  SMTP_PASS_AUTH: "smtp-auth-pass",
  SMTP_FROM: "CourseNotif <mailer@example.com>",
  OTP_PEPPER: "pepper",
  APP_BASE_URL: "https://coursenotif.example.com",
  VSB_SOURCE_MODE: "db",
  MONITOR_EMERGENCY_DISABLE: "false",
  MIN_POLL_INTERVAL_SECONDS: "30",
  MONITOR_INTERVAL_SECONDS: "60"
};

function validate(runtime, overrides = {}, options = {}) {
  return validateRuntimeConfig({
    env: {
      ...BASE_ENV,
      ...overrides
    },
    runtime,
    ...options
  });
}

function assertNoErrors(result) {
  assert.deepEqual(result.errors, []);
}

test("validateRuntimeConfig: api requires OTP_PEPPER", () => {
  const result = validate("api", { OTP_PEPPER: "" });
  assert.ok(result.errors.some((msg) => msg.includes("OTP_PEPPER")));
});

test("validateRuntimeConfig: api allows SMTP_PASS fallback for OTP", () => {
  const result = validate("api", { SMTP_PASS_AUTH: "" });
  assertNoErrors(result);
  assert.ok(result.warnings.some((msg) => msg.includes("SMTP_PASS_AUTH")));
});

test("validateRuntimeConfig: worker requires SMTP only in monitoring modes", () => {
  const result = validate(
    "worker",
    {
      SMTP_USER: "",
      SMTP_PASS: "",
      APP_BASE_URL: "",
      VSB_SOURCE_MODE: "browser",
      VSB_URL: "https://vsb.example.com"
    },
    {
      mode: "init_login"
    }
  );
  assertNoErrors(result);
});

test("validateRuntimeConfig: worker enforces SMTP in loop mode", () => {
  const result = validate("worker", {
    SMTP_USER: "",
    SMTP_PASS: "",
    APP_BASE_URL: ""
  }, {
    mode: "loop"
  });
  assert.ok(result.errors.some((msg) => msg.includes("SMTP_USER")));
  assert.ok(result.errors.some((msg) => msg.includes("SMTP_PASS")));
  assert.ok(result.errors.some((msg) => msg.includes("APP_BASE_URL")));
});

test("validateRuntimeConfig: worker browser mode requires VSB_URL", () => {
  const result = validate("worker", {
    VSB_SOURCE_MODE: "browser",
    VSB_URL: ""
  });
  assert.ok(result.errors.some((msg) => msg.includes("VSB_URL")));
});

test("validateRuntimeConfig: init-login requires browser source mode", () => {
  const result = validate(
    "worker",
    {
      VSB_SOURCE_MODE: "db"
    },
    {
      mode: "init_login"
    }
  );
  assert.ok(result.errors.some((msg) => msg.includes("VSB_SOURCE_MODE")));
});

test("validateRuntimeConfig: filesystem mode requires JSP_SOURCE_DIR", () => {
  const result = validate("worker", {
    VSB_SOURCE_MODE: "filesystem",
    JSP_SOURCE_DIR: ""
  });
  assert.ok(result.errors.some((msg) => msg.includes("JSP_SOURCE_DIR")));
});

test("validateRuntimeConfig: invalid PORT is rejected", () => {
  const result = validate("api", { PORT: "70000" });
  assert.ok(result.errors.some((msg) => msg.includes("PORT")));
});

test("config validate script supports worker init_login mode", () => {
  const scriptPath = path.join(__dirname, "..", "scripts", "validate-config.js");
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--runtime", "worker", "--mode", "init_login"],
    {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://user:pass@localhost:5432/coursenotif",
        VSB_SOURCE_MODE: "browser",
        VSB_URL: "https://vsb.example.com",
        SMTP_USER: "",
        SMTP_PASS: "",
        APP_BASE_URL: ""
      }
    }
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Config validation passed/);
  assert.doesNotMatch(result.stderr, /SMTP_USER|SMTP_PASS|APP_BASE_URL/);
});
