const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { Pool } = require("pg");
const { createDb } = require("../src/db");
const { createApiApp } = require("../src/apiServer");

function randomSuffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

function buildCookieHeaderFromResponse(response) {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  const parts = setCookies
    .map((cookie) => String(cookie || "").split(";")[0].trim())
    .filter(Boolean);
  return parts.join("; ");
}

function hashSha256(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

const API_RATE_LIMIT_PREFIXES = [
  "auth_send_otp_ip",
  "auth_send_otp_email",
  "auth_verify_otp_ip",
  "auth_verify_otp_email",
  "authenticated_write_user",
  "authenticated_write_ip"
];

async function requestJson(baseUrl, path, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (cookie) {
    headers.cookie = cookie;
  }

  const response = await fetch(`${baseUrl}${path}`, {
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
    headers: response.headers,
    json,
    text,
    cookieHeader: buildCookieHeaderFromResponse(response)
  };
}

async function clearApiRateLimitKeys(pool, keys) {
  const uniqueKeys = [
    ...new Set(
      keys
        .filter(Boolean)
        .flatMap((key) => {
          const textKey = String(key);
          const alreadyNamespaced = API_RATE_LIMIT_PREFIXES.some((prefix) =>
            textKey.startsWith(`${prefix}:`)
          );
          if (alreadyNamespaced) {
            return [textKey];
          }
          return [textKey, ...API_RATE_LIMIT_PREFIXES.map((prefix) => `${prefix}:${textKey}`)];
        })
    )
  ];
  if (uniqueKeys.length === 0) {
    return;
  }
  await pool.query(
    `
    DELETE FROM api_rate_limits
    WHERE limiter_key = ANY($1::text[])
    `,
    [uniqueKeys]
  );
}

test(
  "API integration: OTP auth + tracked course CRUD",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const db = createDb({ databaseUrl: process.env.DATABASE_URL });
    await db.ensureCompatibility();

    const otpCodesByEmail = new Map();
    const notifierModule = {
      sendLoginOtpEmail: async ({ toEmail, otpCode }) => {
        otpCodesByEmail.set(String(toEmail || "").trim().toLowerCase(), String(otpCode || ""));
      },
      sendCourseOpenEmail: async () => ({ messageId: "test-message-id" }),
      sendSessionExpiredEmail: async () => {}
    };

    const env = {
      ...process.env,
      OTP_PEPPER: process.env.OTP_PEPPER || "test-pepper",
      AUTH_COOKIE_SECURE: "false"
    };

    const app = createApiApp({ db, notifierModule, env });
    const server = http.createServer(app);

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const suffix = randomSuffix();
    const email = `apitest-${suffix}@example.com`;
    const numericSuffix = String(suffix).replace(/\D/g, "").slice(-5).padStart(5, "0");
    const cartId = `A${numericSuffix}`;
    const cleanupPool = new Pool({ connectionString: process.env.DATABASE_URL });

    try {
      await clearApiRateLimitKeys(cleanupPool, [
        "ip:127.0.0.1",
        `email:${email.toLowerCase()}`
      ]);

      const health = await requestJson(baseUrl, "/api/health");
      assert.equal(health.status, 200);
      assert.deepEqual(health.json, { ok: true });

      const unauthList = await requestJson(baseUrl, "/api/tracked-courses");
      assert.equal(unauthList.status, 401);

      const sendOtp = await requestJson(baseUrl, "/api/auth/send-otp", {
        method: "POST",
        body: { email }
      });
      assert.equal(sendOtp.status, 200);
      assert.equal(sendOtp.json.ok, true);

      const otpCode = otpCodesByEmail.get(email.toLowerCase());
      assert.ok(/^\d{6}$/.test(String(otpCode || "")));

      const verifyOtp = await requestJson(baseUrl, "/api/auth/verify-otp", {
        method: "POST",
        body: { email, otp: otpCode }
      });
      assert.equal(verifyOtp.status, 200);
      assert.equal(verifyOtp.json.ok, true);
      assert.ok(verifyOtp.cookieHeader.includes("coursenotif_session="));

      const sessionCookie = verifyOtp.cookieHeader;

      const me = await requestJson(baseUrl, "/api/auth/me", {
        cookie: sessionCookie
      });
      assert.equal(me.status, 200);
      assert.equal(me.json.authenticated, true);
      assert.equal(me.json.user.email, email.toLowerCase());

      const createTrack = await requestJson(baseUrl, "/api/tracked-courses", {
        method: "POST",
        cookie: sessionCookie,
        body: { cartId }
      });
      assert.equal(createTrack.status, 201);
      assert.equal(createTrack.json.created, true);
      assert.equal(createTrack.json.item.cartId, cartId);
      const trackedId = Number(createTrack.json.item.id);
      assert.ok(Number.isFinite(trackedId) && trackedId > 0);

      const updateTrack = await requestJson(baseUrl, "/api/tracked-courses", {
        method: "POST",
        cookie: sessionCookie,
        body: { cartId, courseName: "Custom Name" }
      });
      assert.equal(updateTrack.status, 200);
      assert.equal(updateTrack.json.created, false);
      assert.equal(updateTrack.json.item.courseName, "Custom Name");

      const listAfterCreate = await requestJson(baseUrl, "/api/tracked-courses", {
        cookie: sessionCookie
      });
      assert.equal(listAfterCreate.status, 200);
      assert.equal(Array.isArray(listAfterCreate.json.items), true);
      assert.equal(listAfterCreate.json.items.length, 1);
      assert.equal(listAfterCreate.json.items[0].cartId, cartId);
      assert.equal(listAfterCreate.json.items[0].trackingStatus, "active");
      assert.equal(listAfterCreate.json.items[0].lastCheckedAt, null);
      assert.equal(listAfterCreate.json.items[0].lastObservedOs, null);
      assert.equal(listAfterCreate.json.items[0].requiresFreshScan, true);

      const invalidCart = await requestJson(baseUrl, "/api/tracked-courses", {
        method: "POST",
        cookie: sessionCookie,
        body: { cartId: "BAD1" }
      });
      assert.equal(invalidCart.status, 400);
      assert.match(String(invalidCart.json.error || ""), /exactly 6 characters/i);

      const pauseTrack = await requestJson(
        baseUrl,
        `/api/tracked-courses/${trackedId}/pause`,
        {
          method: "POST",
          cookie: sessionCookie
        }
      );
      assert.equal(pauseTrack.status, 200);
      assert.equal(pauseTrack.json.ok, true);

      const resumeTrack = await requestJson(
        baseUrl,
        `/api/tracked-courses/${trackedId}/resume`,
        {
          method: "POST",
          cookie: sessionCookie
        }
      );
      assert.equal(resumeTrack.status, 200);
      assert.equal(resumeTrack.json.ok, true);

      const del = await requestJson(baseUrl, `/api/tracked-courses/${trackedId}`, {
        method: "DELETE",
        cookie: sessionCookie
      });
      assert.equal(del.status, 204);

      const listAfterDelete = await requestJson(baseUrl, "/api/tracked-courses", {
        cookie: sessionCookie
      });
      assert.equal(listAfterDelete.status, 200);
      assert.equal(listAfterDelete.json.items.length, 0);

      const logout = await requestJson(baseUrl, "/api/auth/logout", {
        method: "POST",
        cookie: sessionCookie
      });
      assert.equal(logout.status, 200);
      assert.equal(logout.json.ok, true);
    } finally {
      await clearApiRateLimitKeys(cleanupPool, [
          `email:${email.toLowerCase()}`,
          "ip:127.0.0.1"
      ]);
      await cleanupPool.query(
        "DELETE FROM notification_attempts WHERE to_email = $1 OR cart_id = $2",
        [email.toLowerCase(), cartId]
      );
      await cleanupPool.query(
        "DELETE FROM user_courses WHERE user_id IN (SELECT id FROM users WHERE email = $1)",
        [email.toLowerCase()]
      );
      await cleanupPool.query("DELETE FROM courses WHERE cart_id = $1", [cartId]);
      await cleanupPool.query("DELETE FROM auth_otp_challenges WHERE email = $1", [
        email.toLowerCase()
      ]);
      await cleanupPool.query(
        "DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)",
        [email.toLowerCase()]
      );
      await cleanupPool.query("DELETE FROM users WHERE email = $1", [email.toLowerCase()]);
      await cleanupPool.end();
      await db.close();
      await new Promise((resolve) => server.close(resolve));
    }
  }
);

test(
  "API integration: auth rate limits are shared across app instances",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const db = createDb({ databaseUrl: process.env.DATABASE_URL });
    await db.ensureCompatibility();

    const notifierModule = {
      sendLoginOtpEmail: async () => {},
      sendCourseOpenEmail: async () => ({ messageId: "test-message-id" }),
      sendSessionExpiredEmail: async () => {}
    };

    const env = {
      ...process.env,
      OTP_PEPPER: process.env.OTP_PEPPER || "test-pepper",
      AUTH_COOKIE_SECURE: "false",
      AUTH_OTP_MAX_FAILED_ATTEMPTS: "10",
      AUTH_RATE_LIMIT_WINDOW_SECONDS: "60",
      AUTH_VERIFY_OTP_MAX_PER_IP: "1000",
      AUTH_VERIFY_OTP_MAX_PER_EMAIL: "2",
      AUTH_VERIFY_OTP_LOCKOUT_SECONDS: "120"
    };

    const appOne = createApiApp({ db, notifierModule, env });
    const appTwo = createApiApp({ db, notifierModule, env });
    const serverOne = http.createServer(appOne);
    const serverTwo = http.createServer(appTwo);

    await new Promise((resolve) => serverOne.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => serverTwo.listen(0, "127.0.0.1", resolve));
    const baseUrlOne = `http://127.0.0.1:${serverOne.address().port}`;
    const baseUrlTwo = `http://127.0.0.1:${serverTwo.address().port}`;

    const suffix = randomSuffix();
    const email = `shared-limit-${suffix}@example.com`;
    const cleanupPool = new Pool({ connectionString: process.env.DATABASE_URL });

    try {
      await clearApiRateLimitKeys(cleanupPool, [
        "ip:127.0.0.1",
        `email:${email}`
      ]);

      await db.invalidateActiveOtpChallengesByEmail(email);
      await db.createOtpChallenge({
        email,
        otpHash: hashSha256(`${email}|123456|${env.OTP_PEPPER}`),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      });

      const first = await requestJson(baseUrlOne, "/api/auth/verify-otp", {
        method: "POST",
        body: { email, otp: "000000" }
      });
      const second = await requestJson(baseUrlTwo, "/api/auth/verify-otp", {
        method: "POST",
        body: { email, otp: "000000" }
      });
      const third = await requestJson(baseUrlOne, "/api/auth/verify-otp", {
        method: "POST",
        body: { email, otp: "000000" }
      });

      assert.equal(first.status, 400);
      assert.equal(second.status, 400);
      assert.equal(third.status, 429);
      assert.match(String(third.json.error || ""), /too many otp verification attempts/i);
    } finally {
      await clearApiRateLimitKeys(cleanupPool, [`email:${email}`, "ip:127.0.0.1"]);
      await cleanupPool.query("DELETE FROM auth_otp_challenges WHERE email = $1", [
        email
      ]);
      await cleanupPool.end();
      await db.close();
      await new Promise((resolve) => serverOne.close(resolve));
      await new Promise((resolve) => serverTwo.close(resolve));
    }
  }
);

