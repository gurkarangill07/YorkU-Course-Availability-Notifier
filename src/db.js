const { Pool } = require("pg");

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeCartId(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function mapNotificationAttemptRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    eventType: row.event_type,
    idempotencyKey: row.idempotency_key,
    suppressionKey: row.suppression_key || null,
    userId: row.user_id ? Number(row.user_id) : null,
    userCourseId: row.user_course_id ? Number(row.user_course_id) : null,
    cartId: row.cart_id,
    toEmail: row.to_email,
    payload: row.payload_json || {},
    status: row.status,
    attemptCount: Number(row.attempt_count) || 0,
    maxAttempts: Number(row.max_attempts) || 1,
    nextRetryAt: row.next_retry_at || null,
    lastAttemptedAt: row.last_attempted_at || null,
    sentAt: row.sent_at || null,
    suppressedUntil: row.suppressed_until || null,
    providerMessageId: row.provider_message_id || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createDb({ databaseUrl }) {
  const pool = new Pool({
    connectionString: databaseUrl
  });

  async function close() {
    await pool.end();
  }

  async function ensureCompatibility() {
    await pool.query(
      `
      ALTER TABLE user_courses
      ADD COLUMN IF NOT EXISTS display_name TEXT;
      ALTER TABLE user_courses
      ADD COLUMN IF NOT EXISTS tracking_status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE user_courses
      ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
      ALTER TABLE user_courses
      ADD COLUMN IF NOT EXISTS invalid_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE user_courses
      ADD COLUMN IF NOT EXISTS invalid_notified_at TIMESTAMPTZ;
      ALTER TABLE user_courses
      DROP CONSTRAINT IF EXISTS user_courses_tracking_status_check;
      ALTER TABLE user_courses
      ADD CONSTRAINT user_courses_tracking_status_check
      CHECK (tracking_status IN ('active', 'notified', 'invalid'));

      CREATE TABLE IF NOT EXISTS notification_attempts (
        id BIGSERIAL PRIMARY KEY,
        event_type TEXT NOT NULL CHECK (event_type IN ('course_open')),
        idempotency_key TEXT NOT NULL UNIQUE,
        suppression_key TEXT,
        user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        user_course_id BIGINT REFERENCES user_courses(id) ON DELETE SET NULL,
        cart_id TEXT NOT NULL,
        to_email TEXT NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'retrying', 'sent', 'failed', 'suppressed')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
        next_retry_at TIMESTAMPTZ,
        last_attempted_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        suppressed_until TIMESTAMPTZ,
        provider_message_id TEXT,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE notification_attempts
      ADD COLUMN IF NOT EXISTS suppression_key TEXT;
      ALTER TABLE notification_attempts
      ADD COLUMN IF NOT EXISTS payload_json JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE notification_attempts
      ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5;
      ALTER TABLE notification_attempts
      ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
      ALTER TABLE notification_attempts
      ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ;
      ALTER TABLE notification_attempts
      ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
      ALTER TABLE notification_attempts
      ADD COLUMN IF NOT EXISTS suppressed_until TIMESTAMPTZ;
      ALTER TABLE notification_attempts
      ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
      ALTER TABLE notification_attempts
      ADD COLUMN IF NOT EXISTS last_error TEXT;

      CREATE INDEX IF NOT EXISTS idx_notification_attempts_due
        ON notification_attempts(status, next_retry_at, id);
      CREATE INDEX IF NOT EXISTS idx_notification_attempts_suppression
        ON notification_attempts(event_type, suppression_key, sent_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notification_attempts_user_course
        ON notification_attempts(user_course_id);
      CREATE INDEX IF NOT EXISTS idx_user_courses_tracking_status
        ON user_courses(tracking_status);
      `
    );

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS auth_otp_challenges (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        otp_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT auth_otp_challenges_email_has_at CHECK (POSITION('@' IN email) > 1)
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_auth_otp_challenges_email_created_at
        ON auth_otp_challenges(email, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON auth_sessions(token_hash);
      `
    );
  }

  async function getSharedSession() {
    const { rows } = await pool.query(
      `
      SELECT
        singleton_id,
        session_state,
        encrypted_session_blob IS NOT NULL AS has_session_blob,
        session_expires_at,
        last_validated_at
      FROM shared_vsb_session
      WHERE singleton_id = 1
      LIMIT 1
      `
    );
    return rows[0] || null;
  }

  async function markSharedSessionExpired(reason) {
    const previous = await getSharedSession();
    await pool.query(
      `
      INSERT INTO shared_vsb_session (
        singleton_id,
        session_state,
        encrypted_session_blob,
        session_expires_at,
        last_validated_at,
        updated_at
      )
      VALUES (
        1,
        'expired',
        NULL,
        NULL,
        NOW(),
        NOW()
      )
      ON CONFLICT (singleton_id) DO UPDATE
      SET
        session_state = EXCLUDED.session_state,
        encrypted_session_blob = EXCLUDED.encrypted_session_blob,
        session_expires_at = EXCLUDED.session_expires_at,
        last_validated_at = EXCLUDED.last_validated_at,
        updated_at = NOW()
      `
    );

    return {
      wasAlreadyExpired: previous ? previous.session_state === "expired" : false,
      reason
    };
  }

  async function markSharedSessionOk({ sessionDurationMinutes = 90 } = {}) {
    const expiresAt = new Date(Date.now() + sessionDurationMinutes * 60 * 1000);
    await pool.query(
      `
      INSERT INTO shared_vsb_session (
        singleton_id,
        session_state,
        encrypted_session_blob,
        session_expires_at,
        last_validated_at,
        created_at,
        updated_at
      )
      VALUES (
        1,
        'ok',
        decode('00', 'hex'),
        $1,
        NOW(),
        NOW(),
        NOW()
      )
      ON CONFLICT (singleton_id) DO UPDATE
      SET
        session_state = EXCLUDED.session_state,
        encrypted_session_blob = EXCLUDED.encrypted_session_blob,
        session_expires_at = EXCLUDED.session_expires_at,
        last_validated_at = EXCLUDED.last_validated_at,
        updated_at = NOW()
      `,
      [expiresAt]
    );
  }

  async function listTrackedCourses() {
    const { rows } = await pool.query(
      `
      SELECT
        uc.id AS user_course_id,
        uc.user_id,
        uc.created_at,
        u.email,
        uc.cart_id,
        uc.display_name,
        uc.tracking_status,
        uc.notified_at,
        uc.invalid_attempts,
        uc.invalid_notified_at,
        c.course_name,
        c.os
      FROM user_courses uc
      INNER JOIN users u ON u.id = uc.user_id
      LEFT JOIN courses c ON c.cart_id = uc.cart_id
      WHERE uc.tracking_status = 'active'
      ORDER BY uc.id ASC
      `
    );
    return rows;
  }

  async function getUserByEmail(email) {
    const { rows } = await pool.query(
      `
      SELECT id, email
      FROM users
      WHERE email = $1
      LIMIT 1
      `,
      [email]
    );
    return rows[0] || null;
  }

  async function getOrCreateUserByEmail(email) {
    const { rows } = await pool.query(
      `
      INSERT INTO users (
        email,
        created_at,
        updated_at
      )
      VALUES ($1, NOW(), NOW())
      ON CONFLICT (email) DO UPDATE
      SET updated_at = NOW()
      RETURNING id, email
      `,
      [email]
    );
    return rows[0];
  }

  async function cleanupExpiredAuthRecords() {
    await pool.query(
      `
      DELETE FROM auth_otp_challenges
      WHERE expires_at < NOW() - INTERVAL '1 day'
      `
    );
    await pool.query(
      `
      DELETE FROM auth_sessions
      WHERE (revoked_at IS NOT NULL OR expires_at < NOW())
        AND created_at < NOW() - INTERVAL '7 days'
      `
    );
  }

  async function getLatestOtpChallengeByEmail(email) {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        email,
        otp_hash,
        expires_at,
        failed_attempts,
        consumed_at,
        created_at
      FROM auth_otp_challenges
      WHERE email = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      `,
      [email]
    );
    return rows[0] || null;
  }

  async function invalidateActiveOtpChallengesByEmail(email) {
    await pool.query(
      `
      UPDATE auth_otp_challenges
      SET consumed_at = NOW()
      WHERE email = $1 AND consumed_at IS NULL
      `,
      [email]
    );
  }

  async function createOtpChallenge({ email, otpHash, expiresAt }) {
    const { rows } = await pool.query(
      `
      INSERT INTO auth_otp_challenges (
        email,
        otp_hash,
        expires_at,
        failed_attempts,
        consumed_at,
        created_at
      )
      VALUES ($1, $2, $3, 0, NULL, NOW())
      RETURNING
        id,
        email,
        otp_hash,
        expires_at,
        failed_attempts,
        consumed_at,
        created_at
      `,
      [email, otpHash, expiresAt]
    );
    return rows[0];
  }

  async function markOtpChallengeConsumed(challengeId) {
    await pool.query(
      `
      UPDATE auth_otp_challenges
      SET consumed_at = NOW()
      WHERE id = $1 AND consumed_at IS NULL
      `,
      [challengeId]
    );
  }

  async function incrementOtpChallengeFailedAttempts(challengeId) {
    const { rows } = await pool.query(
      `
      UPDATE auth_otp_challenges
      SET failed_attempts = failed_attempts + 1
      WHERE id = $1
      RETURNING failed_attempts
      `,
      [challengeId]
    );
    return rows[0] ? rows[0].failed_attempts : null;
  }

  async function createAuthSession({ userId, tokenHash, expiresAt }) {
    const { rows } = await pool.query(
      `
      INSERT INTO auth_sessions (
        user_id,
        token_hash,
        expires_at,
        revoked_at,
        created_at
      )
      VALUES ($1, $2, $3, NULL, NOW())
      RETURNING id, user_id, token_hash, expires_at, revoked_at, created_at
      `,
      [userId, tokenHash, expiresAt]
    );
    return rows[0];
  }

  async function getAuthSessionByTokenHash(tokenHash) {
    const { rows } = await pool.query(
      `
      SELECT
        s.id,
        s.user_id,
        s.token_hash,
        s.expires_at,
        s.revoked_at,
        s.created_at,
        u.email
      FROM auth_sessions s
      INNER JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
      LIMIT 1
      `,
      [tokenHash]
    );
    return rows[0] || null;
  }

  async function revokeAuthSessionByTokenHash(tokenHash) {
    await pool.query(
      `
      UPDATE auth_sessions
      SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL
      `,
      [tokenHash]
    );
  }

  async function getTrackedCourseByUserAndCart(userId, cartId) {
    const { rows } = await pool.query(
      `
      SELECT
        uc.id AS user_course_id,
        uc.user_id,
        uc.created_at,
        u.email,
        uc.cart_id,
        uc.display_name,
        uc.tracking_status,
        uc.notified_at,
        uc.invalid_attempts,
        uc.invalid_notified_at,
        c.course_name,
        c.os
      FROM user_courses uc
      INNER JOIN users u ON u.id = uc.user_id
      LEFT JOIN courses c ON c.cart_id = uc.cart_id
      WHERE uc.user_id = $1 AND uc.cart_id = $2
      LIMIT 1
      `,
      [userId, cartId]
    );
    return rows[0] || null;
  }

  async function listTrackedCoursesByUser(userId) {
    const { rows } = await pool.query(
      `
      SELECT
        uc.id AS user_course_id,
        uc.user_id,
        uc.cart_id,
        uc.display_name,
        uc.tracking_status,
        uc.notified_at,
        uc.invalid_attempts,
        uc.invalid_notified_at,
        uc.created_at,
        c.course_name,
        c.os
      FROM user_courses uc
      LEFT JOIN courses c ON c.cart_id = uc.cart_id
      WHERE uc.user_id = $1
      ORDER BY uc.created_at DESC, uc.id DESC
      `,
      [userId]
    );
    return rows;
  }

  async function stopTrackingUserCourse(userCourseId) {
    await pool.query(
      `
      DELETE FROM user_courses
      WHERE id = $1
      `,
      [userCourseId]
    );
  }

  async function stopTrackingUserCourseForUser({ userCourseId, userId }) {
    const { rowCount } = await pool.query(
      `
      DELETE FROM user_courses
      WHERE id = $1 AND user_id = $2
      `,
      [userCourseId, userId]
    );
    return rowCount;
  }

  async function markUserCourseNotified(userCourseId) {
    const { rowCount } = await pool.query(
      `
      UPDATE user_courses
      SET
        tracking_status = 'notified',
        notified_at = NOW(),
        invalid_attempts = 0,
        invalid_notified_at = NULL
      WHERE id = $1
      `,
      [userCourseId]
    );
    return rowCount;
  }

  async function incrementUserCourseInvalidAttempts(userCourseId) {
    const { rows } = await pool.query(
      `
      UPDATE user_courses
      SET
        invalid_attempts = invalid_attempts + 1,
        updated_at = NOW()
      WHERE id = $1
      RETURNING invalid_attempts
      `,
      [userCourseId]
    );
    return rows[0] ? Number(rows[0].invalid_attempts) : null;
  }

  async function markUserCourseInvalid(userCourseId) {
    const { rowCount } = await pool.query(
      `
      UPDATE user_courses
      SET
        tracking_status = 'invalid',
        notified_at = NULL,
        updated_at = NOW()
      WHERE id = $1
      `,
      [userCourseId]
    );
    return rowCount;
  }

  async function markUserCourseInvalidNotified(userCourseId) {
    const { rowCount } = await pool.query(
      `
      UPDATE user_courses
      SET
        invalid_notified_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      `,
      [userCourseId]
    );
    return rowCount;
  }

  async function resetNotificationStateForUserCourse(userCourseId) {
    await pool.query(
      `
      UPDATE notification_attempts
      SET
        idempotency_key = idempotency_key || ':archived:' || id::text || ':' ||
          FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)::text,
        suppression_key = CASE
          WHEN suppression_key IS NULL THEN NULL
          ELSE suppression_key || ':archived:' || id::text || ':' ||
            FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)::text
        END,
        updated_at = NOW()
      WHERE user_course_id = $1
      `,
      [userCourseId]
    );
  }

  async function resumeUserCourseForUser({ userCourseId, userId }) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        `
        UPDATE user_courses
        SET
          tracking_status = 'active',
          notified_at = NULL,
          invalid_attempts = 0,
          invalid_notified_at = NULL
        WHERE id = $1 AND user_id = $2
        `,
        [userCourseId, userId]
      );
      if (!rowCount) {
        await client.query("ROLLBACK");
        return 0;
      }

      await client.query(
        `
        UPDATE notification_attempts
        SET
          idempotency_key = idempotency_key || ':archived:' || id::text || ':' ||
            FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)::text,
          suppression_key = CASE
            WHEN suppression_key IS NULL THEN NULL
            ELSE suppression_key || ':archived:' || id::text || ':' ||
              FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)::text
          END,
          updated_at = NOW()
        WHERE user_course_id = $1
        `,
        [userCourseId]
      );

      await client.query("COMMIT");
      return rowCount;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        // Ignore rollback errors and rethrow original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function upsertCourseFromJsp({ cartId, courseName, os }) {
    await pool.query(
      `
      INSERT INTO courses (
        cart_id,
        course_name,
        os,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (cart_id) DO UPDATE
      SET
        course_name = CASE
          WHEN EXCLUDED.course_name IS NULL OR TRIM(EXCLUDED.course_name) = ''
          THEN courses.course_name
          ELSE EXCLUDED.course_name
        END,
        os = EXCLUDED.os,
        updated_at = NOW()
      `,
      [cartId, courseName, os]
    );
  }

  async function ensureCourseExists(cartId, courseName = null) {
    const normalizedName =
      typeof courseName === "string" && courseName.trim()
        ? courseName.trim()
        : null;
    await pool.query(
      `
      INSERT INTO courses (
        cart_id,
        course_name,
        os,
        created_at,
        updated_at
      )
      VALUES ($1, COALESCE($2, $1), 0, NOW(), NOW())
      ON CONFLICT (cart_id) DO UPDATE
      SET
        course_name = CASE
          WHEN courses.course_name IS NULL OR TRIM(courses.course_name) = ''
          THEN COALESCE($2, courses.cart_id)
          ELSE courses.course_name
        END,
        updated_at = NOW()
      `,
      [cartId, normalizedName]
    );
  }

  async function setUserCourseDisplayName({ userId, cartId, displayName }) {
    const normalizedDisplayName =
      typeof displayName === "string" && displayName.trim()
        ? displayName.trim()
        : null;

    await pool.query(
      `
      UPDATE user_courses
      SET display_name = $3
      WHERE user_id = $1 AND cart_id = $2
      `,
      [userId, cartId, normalizedDisplayName]
    );
  }

  async function setCourseDisplayName({ cartId, courseName }) {
    const normalizedName =
      typeof courseName === "string" && courseName.trim()
        ? courseName.trim()
        : null;
    if (!normalizedName) {
      return;
    }

    await pool.query(
      `
      UPDATE courses
      SET
        course_name = $2,
        updated_at = NOW()
      WHERE cart_id = $1
      `,
      [cartId, normalizedName]
    );
  }

  async function enqueueCourseOpenNotification({
    userId,
    userCourseId,
    cartId,
    toEmail,
    courseName,
    os,
    maxAttempts = 5,
    suppressionWindowMinutes = 30
  }) {
    const normalizedCartId = normalizeCartId(cartId);
    const normalizedToEmail = normalizeEmail(toEmail);
    const safeMaxAttempts = parsePositiveInt(maxAttempts, 5);
    const safeSuppressionMinutes = Math.max(
      0,
      Number.parseInt(suppressionWindowMinutes, 10) || 0
    );
    const idempotencyKey = `course_open:${userCourseId}`;
    const suppressionKey = `course_open:${normalizedToEmail}:${normalizedCartId}`;
    const payload = {
      cartId: normalizedCartId,
      courseName:
        typeof courseName === "string" && courseName.trim()
          ? courseName.trim()
          : normalizedCartId,
      os: Number.isFinite(Number(os)) ? Number(os) : 0
    };

    const payloadJson = JSON.stringify(payload);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (safeSuppressionMinutes > 0) {
        const suppressionCutoff = new Date(
          Date.now() - safeSuppressionMinutes * 60 * 1000
        );
        const { rows: recentSentRows } = await client.query(
          `
          SELECT id, sent_at
          FROM notification_attempts
          WHERE event_type = 'course_open'
            AND suppression_key = $1
            AND status = 'sent'
            AND sent_at IS NOT NULL
            AND sent_at >= $2
          ORDER BY sent_at DESC
          LIMIT 1
          `,
          [suppressionKey, suppressionCutoff]
        );

        if (recentSentRows[0]) {
          const recentSent = recentSentRows[0];
          const suppressedUntil = new Date(
            new Date(recentSent.sent_at).getTime() + safeSuppressionMinutes * 60 * 1000
          );
          const suppressedIdempotencyKey = `${idempotencyKey}:suppressed:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`;
          const { rows: suppressedRows } = await client.query(
            `
            INSERT INTO notification_attempts (
              event_type,
              idempotency_key,
              suppression_key,
              user_id,
              user_course_id,
              cart_id,
              to_email,
              payload_json,
              status,
              attempt_count,
              max_attempts,
              next_retry_at,
              sent_at,
              suppressed_until,
              last_error,
              created_at,
              updated_at
            )
            VALUES (
              'course_open',
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7::jsonb,
              'suppressed',
              0,
              $8,
              NULL,
              NULL,
              $9,
              $10,
              NOW(),
              NOW()
            )
            RETURNING *
            `,
            [
              suppressedIdempotencyKey,
              suppressionKey,
              userId || null,
              userCourseId || null,
              normalizedCartId,
              normalizedToEmail,
              payloadJson,
              safeMaxAttempts,
              suppressedUntil,
              `suppressed by sent attempt id=${recentSent.id}`
            ]
          );

          await client.query("COMMIT");
          return {
            action: "suppressed",
            attempt: mapNotificationAttemptRow(suppressedRows[0]),
            suppressionSourceAttemptId: Number(recentSent.id)
          };
        }
      }

      const { rows: existingRows } = await client.query(
        `
        SELECT *
        FROM notification_attempts
        WHERE idempotency_key = $1
        FOR UPDATE
        LIMIT 1
        `,
        [idempotencyKey]
      );
      const existing = mapNotificationAttemptRow(existingRows[0]);
      if (existing) {
        if (existing.status === "sent") {
          await client.query("COMMIT");
          return { action: "already_sent", attempt: existing };
        }

        if (existing.status === "pending" || existing.status === "retrying") {
          await client.query("COMMIT");
          return { action: "already_queued", attempt: existing };
        }

        if (existing.status === "failed") {
          await client.query("COMMIT");
          return { action: "already_failed", attempt: existing };
        }

        if (existing.status === "suppressed") {
          await client.query("COMMIT");
          return { action: "already_suppressed", attempt: existing };
        }

        const { rows: resetRows } = await client.query(
          `
          UPDATE notification_attempts
          SET
            suppression_key = $2,
            user_id = $3,
            user_course_id = $4,
            cart_id = $5,
            to_email = $6,
            payload_json = $7::jsonb,
            status = 'pending',
            attempt_count = 0,
            max_attempts = $8,
            next_retry_at = NOW(),
            last_attempted_at = NULL,
            sent_at = NULL,
            suppressed_until = NULL,
            provider_message_id = NULL,
            last_error = NULL,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [
            existing.id,
            suppressionKey,
            userId || null,
            userCourseId || null,
            normalizedCartId,
            normalizedToEmail,
            payloadJson,
            safeMaxAttempts
          ]
        );

        await client.query("COMMIT");
        return { action: "requeued", attempt: mapNotificationAttemptRow(resetRows[0]) };
      }

      const { rows: insertedRows } = await client.query(
        `
        INSERT INTO notification_attempts (
          event_type,
          idempotency_key,
          suppression_key,
          user_id,
          user_course_id,
          cart_id,
          to_email,
          payload_json,
          status,
          attempt_count,
          max_attempts,
          next_retry_at,
          created_at,
          updated_at
        )
        VALUES (
          'course_open',
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7::jsonb,
          'pending',
          0,
          $8,
          NOW(),
          NOW(),
          NOW()
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
        `,
        [
          idempotencyKey,
          suppressionKey,
          userId || null,
          userCourseId || null,
          normalizedCartId,
          normalizedToEmail,
          payloadJson,
          safeMaxAttempts
        ]
      );

      if (insertedRows[0]) {
        await client.query("COMMIT");
        return { action: "queued", attempt: mapNotificationAttemptRow(insertedRows[0]) };
      }

      // Another worker inserted this idempotency key in parallel.
      const { rows: conflictedRows } = await client.query(
        `
        SELECT *
        FROM notification_attempts
        WHERE idempotency_key = $1
        FOR UPDATE
        LIMIT 1
        `,
        [idempotencyKey]
      );
      const conflicted = mapNotificationAttemptRow(conflictedRows[0]);
      if (!conflicted) {
        throw new Error("Failed to resolve notification idempotency conflict.");
      }
      if (conflicted.status === "sent") {
        await client.query("COMMIT");
        return { action: "already_sent", attempt: conflicted };
      }
      if (conflicted.status === "pending" || conflicted.status === "retrying") {
        await client.query("COMMIT");
        return { action: "already_queued", attempt: conflicted };
      }
      if (conflicted.status === "failed") {
        await client.query("COMMIT");
        return { action: "already_failed", attempt: conflicted };
      }
      if (conflicted.status === "suppressed") {
        await client.query("COMMIT");
        return { action: "already_suppressed", attempt: conflicted };
      }

      const { rows: resetRows } = await client.query(
        `
        UPDATE notification_attempts
        SET
          suppression_key = $2,
          user_id = $3,
          user_course_id = $4,
          cart_id = $5,
          to_email = $6,
          payload_json = $7::jsonb,
          status = 'pending',
          attempt_count = 0,
          max_attempts = $8,
          next_retry_at = NOW(),
          last_attempted_at = NULL,
          sent_at = NULL,
          suppressed_until = NULL,
          provider_message_id = NULL,
          last_error = NULL,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [
          conflicted.id,
          suppressionKey,
          userId || null,
          userCourseId || null,
          normalizedCartId,
          normalizedToEmail,
          payloadJson,
          safeMaxAttempts
        ]
      );
      await client.query("COMMIT");
      return { action: "requeued", attempt: mapNotificationAttemptRow(resetRows[0]) };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (_rollbackError) {
        // Ignore rollback errors and rethrow the original failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function claimDueNotificationAttempts({
    limit = 25,
    leaseSeconds = 300
  } = {}) {
    const safeLimit = Math.min(250, parsePositiveInt(limit, 25));
    const safeLeaseSeconds = Math.min(3600, parsePositiveInt(leaseSeconds, 300));
    const { rows } = await pool.query(
      `
      WITH due AS (
        SELECT id
        FROM notification_attempts
        WHERE
          (
            status = 'pending'
            AND (next_retry_at IS NULL OR next_retry_at <= NOW())
          )
          OR
          (
            status = 'retrying'
            AND next_retry_at IS NOT NULL
            AND next_retry_at <= NOW()
          )
        ORDER BY COALESCE(next_retry_at, created_at) ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE notification_attempts na
      SET
        status = 'retrying',
        last_attempted_at = NOW(),
        next_retry_at = NOW() + ($2 * INTERVAL '1 second'),
        updated_at = NOW()
      FROM due
      WHERE na.id = due.id
      RETURNING na.*
      `,
      [safeLimit, safeLeaseSeconds]
    );

    return rows.map((row) => mapNotificationAttemptRow(row));
  }

  async function markNotificationAttemptSent({
    attemptId,
    providerMessageId = null
  }) {
    const { rows } = await pool.query(
      `
      UPDATE notification_attempts
      SET
        status = 'sent',
        attempt_count = attempt_count + 1,
        next_retry_at = NULL,
        sent_at = NOW(),
        suppressed_until = NULL,
        provider_message_id = $2,
        last_error = NULL,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [attemptId, providerMessageId]
    );
    return mapNotificationAttemptRow(rows[0]);
  }

  async function markNotificationAttemptFailure({
    attemptId,
    errorMessage,
    nextStatus,
    nextRetryAt = null
  }) {
    if (!["retrying", "failed"].includes(nextStatus)) {
      throw new Error("nextStatus must be 'retrying' or 'failed'.");
    }

    const { rows } = await pool.query(
      `
      UPDATE notification_attempts
      SET
        status = $2,
        attempt_count = attempt_count + 1,
        next_retry_at = $3,
        last_error = $4,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [attemptId, nextStatus, nextRetryAt, errorMessage || "Unknown notification error"]
    );

    return mapNotificationAttemptRow(rows[0]);
  }

  async function getSharedLatestJspFile() {
    const { rows } = await pool.query(
      `
      SELECT
        singleton_id,
        file_name,
        jsp_body,
        source_path,
        payload_hash,
        generated_at,
        updated_at
      FROM shared_latest_jsp_file
      WHERE singleton_id = 1
      LIMIT 1
      `
    );
    return rows[0] || null;
  }

  async function saveSharedLatestJspFile({
    fileName,
    jspBody,
    sourcePath,
    payloadHash,
    generatedAt
  }) {
    await pool.query(
      `
      INSERT INTO shared_latest_jsp_file (
        singleton_id,
        file_name,
        jsp_body,
        source_path,
        payload_hash,
        generated_at,
        updated_at
      )
      VALUES (1, $1, $2, $3, $4, $5, NOW())
      ON CONFLICT (singleton_id) DO UPDATE
      SET
        file_name = EXCLUDED.file_name,
        jsp_body = EXCLUDED.jsp_body,
        source_path = EXCLUDED.source_path,
        payload_hash = EXCLUDED.payload_hash,
        generated_at = EXCLUDED.generated_at,
        updated_at = NOW()
      `,
      [
        fileName,
        jspBody,
        sourcePath || null,
        payloadHash || null,
        generatedAt || new Date()
      ]
    );
  }

  async function trackCourseForUser({ userId, cartId, displayName = null }) {
    const normalizedDisplayName =
      typeof displayName === "string" && displayName.trim()
        ? displayName.trim()
        : null;

    const { rows } = await pool.query(
      `
      INSERT INTO user_courses (
        user_id,
        cart_id,
        display_name,
        tracking_status,
        notified_at,
        invalid_attempts,
        invalid_notified_at,
        created_at
      )
      VALUES ($1, $2, $3, 'active', NULL, 0, NULL, NOW())
      ON CONFLICT (user_id, cart_id) DO NOTHING
      RETURNING id
      `,
      [userId, cartId, normalizedDisplayName]
    );

    return rows[0] || null;
  }

  return {
    close,
    ensureCompatibility,
    cleanupExpiredAuthRecords,
    getSharedSession,
    markSharedSessionExpired,
    markSharedSessionOk,
    getLatestOtpChallengeByEmail,
    invalidateActiveOtpChallengesByEmail,
    createOtpChallenge,
    markOtpChallengeConsumed,
    incrementOtpChallengeFailedAttempts,
    createAuthSession,
    getAuthSessionByTokenHash,
    revokeAuthSessionByTokenHash,
    getUserByEmail,
    getOrCreateUserByEmail,
    listTrackedCourses,
    listTrackedCoursesByUser,
    getTrackedCourseByUserAndCart,
    stopTrackingUserCourse,
    stopTrackingUserCourseForUser,
    markUserCourseNotified,
    incrementUserCourseInvalidAttempts,
    markUserCourseInvalid,
    markUserCourseInvalidNotified,
    resetNotificationStateForUserCourse,
    resumeUserCourseForUser,
    ensureCourseExists,
    setUserCourseDisplayName,
    setCourseDisplayName,
    upsertCourseFromJsp,
    enqueueCourseOpenNotification,
    claimDueNotificationAttempts,
    markNotificationAttemptSent,
    markNotificationAttemptFailure,
    getSharedLatestJspFile,
    saveSharedLatestJspFile,
    trackCourseForUser
  };
}

module.exports = {
  createDb
};
