const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { loadConfig } = require("./config");
const { createDb } = require("./db");
const notifier = require("./notification");

const SESSION_COOKIE_NAME = "coursenotif_session";

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

function mapTrackedCourseRow(row) {
  return {
    id: row.user_course_id,
    cartId: row.cart_id,
    courseName: row.display_name || row.course_name || row.cart_id,
    os: Number.isFinite(Number(row.os)) ? Number(row.os) : 0,
    trackingStatus: row.tracking_status || "active",
    notifiedAt: row.notified_at || null,
    createdAt: row.created_at
  };
}

async function main() {
  const config = loadConfig();
  const db = createDb({ databaseUrl: config.databaseUrl });
  await db.ensureCompatibility();
  const app = express();
  const port = Number.parseInt(process.env.PORT || "3000", 10);
  const otpTtlMinutes = parseIntWithFallback(process.env.AUTH_OTP_TTL_MINUTES, 10);
  const otpResendCooldownSeconds = parseIntWithFallback(
    process.env.AUTH_OTP_RESEND_COOLDOWN_SECONDS,
    60
  );
  const otpMaxFailedAttempts = parseIntWithFallback(
    process.env.AUTH_OTP_MAX_FAILED_ATTEMPTS,
    5
  );
  const authSessionDays = parseIntWithFallback(process.env.AUTH_SESSION_DAYS, 30);
  const authCookieSecure = parseBoolean(process.env.AUTH_COOKIE_SECURE, false);
  const otpPepper = String(process.env.OTP_PEPPER || "").trim();
  const authSessionMaxAgeMs = authSessionDays * 24 * 60 * 60 * 1000;

  app.use(express.json());

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
    return hashSha256(`${String(email || "").trim().toLowerCase()}|${String(otp || "").trim()}|${otpPepper}`);
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

    return {
      tokenHash,
      userId: session.user_id,
      email: session.email
    };
  }

  async function requireAuth(req, res, next) {
    try {
      const auth = await resolveAuth(req);
      if (!auth) {
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

  app.get("/api/auth/me", async (req, res, next) => {
    try {
      const auth = await resolveAuth(req);
      if (!auth) {
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

  app.post("/api/auth/send-otp", async (req, res, next) => {
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
        await notifier.sendLoginOtpEmail({
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
  });

  app.post("/api/auth/verify-otp", async (req, res, next) => {
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
        expiresAt: sessionExpiresAt
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

  app.post("/api/tracked-courses", requireAuth, async (req, res, next) => {
    try {
      const cartId = normalizeCartId(req.body && req.body.cartId);
      const courseName = normalizeCourseName(req.body && req.body.courseName);
      if (!cartId) {
        return res.status(400).json({ error: "cartId is required." });
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
        if (existing.tracking_status === "notified") {
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
          item: {
            id: refreshed.user_course_id,
            cartId: refreshed.cart_id,
            courseName: refreshed.display_name || refreshed.course_name || refreshed.cart_id,
            os: Number.isFinite(Number(refreshed.os)) ? Number(refreshed.os) : 0,
            trackingStatus: refreshed.tracking_status || "active",
            notifiedAt: refreshed.notified_at || null
          }
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
        item: {
          id: tracked.user_course_id,
          cartId: tracked.cart_id,
          courseName: tracked.display_name || tracked.course_name || tracked.cart_id,
          os: Number.isFinite(Number(tracked.os)) ? Number(tracked.os) : 0,
          trackingStatus: tracked.tracking_status || "active",
          notifiedAt: tracked.notified_at || null
        }
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/tracked-courses/:id/resume", requireAuth, async (req, res, next) => {
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
  });

  app.delete("/api/tracked-courses/:id", requireAuth, async (req, res, next) => {
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
  });

  app.get("/", (_req, res) => {
    res.sendFile(path.join(process.cwd(), "index.html"));
  });

  app.use("/src", express.static(path.join(process.cwd(), "src"), { index: false }));

  app.use((err, _req, res, _next) => {
    console.error(`[api] ${err.stack || err.message}`);
    res.status(500).json({ error: "Internal server error." });
  });

  const server = app.listen(port, () => {
    console.log(`[api] listening on http://localhost:${port}`);
  });

  async function shutdown() {
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`[api] fatal: ${error.message}`);
  process.exit(1);
});
