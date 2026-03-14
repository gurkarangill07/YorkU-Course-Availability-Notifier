const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { loadConfig, validateRuntimeConfig, formatConfigValidationErrors } = require("./config");
const { createDb } = require("./db");
const defaultNotifier = require("./notification");
const { createLogger } = require("./logger");
const { metrics } = require("./metrics");
const {
  readWorkerHealthSnapshot,
  checkWorkerHealthStatus,
  resolveWorkerHealthPath
} = require("./workerHealth");

const SESSION_COOKIE_NAME = "coursenotif_session";
const apiLogger = createLogger({ component: "api" });

function parseIntWithFallback(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || !email.includes("@") || !email.includes(".")) {
    return null;
  }
  return email;
}

function normalizeCartId(value) {
  const cartId = String(value || "").trim().toUpperCase();
  if (!cartId) {
    return null;
  }
  return cartId;
}

function isValidCartId(cartId) {
  return /^[A-Z0-9]{6}$/.test(String(cartId || "").trim());
}

function normalizeCourseName(value) {
  const courseName = String(value || "").trim();
  if (!courseName) {
    return null;
  }
  return courseName;
}

function normalizeOtp(value) {
  const otp = String(value || "")
    .trim()
    .replace(/\s+/g, "");
  if (!/^\d{6}$/.test(otp)) {
    return null;
  }
  return otp;
}

function toNullableFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function parseCookies(rawCookieHeader) {
  const out = {};
  const raw = String(rawCookieHeader || "");
  if (!raw) {
    return out;
  }
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function hashSha256(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

function safeHexCompare(leftHex, rightHex) {
  const left = Buffer.from(String(leftHex || ""), "hex");
  const right = Buffer.from(String(rightHex || ""), "hex");
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function generateOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function getRequestIp(req) {
  if (req && typeof req.ip === "string" && req.ip.trim()) {
    return req.ip.trim();
  }
  if (req && req.socket && typeof req.socket.remoteAddress === "string") {
    return req.socket.remoteAddress.trim() || "unknown";
  }
  return "unknown";
}

function createFixedWindowLimiter({
  windowMs,
  maxRequests,
  blockDurationMs = 0
}) {
  const entries = new Map();

  function prune(now) {
    for (const [key, entry] of entries.entries()) {
      const windowExpired = entry.windowStartedAt + windowMs <= now;
      const blockExpired = !entry.blockedUntil || entry.blockedUntil <= now;
      if (windowExpired && blockExpired) {
        entries.delete(key);
      }
    }
  }

  return {
    consume(key) {
      if (!key) {
        return { allowed: true };
      }

      const now = Date.now();
      if (entries.size > 500) {
        prune(now);
      }

      let entry = entries.get(key);
      if (entry && entry.blockedUntil && entry.blockedUntil > now) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((entry.blockedUntil - now) / 1000)
          )
        };
      }

      if (!entry || entry.windowStartedAt + windowMs <= now) {
        entry = {
          count: 0,
          windowStartedAt: now,
          blockedUntil: 0
        };
      }

      entry.count += 1;
      entries.set(key, entry);

      if (entry.count <= maxRequests) {
        return { allowed: true };
      }

      const retryAfterMs =
        blockDurationMs > 0
          ? blockDurationMs
          : Math.max(1000, entry.windowStartedAt + windowMs - now);
      if (blockDurationMs > 0) {
        entry.blockedUntil = now + blockDurationMs;
        entries.set(key, entry);
      }

      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000))
      };
    }
  };
}

function mapTrackedCourseRow(row) {
  const os = toNullableFiniteNumber(row.os);
  const lastObservedOs = toNullableFiniteNumber(row.last_observed_os);
  return {
    id: row.user_course_id,
    cartId: row.cart_id,
    courseName: row.display_name || row.course_name || row.cart_id,
    os: os === null ? 0 : os,
    lastObservedOs,
    lastCheckedAt: row.last_checked_at || null,
    trackingStatus: row.tracking_status || "active",
    notifiedAt: row.notified_at || null,
    invalidAttempts: Number.isFinite(Number(row.invalid_attempts))
      ? Number(row.invalid_attempts)
      : 0,
    invalidNotifiedAt: row.invalid_notified_at || null,
    requiresFreshScan: Boolean(row.requires_fresh_scan),
    createdAt: row.created_at
  };
}

