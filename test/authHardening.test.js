const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { createApiApp } = require("../src/apiServer");

function hashSha256(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

async function requestJson(baseUrl, routePath, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (cookie) {
    headers.cookie = cookie;
  }

  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (_error) {
      json = null;
    }
  }

  return {
    status: response.status,
    json,
    headers: response.headers
  };
}

async function listenOrSkip(server, t) {
  try {
    const address = await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(server.address());
      };
      server.on("error", onError);
      server.listen(0, "127.0.0.1", onListening);
    });
    return address;
  } catch (error) {
    if (error && error.code === "EPERM") {
      t.skip("TCP listen is not permitted in this environment.");
      return null;
    }
    throw error;
  }
}

function createNotifierStub() {
  return {
    sendLoginOtpEmail: async () => {},
    sendCourseOpenEmail: async () => ({ messageId: "mid" }),
    sendSessionExpiredEmail: async () => {}
  };
}

test("API auth send-otp rate limits repeated requests", async (t) => {
  const db = {
    cleanupExpiredAuthRecords: async () => {},
    getLatestOtpChallengeByEmail: async () => null,
    invalidateActiveOtpChallengesByEmail: async () => {},
    createOtpChallenge: async () => ({ id: 1 }),
    markOtpChallengeConsumed: async () => {}
  };
  const app = createApiApp({
    db,
    notifierModule: createNotifierStub(),
    env: {
      ...process.env,
      OTP_PEPPER: "test-pepper",
      AUTH_COOKIE_SECURE: "false",
      AUTH_RATE_LIMIT_WINDOW_SECONDS: "60",
      AUTH_SEND_OTP_MAX_PER_IP: "10",
      AUTH_SEND_OTP_MAX_PER_EMAIL: "2"
    }
  });
  const server = http.createServer(app);
  const address = await listenOrSkip(server, t);
  if (!address) {
    return;
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const email = "ratelimit@example.com";
    const first = await requestJson(baseUrl, "/api/auth/send-otp", {
      method: "POST",
      body: { email }
    });
    const second = await requestJson(baseUrl, "/api/auth/send-otp", {
      method: "POST",
      body: { email }
    });
    const third = await requestJson(baseUrl, "/api/auth/send-otp", {
      method: "POST",
      body: { email }
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    assert.match(String(third.json.error || ""), /too many otp requests/i);
    assert.equal(Number.isFinite(Number(third.json.retryAfterSeconds)), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("API auth verify-otp rate limits repeated failures", async (t) => {
  const email = "otp-verify@example.com";
  const expectedOtp = "123456";
  let failedAttempts = 0;
  const db = {
    cleanupExpiredAuthRecords: async () => {},
    getLatestOtpChallengeByEmail: async () => ({
      id: 42,
      email,
      otp_hash: hashSha256(`${email}|${expectedOtp}|test-pepper`),
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      failed_attempts: failedAttempts,
      consumed_at: null,
      created_at: new Date().toISOString()
    }),
    incrementOtpChallengeFailedAttempts: async () => {
      failedAttempts += 1;
      return failedAttempts;
    },
    markOtpChallengeConsumed: async () => {},
    getOrCreateUserByEmail: async () => ({ id: 1, email }),
    createAuthSession: async () => ({ id: 1 })
  };
  const app = createApiApp({
    db,
    notifierModule: createNotifierStub(),
    env: {
      ...process.env,
      OTP_PEPPER: "test-pepper",
      AUTH_COOKIE_SECURE: "false",
      AUTH_OTP_MAX_FAILED_ATTEMPTS: "10",
      AUTH_RATE_LIMIT_WINDOW_SECONDS: "60",
      AUTH_VERIFY_OTP_MAX_PER_IP: "10",
      AUTH_VERIFY_OTP_MAX_PER_EMAIL: "2",
      AUTH_VERIFY_OTP_LOCKOUT_SECONDS: "120"
    }
  });
  const server = http.createServer(app);
  const address = await listenOrSkip(server, t);
  if (!address) {
    return;
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const first = await requestJson(baseUrl, "/api/auth/verify-otp", {
      method: "POST",
      body: { email, otp: "000000" }
    });
    const second = await requestJson(baseUrl, "/api/auth/verify-otp", {
      method: "POST",
      body: { email, otp: "000000" }
    });
    const third = await requestJson(baseUrl, "/api/auth/verify-otp", {
      method: "POST",
      body: { email, otp: "000000" }
    });

    assert.equal(first.status, 400);
    assert.equal(second.status, 400);
    assert.equal(third.status, 429);
    assert.match(String(third.json.error || ""), /too many otp verification attempts/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
