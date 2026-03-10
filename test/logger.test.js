const test = require("node:test");
const assert = require("node:assert/strict");
const { createLogger } = require("../src/logger");

function captureWrites(target) {
  const writes = [];
  const original = target.write;
  target.write = (chunk, encoding, callback) => {
    writes.push(String(chunk));
    if (typeof encoding === "function") {
      encoding();
    } else if (typeof callback === "function") {
      callback();
    }
    return true;
  };
  return {
    writes,
    restore: () => {
      target.write = original;
    }
  };
}

test("logger preserves numeric zero message values", () => {
  const stdoutCapture = captureWrites(process.stdout);
  try {
    const logger = createLogger({
      component: "logger-test",
      format: "json",
      level: "debug"
    });
    logger.info(0, { event: "logger.zero_message" });

    assert.equal(stdoutCapture.writes.length, 1);
    const line = stdoutCapture.writes[0].trim();
    const parsed = JSON.parse(line);
    assert.equal(parsed.message, "0");
    assert.equal(parsed.event, "logger.zero_message");
  } finally {
    stdoutCapture.restore();
  }
});

test("logger includes non-Error throwables in normalized error fields", () => {
  const stderrCapture = captureWrites(process.stderr);
  try {
    const logger = createLogger({
      component: "logger-test",
      format: "json",
      level: "debug"
    });
    logger.error("plain error payload", {
      event: "logger.non_error_payload",
      error: "smtp timeout"
    });

    assert.equal(stderrCapture.writes.length, 1);
    const line = stderrCapture.writes[0].trim();
    const parsed = JSON.parse(line);
    assert.equal(parsed.errorMessage, "smtp timeout");
    assert.equal(parsed.errorName, "Error");
    assert.equal(parsed.event, "logger.non_error_payload");
  } finally {
    stderrCapture.restore();
  }
});