function mapAuthSessionRow(row, currentSessionId) {
  return {
    id: Number(row.id),
    current: Number(row.id) === Number(currentSessionId),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at || row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at || null,
    lastIp: row.last_ip || null,
    userAgent: row.user_agent || null
  };
}

function createApiApp({
  db,
  notifierModule = defaultNotifier,
  env = process.env,
  logger = apiLogger
} = {}) {
  if (!db) {
    throw new Error("createApiApp requires a db instance.");
  }

  const app = express();
  const otpTtlMinutes = parseIntWithFallback(env.AUTH_OTP_TTL_MINUTES, 10);
  const otpResendCooldownSeconds = parseIntWithFallback(
    env.AUTH_OTP_RESEND_COOLDOWN_SECONDS,
    60
  );
  const otpMaxFailedAttempts = parseIntWithFallback(
    env.AUTH_OTP_MAX_FAILED_ATTEMPTS,
    5
  );
  const authSessionDays = parseIntWithFallback(env.AUTH_SESSION_DAYS, 30);
  const authCookieSecure = parseBoolean(env.AUTH_COOKIE_SECURE, false);
  const otpPepper = String(env.OTP_PEPPER || "").trim();
  const authSessionMaxAgeMs = authSessionDays * 24 * 60 * 60 * 1000;
  const metricsBearerToken = String(env.METRICS_BEARER_TOKEN || "").trim();
  const workerHealthPath = resolveWorkerHealthPath(env);
  const workerHealthMaxStaleSeconds = parseIntWithFallback(
    env.WORKER_HEALTH_MAX_STALE_SECONDS,
    300
  );
  const authRateLimitWindowMs =
    parseIntWithFallback(env.AUTH_RATE_LIMIT_WINDOW_SECONDS, 600) * 1000;
  const authSendOtpMaxPerIp = parseIntWithFallback(env.AUTH_SEND_OTP_MAX_PER_IP, 5);
  const authSendOtpMaxPerEmail = parseIntWithFallback(
    env.AUTH_SEND_OTP_MAX_PER_EMAIL,
    3
  );
  const authVerifyOtpMaxPerIp = parseIntWithFallback(
    env.AUTH_VERIFY_OTP_MAX_PER_IP,
    10
  );
  const authVerifyOtpMaxPerEmail = parseIntWithFallback(
    env.AUTH_VERIFY_OTP_MAX_PER_EMAIL,
    5
  );
  const authVerifyOtpLockoutMs =
    parseIntWithFallback(env.AUTH_VERIFY_OTP_LOCKOUT_SECONDS, 900) * 1000;
  const authenticatedWriteRateLimitWindowMs =
    parseIntWithFallback(env.AUTHENTICATED_WRITE_RATE_LIMIT_WINDOW_SECONDS, 60) *
    1000;
  const authenticatedWriteRateLimitMax = parseIntWithFallback(
    env.AUTHENTICATED_WRITE_RATE_LIMIT_MAX,
    30
  );
  const sendOtpIpLimiter = createFixedWindowLimiter({
    windowMs: authRateLimitWindowMs,
    maxRequests: authSendOtpMaxPerIp,
    blockDurationMs: authRateLimitWindowMs
  });
  const sendOtpEmailLimiter = createFixedWindowLimiter({
    windowMs: authRateLimitWindowMs,
    maxRequests: authSendOtpMaxPerEmail,
    blockDurationMs: authRateLimitWindowMs
  });
  const verifyOtpIpLimiter = createFixedWindowLimiter({
    windowMs: authRateLimitWindowMs,
    maxRequests: authVerifyOtpMaxPerIp,
    blockDurationMs: authVerifyOtpLockoutMs
  });
  const verifyOtpEmailLimiter = createFixedWindowLimiter({
    windowMs: authRateLimitWindowMs,
    maxRequests: authVerifyOtpMaxPerEmail,
    blockDurationMs: authVerifyOtpLockoutMs
  });
  const authenticatedWriteUserLimiter = createFixedWindowLimiter({
    windowMs: authenticatedWriteRateLimitWindowMs,
    maxRequests: authenticatedWriteRateLimitMax,
    blockDurationMs: authenticatedWriteRateLimitWindowMs
  });
  const authenticatedWriteIpLimiter = createFixedWindowLimiter({
    windowMs: authenticatedWriteRateLimitWindowMs,
    maxRequests: authenticatedWriteRateLimitMax,
    blockDurationMs: authenticatedWriteRateLimitWindowMs
  });

  app.use(express.json());
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
      metrics.increment(
        "api_http_requests_total",
        1,
        "Total API HTTP requests observed by the API server."
      );
      metrics.increment(
        `api_http_status_${statusClass}_total`,
        1,
        "API HTTP response counts by status class."
      );
      metrics.observeHistogram("api_http_request_duration_ms", durationMs, {
        help: "API request duration in milliseconds."
      });
      metrics.setGauge(
        "api_process_uptime_seconds",
        process.uptime(),
        "API process uptime in seconds."
      );
      if (res.statusCode >= 500) {
        metrics.increment(
          "api_http_server_errors_total",
          1,
          "Total API responses with HTTP 5xx status."
        );
      }

      logger.info("request completed", {
        event: "api.request.completed",
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(3))
      });
    });
    next();
  });

  function createRateLimitMiddleware({
    limiters,
    event,
    errorMessage
  }) {
    return (req, res, next) => {
      for (const limiterConfig of limiters) {
        const key = limiterConfig.key(req);
        const result = limiterConfig.limiter.consume(key);
        if (result.allowed) {
          continue;
        }

        metrics.increment(
          "api_rate_limit_rejections_total",
          1,
          "Total API requests rejected by route-level rate limiting."
        );
        logger.warn("request rate limited", {
          event,
          limiter: limiterConfig.name,
          method: req.method,
          path: req.path,
          requestIp: getRequestIp(req),
          keyHash: key ? hashSha256(key) : null,
          retryAfterSeconds: result.retryAfterSeconds
        });
        res.set("Retry-After", String(result.retryAfterSeconds));
        return res.status(429).json({
          error: errorMessage,
          retryAfterSeconds: result.retryAfterSeconds
        });
      }
      return next();
    };
  }

  const sendOtpRateLimit = createRateLimitMiddleware({
    event: "api.auth.send_otp.rate_limited",
    errorMessage: "Too many OTP requests. Please try again later.",
    limiters: [
      {
        name: "auth_send_otp_ip",
        limiter: sendOtpIpLimiter,
        key: (req) => `ip:${getRequestIp(req)}`
      },
      {
        name: "auth_send_otp_email",
        limiter: sendOtpEmailLimiter,
        key: (req) => {
          const email = normalizeEmail(req.body && req.body.email);
          return email ? `email:${email}` : null;
        }
      }
    ]
  });

  const verifyOtpRateLimit = createRateLimitMiddleware({
    event: "api.auth.verify_otp.rate_limited",
    errorMessage: "Too many OTP verification attempts. Please try again later.",
    limiters: [
      {
        name: "auth_verify_otp_ip",
        limiter: verifyOtpIpLimiter,
        key: (req) => `ip:${getRequestIp(req)}`
      },
      {
        name: "auth_verify_otp_email",
        limiter: verifyOtpEmailLimiter,
        key: (req) => {
          const email = normalizeEmail(req.body && req.body.email);
          return email ? `email:${email}` : null;
        }
      }
    ]
  });

  const authenticatedWriteRateLimit = createRateLimitMiddleware({
    event: "api.authenticated_write.rate_limited",
    errorMessage: "Too many write requests. Please slow down and try again.",
    limiters: [
      {
        name: "authenticated_write_user",
        limiter: authenticatedWriteUserLimiter,
        key: (req) =>
          req.auth && req.auth.userId ? `user:${req.auth.userId}` : null
      },
      {
        name: "authenticated_write_ip",
        limiter: authenticatedWriteIpLimiter,
        key: (req) => `ip:${getRequestIp(req)}`
      }
    ]
  });

  function setAuthSessionCookie(res, sessionToken) {
    res.cookie(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: authCookieSecure,
      maxAge: authSessionMaxAgeMs,
      path: "/"
    });
  }

  function clearAuthSessionCookie(res) {
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: "lax",
      secure: authCookieSecure,
      path: "/"
    });
  }

  function getSessionTokenFromRequest(req) {
    const cookies = parseCookies(req.headers && req.headers.cookie);
    const token = String(cookies[SESSION_COOKIE_NAME] || "").trim();
    return token || null;
  }

  function hashOtpCode({ email, otp }) {
    return hashSha256(
      `${String(email || "").trim().toLowerCase()}|${String(otp || "").trim()}|${otpPepper}`
    );
  }

  async function resolveAuth(req) {
    const sessionToken = getSessionTokenFromRequest(req);
    if (!sessionToken) {
      return null;
    }

    const tokenHash = hashSha256(sessionToken);
    const session = await db.getAuthSessionByTokenHash(tokenHash);
    if (!session || session.revoked_at) {
      return null;
    }

    const expiresAtMs = new Date(session.expires_at).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      await db.revokeAuthSessionByTokenHash(tokenHash);
      return null;
    }

    if (typeof db.touchAuthSessionActivity === "function") {
      await db.touchAuthSessionActivity({
        tokenHash,
        lastIp: getRequestIp(req)
      });
    }

    return {
      sessionId: session.id,
      tokenHash,
      userId: session.user_id,
      email: session.email
    };
  }

  async function requireAuth(req, res, next) {
    try {
      const auth = await resolveAuth(req);
      if (!auth) {
        if (getSessionTokenFromRequest(req)) {
          clearAuthSessionCookie(res);
        }
        return res.status(401).json({ error: "Authentication required." });
      }
      req.auth = auth;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/metrics", (req, res) => {
    if (metricsBearerToken) {
      const authorization = String(req.headers.authorization || "").trim();
      const expected = `Bearer ${metricsBearerToken}`;
      if (authorization !== expected) {
        return res.status(401).json({ error: "Unauthorized." });
      }
    }

    res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return res.send(metrics.renderPrometheus());
  });

  app.get("/api/worker-health", async (req, res) => {
    if (metricsBearerToken) {
      const authorization = String(req.headers.authorization || "").trim();
      const expected = `Bearer ${metricsBearerToken}`;
      if (authorization !== expected) {
        return res.status(401).json({ error: "Unauthorized." });
      }
    }

    try {
      const snapshot = await readWorkerHealthSnapshot({
        healthPath: workerHealthPath
      });
      const status = checkWorkerHealthStatus(snapshot, {
        maxStaleSeconds: workerHealthMaxStaleSeconds,
        requirePidAlive: true
      });
      metrics.setGauge(
        "api_worker_health_ok",
        status.ok ? 1 : 0,
        "Latest worker health check result via API endpoint."
      );
      return res.status(status.ok ? 200 : 503).json({
        ok: status.ok,
        reason: status.reason,
        staleSeconds:
          typeof status.staleSeconds === "number" ? status.staleSeconds : null,
        workerHealthPath,
        snapshot
      });
    } catch (error) {
      metrics.setGauge(
        "api_worker_health_ok",
        0,
        "Latest worker health check result via API endpoint."
      );
      return res.status(503).json({
        ok: false,
        reason: "worker_health_unreadable",
        workerHealthPath,
        error: error && error.message ? error.message : String(error)
      });
    }
  });

  app.get("/api/auth/me", async (req, res, next) => {
    try {
      const auth = await resolveAuth(req);
      if (!auth) {
        if (getSessionTokenFromRequest(req)) {
          clearAuthSessionCookie(res);
        }
        return res.json({ authenticated: false });
      }
      return res.json({
        authenticated: true,
        user: {
          id: auth.userId,
          email: auth.email
        }
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/auth/sessions", requireAuth, async (req, res, next) => {
    try {
      const items = await db.listAuthSessionsByUser(req.auth.userId);
      return res.json({
        items: items.map((row) => mapAuthSessionRow(row, req.auth.sessionId))
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post(
    "/api/auth/send-otp",
    sendOtpRateLimit,
    async (req, res, next) => {
      try {
        const email = normalizeEmail(req.body && req.body.email);
        if (!email) {
          return res.status(400).json({ error: "Valid email is required." });
        }

        await db.cleanupExpiredAuthRecords();
        const latest = await db.getLatestOtpChallengeByEmail(email);
        if (latest) {
          const expiresAtMs = new Date(latest.expires_at).getTime();
          const hasActiveChallenge =
            !latest.consumed_at &&
            Number.isFinite(expiresAtMs) &&
            expiresAtMs > Date.now();

          if (hasActiveChallenge) {
            const createdAtMs = new Date(latest.created_at).getTime();
            if (Number.isFinite(createdAtMs)) {
              const elapsedSeconds = Math.floor((Date.now() - createdAtMs) / 1000);
              const retryAfterSeconds = otpResendCooldownSeconds - elapsedSeconds;
              if (retryAfterSeconds > 0) {
                return res.status(429).json({
                  error: `Please wait ${retryAfterSeconds}s before requesting another OTP.`,
                  retryAfterSeconds
                });
              }
            }
          }
        }

        const otpCode = generateOtpCode();
        const otpHash = hashOtpCode({ email, otp: otpCode });
        const expiresAt = new Date(Date.now() + otpTtlMinutes * 60 * 1000);

        await db.invalidateActiveOtpChallengesByEmail(email);
        const challenge = await db.createOtpChallenge({
          email,
          otpHash,
          expiresAt
        });

        try {
          await notifierModule.sendLoginOtpEmail({
            toEmail: email,
            otpCode,
            expiresMinutes: otpTtlMinutes
          });
        } catch (sendError) {
          await db.markOtpChallengeConsumed(challenge.id);
          throw sendError;
        }

        return res.json({
          ok: true,
          expiresInSeconds: otpTtlMinutes * 60,
          resendAfterSeconds: otpResendCooldownSeconds
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post("/api/auth/verify-otp", verifyOtpRateLimit, async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body && req.body.email);
      const otp = normalizeOtp(req.body && req.body.otp);
      if (!email) {
        return res.status(400).json({ error: "Valid email is required." });
      }
      if (!otp) {
        return res.status(400).json({ error: "A valid 6-digit OTP is required." });
      }

      await db.cleanupExpiredAuthRecords();
      const challenge = await db.getLatestOtpChallengeByEmail(email);
      if (!challenge) {
        return res.status(400).json({ error: "Invalid or expired OTP." });
      }

      const expiresAtMs = new Date(challenge.expires_at).getTime();
      const isExpired = !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
      const isConsumed = Boolean(challenge.consumed_at);
      if (isExpired || isConsumed || challenge.failed_attempts >= otpMaxFailedAttempts) {
        return res.status(400).json({ error: "Invalid or expired OTP." });
      }

      const providedOtpHash = hashOtpCode({ email, otp });
      if (!safeHexCompare(providedOtpHash, challenge.otp_hash)) {
        const failedAttempts = await db.incrementOtpChallengeFailedAttempts(challenge.id);
        const attemptsRemaining = Math.max(
          0,
          otpMaxFailedAttempts - Number.parseInt(String(failedAttempts || 0), 10)
        );
        return res.status(400).json({
          error: "Invalid or expired OTP.",
          attemptsRemaining
        });
      }

      await db.markOtpChallengeConsumed(challenge.id);
      const user = await db.getOrCreateUserByEmail(email);
      const sessionToken = generateSessionToken();
      const sessionTokenHash = hashSha256(sessionToken);
      const sessionExpiresAt = new Date(Date.now() + authSessionMaxAgeMs);
      await db.createAuthSession({
        userId: user.id,
        tokenHash: sessionTokenHash,
        expiresAt: sessionExpiresAt,
        lastIp: getRequestIp(req),
        userAgent: String(req.headers["user-agent"] || "").trim() || null
      });
      setAuthSessionCookie(res, sessionToken);

      return res.json({
        ok: true,
        user: {
          id: user.id,
          email: user.email
        }
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post(
    "/api/auth/logout-others",
    requireAuth,
    authenticatedWriteRateLimit,
    async (req, res, next) => {
      try {
        const revokedCount = await db.revokeOtherAuthSessionsForUser({
          userId: req.auth.userId,
          currentSessionId: req.auth.sessionId
        });
        return res.json({ ok: true, revokedCount });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/api/auth/sessions/:id/revoke",
    requireAuth,
    authenticatedWriteRateLimit,
    async (req, res, next) => {
      try {
        const sessionId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(sessionId) || sessionId <= 0) {
          return res.status(400).json({ error: "Valid session id is required." });
        }
        if (sessionId === Number(req.auth.sessionId)) {
          return res.status(400).json({
            error: "Use logout to sign out the current session."
          });
        }

        const revoked = await db.revokeAuthSessionByIdForUser({
          sessionId,
          userId: req.auth.userId
        });
        if (!revoked) {
          return res.status(404).json({ error: "Session not found." });
        }

        return res.json({ ok: true });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post("/api/auth/logout", async (req, res, next) => {
    try {
      const sessionToken = getSessionTokenFromRequest(req);
      if (sessionToken) {
        const tokenHash = hashSha256(sessionToken);
        await db.revokeAuthSessionByTokenHash(tokenHash);
      }
      clearAuthSessionCookie(res);
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/tracked-courses", requireAuth, async (req, res, next) => {
    try {
      const items = await db.listTrackedCoursesByUser(req.auth.userId);
      return res.json({ items: items.map(mapTrackedCourseRow) });
    } catch (error) {
      return next(error);
    }
  });

  app.post(
    "/api/tracked-courses",
    requireAuth,
    authenticatedWriteRateLimit,
    async (req, res, next) => {
      try {
        const cartId = normalizeCartId(req.body && req.body.cartId);
        const courseName = normalizeCourseName(req.body && req.body.courseName);
        if (!cartId) {
          return res.status(400).json({ error: "cartId is required." });
        }
        if (!isValidCartId(cartId)) {
          return res.status(400).json({
            error: "cartId must be exactly 6 characters using only A-Z and 0-9."
          });
        }

        const userId = req.auth.userId;
        const existing = await db.getTrackedCourseByUserAndCart(userId, cartId);
        if (existing) {
          if (courseName) {
            await db.setUserCourseDisplayName({
              userId,
              cartId,
              displayName: courseName
            });
          }
          let resumed = false;
          if (
            existing.tracking_status === "notified" ||
            existing.tracking_status === "invalid" ||
            existing.tracking_status === "paused"
          ) {
            await db.resumeUserCourseForUser({
              userCourseId: existing.user_course_id,
              userId
            });
            resumed = true;
          }
          const refreshed = await db.getTrackedCourseByUserAndCart(userId, cartId);
          return res.status(200).json({
            created: false,
            resumed,
            item: mapTrackedCourseRow(refreshed)
          });
        }

        await db.ensureCourseExists(cartId);
        await db.trackCourseForUser({
          userId,
          cartId,
          displayName: courseName || null
        });
        const tracked = await db.getTrackedCourseByUserAndCart(userId, cartId);

        return res.status(201).json({
          created: true,
          item: mapTrackedCourseRow(tracked)
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/api/tracked-courses/:id/pause",
    requireAuth,
    authenticatedWriteRateLimit,
    async (req, res, next) => {
      try {
        const userCourseId = Number.parseInt(req.params.id, 10);
        if (Number.isNaN(userCourseId) || userCourseId <= 0) {
          return res.status(400).json({ error: "Valid user course id is required." });
        }

        const updatedRows = await db.pauseUserCourseForUser({
          userCourseId,
          userId: req.auth.userId
        });
        if (!updatedRows) {
          return res.status(404).json({ error: "Tracked course not found." });
        }

        return res.json({ ok: true });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/api/tracked-courses/:id/resume",
    requireAuth,
    authenticatedWriteRateLimit,
    async (req, res, next) => {
      try {
        const userCourseId = Number.parseInt(req.params.id, 10);
        if (Number.isNaN(userCourseId) || userCourseId <= 0) {
          return res.status(400).json({ error: "Valid user course id is required." });
        }

        const updatedRows = await db.resumeUserCourseForUser({
          userCourseId,
          userId: req.auth.userId
        });
        if (!updatedRows) {
          return res.status(404).json({ error: "Tracked course not found." });
        }

        return res.json({ ok: true });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.delete(
    "/api/tracked-courses/:id",
    requireAuth,
    authenticatedWriteRateLimit,
    async (req, res, next) => {
      try {
        const userCourseId = Number.parseInt(req.params.id, 10);
        if (Number.isNaN(userCourseId) || userCourseId <= 0) {
          return res.status(400).json({ error: "Valid user course id is required." });
        }

        const deletedRows = await db.stopTrackingUserCourseForUser({
          userCourseId,
          userId: req.auth.userId
        });
        if (!deletedRows) {
          return res.status(404).json({ error: "Tracked course not found." });
        }

        return res.status(204).send();
      } catch (error) {
        return next(error);
      }
    }
  );

  app.get("/", (_req, res) => {
    res.sendFile(path.join(process.cwd(), "index.html"));
  });

  app.use("/src", express.static(path.join(process.cwd(), "src"), { index: false }));

  app.use((err, _req, res, _next) => {
    logger.error("request failed", {
      event: "api.request.failed",
      error: err
    });
    metrics.increment(
      "api_request_failures_total",
      1,
      "Unhandled API request failures routed to the Express error middleware."
    );
    res.status(500).json({ error: "Internal server error." });
  });

  return app;
}

async function startApiServer({
  env = process.env,
  notifierModule = defaultNotifier,
  logger = apiLogger
} = {}) {
  const validation = validateRuntimeConfig({ env, runtime: "api" });
  if (validation.warnings.length) {
    logger.warn("config validation warnings", {
      event: "api.config.validation_warning",
      warnings: validation.warnings
    });
  }
  if (validation.errors.length) {
    const error = new Error(formatConfigValidationErrors(validation.errors));
    error.code = "CONFIG_VALIDATION_FAILED";
    throw error;
  }
  const config = loadConfig(env);
  const db = createDb({ databaseUrl: config.databaseUrl });
  await db.ensureCompatibility();
  const app = createApiApp({ db, notifierModule, env, logger });
  const port = Number.parseInt(env.PORT || "3000", 10);

  const server = app.listen(port, () => {
    logger.info("API server listening", {
      event: "api.server.listening",
      port
    });
  });

  async function shutdown({ exit = false } = {}) {
    await new Promise((resolve) => {
      server.close(async () => {
        await db.close();
        resolve();
      });
    });
    logger.info("API server shutdown completed", {
      event: "api.server.shutdown",
      exit
    });
    if (exit) {
      process.exit(0);
    }
  }

  return {
    app,
    server,
    db,
    shutdown
  };
}

async function main() {
  const runtime = await startApiServer();
  let shuttingDown = false;

  async function handleShutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await runtime.shutdown({ exit: true });
  }

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}

module.exports = {
  createApiApp,
  startApiServer
};

if (require.main === module) {
  main().catch((error) => {
    apiLogger.error("API server fatal error", {
      event: "api.server.fatal",
      error
    });
    process.exit(1);
  });
}
