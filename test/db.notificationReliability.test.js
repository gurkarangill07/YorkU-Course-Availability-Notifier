const test = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const { createDb } = require("../src/db");

function randomSuffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

test(
  "enqueueCourseOpenNotification does not requeue failed attempts",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const db = createDb({ databaseUrl: process.env.DATABASE_URL });
    await db.ensureCompatibility();
    const cleanupPool = new Pool({ connectionString: process.env.DATABASE_URL });

    const suffix = randomSuffix();
    const email = `notif-failed-${suffix}@example.com`;
    const cartId = `NF${suffix.slice(-6)}`.toUpperCase();

    try {
      const user = await db.getOrCreateUserByEmail(email);
      await db.ensureCourseExists(cartId);
      await db.trackCourseForUser({
        userId: user.id,
        cartId,
        displayName: "Failure Regression Course"
      });
      const tracked = await db.getTrackedCourseByUserAndCart(user.id, cartId);

      const first = await db.enqueueCourseOpenNotification({
        userId: user.id,
        userCourseId: tracked.user_course_id,
        cartId,
        toEmail: email,
        courseName: "Failure Regression Course",
        os: 1,
        maxAttempts: 3,
        suppressionWindowMinutes: 0
      });
      assert.equal(first.action, "queued");
      assert.equal(first.attempt.status, "pending");

      const failed = await db.markNotificationAttemptFailure({
        attemptId: first.attempt.id,
        errorMessage: "permanent smtp error",
        nextStatus: "failed",
        nextRetryAt: null
      });
      assert.equal(failed.status, "failed");
      assert.equal(failed.attemptCount, 1);

      const second = await db.enqueueCourseOpenNotification({
        userId: user.id,
        userCourseId: tracked.user_course_id,
        cartId,
        toEmail: email,
        courseName: "Failure Regression Course",
        os: 1,
        maxAttempts: 3,
        suppressionWindowMinutes: 0
      });

      assert.equal(second.action, "already_failed");
      assert.equal(second.attempt.id, first.attempt.id);
      assert.equal(second.attempt.status, "failed");
      assert.equal(second.attempt.attemptCount, 1);
    } finally {
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
    }
  }
);
