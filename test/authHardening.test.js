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

test("API exposes session listing and revocation controls", async (t) => {
  const sessionToken = "current-session-token";
  const sessionTokenHash = hashSha256(sessionToken);
  const sessions = [
    {
      id: 1,
      user_id: 7,
      email: "user@example.com",
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      revoked_at: null,
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      last_seen_at: new Date().toISOString(),
      last_ip: "127.0.0.1",
      user_agent: "Mac Browser"
    },
    {
      id: 2,
      user_id: 7,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      revoked_at: null,
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      last_seen_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      last_ip: "127.0.0.2",
      user_agent: "Windows Browser"
    },
    {
      id: 3,
      user_id: 7,
      expires_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      revoked_at: null,
      created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      last_seen_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      last_ip: "127.0.0.3",
      user_agent: "Linux Browser"
    },
    {
      id: 4,
      user_id: 7,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      revoked_at: null,
      created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      last_seen_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      last_ip: "127.0.0.4",
      user_agent: "Chrome"
    }
  ];
  const db = {
    getAuthSessionByTokenHash: async (tokenHash) => {
      if (tokenHash !== sessionTokenHash) {
        return null;
      }
      return sessions[0];
    },
    touchAuthSessionActivity: async () => {},
    revokeAuthSessionByTokenHash: async () => {},
    listAuthSessionsByUser: async (userId) =>
      sessions.filter((session) => session.user_id === userId),
    revokeAuthSessionByIdForUser: async ({ sessionId, userId }) => {
      const session = sessions.find(
        (candidate) => candidate.id === sessionId && candidate.user_id === userId
      );
      const expiresAtMs = session ? new Date(session.expires_at).getTime() : NaN;
      if (
        !session ||
        session.revoked_at ||
        !Number.isFinite(expiresAtMs) ||
        expiresAtMs <= Date.now()
      ) {
        return 0;
      }
      session.revoked_at = new Date().toISOString();
      return 1;
    },
    revokeOtherAuthSessionsForUser: async ({ userId, currentSessionId }) => {
      let revokedCount = 0;
      for (const session of sessions) {
        const expiresAtMs = new Date(session.expires_at).getTime();
        if (
          session.user_id === userId &&
          session.id !== currentSessionId &&
          !session.revoked_at &&
          Number.isFinite(expiresAtMs) &&
          expiresAtMs > Date.now()
        ) {
          session.revoked_at = new Date().toISOString();
          revokedCount += 1;
        }
      }
      return revokedCount;
    }
  };
  const app = createApiApp({
    db,
    notifierModule: createNotifierStub(),
    env: {
      ...process.env,
      OTP_PEPPER: "test-pepper",
      AUTH_COOKIE_SECURE: "false"
    }
  });
  const server = http.createServer(app);
  const address = await listenOrSkip(server, t);
  if (!address) {
    return;
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cookie = `coursenotif_session=${sessionToken}`;

  try {
    const listBefore = await requestJson(baseUrl, "/api/auth/sessions", {
      cookie
    });
    assert.equal(listBefore.status, 200);
    assert.equal(listBefore.json.items.length, 4);
    assert.equal(listBefore.json.items.find((item) => item.id === 1).current, true);
    assert.equal(listBefore.json.items.find((item) => item.id === 3).expired, true);

    const revokeOne = await requestJson(baseUrl, "/api/auth/sessions/2/revoke", {
      method: "POST",
      cookie
    });
    assert.equal(revokeOne.status, 200);
    assert.equal(revokeOne.json.ok, true);

    const revokeCurrent = await requestJson(baseUrl, "/api/auth/sessions/1/revoke", {
      method: "POST",
      cookie
    });
    assert.equal(revokeCurrent.status, 400);
    assert.match(String(revokeCurrent.json.error || ""), /use logout/i);

    const logoutOthers = await requestJson(baseUrl, "/api/auth/logout-others", {
      method: "POST",
      cookie
    });
    assert.equal(logoutOthers.status, 200);
    assert.equal(logoutOthers.json.revokedCount, 1);

    const listAfter = await requestJson(baseUrl, "/api/auth/sessions", {
      cookie
    });
    assert.equal(
      listAfter.json.items.filter((item) => !item.current && item.revokedAt).length,
      2
    );
    assert.equal(listAfter.json.items.find((item) => item.id === 3).expired, true);
    assert.equal(listAfter.json.items.find((item) => item.id === 3).revokedAt, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
