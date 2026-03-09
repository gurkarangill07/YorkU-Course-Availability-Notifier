const test = require("node:test");
const assert = require("node:assert/strict");
const { monitorOnce } = require("../src/monitorService");

function makeAttempt(overrides = {}) {
  return {
    id: 123,
    eventType: "course_open",
    idempotencyKey: "course_open:123",
    suppressionKey: "course_open:test@example.com:TST123",
    userId: 1,
    userCourseId: 99,
    cartId: "TST123",
    toEmail: "test@example.com",
    payload: { courseName: "Test Course", os: 2 },
    status: "pending",
    attemptCount: 0,
    maxAttempts: 5,
    nextRetryAt: null,
    lastAttemptedAt: null,
    sentAt: null,
    suppressedUntil: null,
    providerMessageId: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

async function runDispatchCase({ notifierSendImpl }) {
  const state = {
    claimArgs: null,
    sentArgs: null,
    failureArgs: null,
    stoppedIds: []
  };

  const db = {
    getSharedSession: async () => ({ session_state: "expired", session_expires_at: null }),
    markSharedSessionExpired: async () => ({ wasAlreadyExpired: true }),
    claimDueNotificationAttempts: async (args) => {
      state.claimArgs = args;
      return [makeAttempt()];
    },
    markNotificationAttemptSent: async (args) => {
      state.sentArgs = args;
      return makeAttempt({ status: "sent", providerMessageId: args.providerMessageId || null });
    },
    markNotificationAttemptFailure: async (args) => {
      state.failureArgs = args;
      return makeAttempt({ status: args.nextStatus, lastError: args.errorMessage, nextRetryAt: args.nextRetryAt });
    },
    stopTrackingUserCourse: async (id) => {
      state.stoppedIds.push(id);
    },
    listTrackedCourses: async () => []
  };

  const notifier = {
    sendCourseOpenEmail: notifierSendImpl,
    sendSessionExpiredEmail: async () => {}
  };

  const summary = await monitorOnce({
    db,
    vsbSource: {},
    notifier,
    ownerAlertEmail: null,
    notificationPolicy: {
      retryBaseSeconds: 30,
      retryMaxSeconds: 900,
      maxAttempts: 5,
      suppressionWindowMinutes: 30,
      dispatchBatchSize: 25,
      dispatchLeaseSeconds: 222
    }
  });

  assert.equal(state.claimArgs.leaseSeconds, 222);
  assert.equal(summary.dispatchClaimed, 1);

  return { state, summary };
}

async function runOpenCourseQueueActionCase(queueAction) {
  const state = {
    enqueueArgs: null,
    stoppedIds: [],
    claimArgs: null
  };
  const nowIso = new Date().toISOString();

  const db = {
    getSharedSession: async () => ({
      session_state: "ok",
      session_expires_at: new Date(Date.now() + 60 * 1000).toISOString()
    }),
    getSharedLatestJspFile: async () => null,
    saveSharedLatestJspFile: async () => {},
    upsertCourseFromJsp: async () => {},
    enqueueCourseOpenNotification: async (args) => {
      state.enqueueArgs = args;
      return {
        action: queueAction,
        attempt: makeAttempt({ status: queueAction === "already_failed" ? "failed" : "suppressed" })
      };
    },
    stopTrackingUserCourse: async (id) => {
      state.stoppedIds.push(id);
    },
    listTrackedCourses: async () => [
      {
        user_course_id: 77,
        user_id: 42,
        cart_id: "ABC123",
        email: "test@example.com",
        created_at: nowIso
      }
    ],
    claimDueNotificationAttempts: async (args) => {
      state.claimArgs = args;
      return [];
    },
    markNotificationAttemptSent: async () => {
      throw new Error("markNotificationAttemptSent should not be called");
    },
    markNotificationAttemptFailure: async () => {
      throw new Error("markNotificationAttemptFailure should not be called");
    },
    markSharedSessionExpired: async () => ({ wasAlreadyExpired: false })
  };

  const vsbSource = {
    collectGetClassDataCandidates: async () => [
      {
        fileName: "getClassData.jsp",
        jspBody: JSON.stringify([{ cartid: "ABC123", os: 2, code: "EECS 1001" }]),
        sourcePath: null,
        payloadHash: "hash-1",
        generatedAt: nowIso
      }
    ],
    pickLatestJspFile: (candidates) => candidates[0]
  };

  const notifier = {
    sendCourseOpenEmail: async () => ({ messageId: "provider-mid" }),
    sendSessionExpiredEmail: async () => {}
  };

  const summary = await monitorOnce({
    db,
    vsbSource,
    notifier,
    ownerAlertEmail: null,
    notificationPolicy: {
      retryBaseSeconds: 30,
      retryMaxSeconds: 900,
      maxAttempts: 5,
      suppressionWindowMinutes: 30,
      dispatchBatchSize: 25,
      dispatchLeaseSeconds: 222
    }
  });

  return { state, summary };
}

test("monitor dispatch marks sent + stores provider message id", async () => {
  const { state, summary } = await runDispatchCase({
    notifierSendImpl: async () => ({ messageId: "provider-mid-1" })
  });

  assert.ok(state.sentArgs);
  assert.equal(state.sentArgs.providerMessageId, "provider-mid-1");
  assert.equal(state.failureArgs, null);
  assert.deepEqual(state.stoppedIds, [99]);
  assert.equal(summary.notified, 1);
  assert.equal(summary.stopped, 1);
  assert.equal(summary.retried, 0);
  assert.equal(summary.failures, 0);
});

test("monitor dispatch retries transient notification failures", async () => {
  const { state, summary } = await runDispatchCase({
    notifierSendImpl: async () => {
      const err = new Error("temporary smtp outage");
      err.code = "ETIMEDOUT";
      err.responseCode = 421;
      throw err;
    }
  });

  assert.equal(state.sentArgs, null);
  assert.ok(state.failureArgs);
  assert.equal(state.failureArgs.nextStatus, "retrying");
  assert.ok(state.failureArgs.nextRetryAt instanceof Date);
  assert.match(state.failureArgs.errorMessage, /code=ETIMEDOUT/);
  assert.match(state.failureArgs.errorMessage, /smtp=421/);
  assert.deepEqual(state.stoppedIds, []);
  assert.equal(summary.notified, 0);
  assert.equal(summary.retried, 1);
  assert.equal(summary.failures, 0);
});

test("monitor dispatch does not retry permanent auth failures", async () => {
  const { state, summary } = await runDispatchCase({
    notifierSendImpl: async () => {
      const err = new Error("authentication rejected");
      err.code = "EAUTH";
      err.responseCode = 535;
      throw err;
    }
  });

  assert.equal(state.sentArgs, null);
  assert.ok(state.failureArgs);
  assert.equal(state.failureArgs.nextStatus, "failed");
  assert.equal(state.failureArgs.nextRetryAt, null);
  assert.match(state.failureArgs.errorMessage, /smtp=535/);
  assert.deepEqual(state.stoppedIds, []);
  assert.equal(summary.notified, 0);
  assert.equal(summary.retried, 0);
  assert.equal(summary.failures, 1);
});

test("monitor treats already_suppressed queue action as suppressed + stops tracking", async () => {
  const { state, summary } = await runOpenCourseQueueActionCase("already_suppressed");

  assert.equal(state.enqueueArgs.userCourseId, 77);
  assert.deepEqual(state.stoppedIds, [77]);
  assert.equal(state.claimArgs.leaseSeconds, 222);
  assert.equal(summary.scanned, 1);
  assert.equal(summary.queued, 0);
  assert.equal(summary.suppressed, 1);
  assert.equal(summary.stopped, 1);
  assert.equal(summary.failures, 0);
  assert.equal(summary.dispatchClaimed, 0);
});

test("monitor treats already_failed queue action as terminal + stops tracking", async () => {
  const { state, summary } = await runOpenCourseQueueActionCase("already_failed");

  assert.equal(state.enqueueArgs.userCourseId, 77);
  assert.deepEqual(state.stoppedIds, [77]);
  assert.equal(state.claimArgs.leaseSeconds, 222);
  assert.equal(summary.scanned, 1);
  assert.equal(summary.queued, 0);
  assert.equal(summary.suppressed, 0);
  assert.equal(summary.stopped, 1);
  assert.equal(summary.failures, 1);
  assert.equal(summary.dispatchClaimed, 0);
});
