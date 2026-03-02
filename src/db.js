const { Pool } = require("pg");

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
      ADD COLUMN IF NOT EXISTS display_name TEXT
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
        c.course_name,
        c.os
      FROM user_courses uc
      INNER JOIN users u ON u.id = uc.user_id
      LEFT JOIN courses c ON c.cart_id = uc.cart_id
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
        created_at
      )
      VALUES ($1, $2, $3, NOW())
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
    ensureCourseExists,
    setUserCourseDisplayName,
    setCourseDisplayName,
    upsertCourseFromJsp,
    getSharedLatestJspFile,
    saveSharedLatestJspFile,
    trackCourseForUser
  };
}

module.exports = {
  createDb
};