test(
  "DB-backed API rate limits handle concurrent first hits without errors",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const dbOne = createDb({ databaseUrl: process.env.DATABASE_URL });
    const dbTwo = createDb({ databaseUrl: process.env.DATABASE_URL });
    await dbOne.ensureCompatibility();
    await dbTwo.ensureCompatibility();

    const cleanupPool = new Pool({ connectionString: process.env.DATABASE_URL });
    const limiterKey = `auth_verify_otp_email:email:concurrent-${randomSuffix()}@example.com`;
    const attempts = 12;

    try {
      await clearApiRateLimitKeys(cleanupPool, [limiterKey]);

      const results = await Promise.allSettled(
        Array.from({ length: attempts }, (_, index) => {
          const db = index % 2 === 0 ? dbOne : dbTwo;
          return db.consumeApiRateLimit({
            key: limiterKey,
            windowMs: 60 * 1000,
            maxRequests: attempts + 5
          });
        })
      );

      assert.equal(
        results.every((result) => result.status === "fulfilled"),
        true
      );
      assert.equal(
        results.every((result) => result.status === "fulfilled" && result.value.allowed),
        true
      );

      const stored = await cleanupPool.query(
        `
        SELECT request_count
        FROM api_rate_limits
        WHERE limiter_key = $1
        `,
        [limiterKey]
      );
      assert.equal(stored.rowCount, 1);
      assert.equal(Number(stored.rows[0].request_count), attempts);
    } finally {
      await clearApiRateLimitKeys(cleanupPool, [limiterKey]);
      await cleanupPool.end();
      await dbOne.close();
      await dbTwo.close();
    }
  }
);
