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

test(
  "resume + re-track clears suppression history so a fresh notify can queue",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const db = createDb({ databaseUrl: process.env.DATABASE_URL });
    await db.ensureCompatibility();
    const cleanupPool = new Pool({ connectionString: process.env.DATABASE_URL });

    const suffix = randomSuffix();
    const email = `notif-resume-${suffix}@example.com`;
    const cartId = `NR${suffix.slice(-6)}`.toUpperCase();

    try {
      const user = await db.getOrCreateUserByEmail(email);
      await db.ensureCourseExists(cartId);

      // First tracking cycle: send one notification, then remove tracking.
      await db.trackCourseForUser({
        userId: user.id,
        cartId,
        displayName: "Resume Regression Course"
      });
      const firstTracked = await db.getTrackedCourseByUserAndCart(user.id, cartId);
      assert.ok(firstTracked);

      const firstQueued = await db.enqueueCourseOpenNotification({
        userId: user.id,
        userCourseId: firstTracked.user_course_id,
        cartId,
        toEmail: email,
        courseName: "Resume Regression Course",
        os: 1,
        maxAttempts: 3,
        suppressionWindowMinutes: 30
      });
      assert.equal(firstQueued.action, "queued");
      await db.markNotificationAttemptSent({
        attemptId: firstQueued.attempt.id,
        providerMessageId: "provider-first"
      });
      await db.stopTrackingUserCourseForUser({
        userCourseId: firstTracked.user_course_id,
        userId: user.id
      });

      // Second tracking cycle: notify once, mark notified, then resume.
      await db.trackCourseForUser({
        userId: user.id,
        cartId,
        displayName: "Resume Regression Course"
      });
      const secondTracked = await db.getTrackedCourseByUserAndCart(user.id, cartId);
      assert.ok(secondTracked);
      assert.notEqual(secondTracked.user_course_id, firstTracked.user_course_id);

      const secondQueued = await db.enqueueCourseOpenNotification({
        userId: user.id,
        userCourseId: secondTracked.user_course_id,
        cartId,
        toEmail: email,
        courseName: "Resume Regression Course",
        os: 1,
        maxAttempts: 3,
        suppressionWindowMinutes: 30
      });
      assert.equal(secondQueued.action, "queued");
      await db.markNotificationAttemptSent({
        attemptId: secondQueued.attempt.id,
        providerMessageId: "provider-second"
      });
      await db.markUserCourseNotified(secondTracked.user_course_id);

      const resumedRows = await db.resumeUserCourseForUser({
        userCourseId: secondTracked.user_course_id,
        userId: user.id
      });
      assert.equal(resumedRows, 1);

      // After resume, stale suppression/idempotency history should not block a new queue entry.
      const afterResume = await db.enqueueCourseOpenNotification({
        userId: user.id,
        userCourseId: secondTracked.user_course_id,
        cartId,
        toEmail: email,
        courseName: "Resume Regression Course",
        os: 1,
        maxAttempts: 3,
        suppressionWindowMinutes: 30
      });

      assert.equal(afterResume.action, "queued");
      assert.equal(afterResume.attempt.status, "pending");
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
