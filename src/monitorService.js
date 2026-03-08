const { parseCourseFromJsp } = require("./jspParser");

const DEFAULT_NOTIFICATION_POLICY = {
  retryBaseSeconds: 30,
  retryMaxSeconds: 900,
  maxAttempts: 5,
  suppressionWindowMinutes: 30,
  dispatchBatchSize: 25
};

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeNotificationPolicy(policy) {
  const retryBaseSeconds = parsePositiveInt(
    policy && policy.retryBaseSeconds,
    DEFAULT_NOTIFICATION_POLICY.retryBaseSeconds
  );
  const retryMaxSeconds = Math.max(
    retryBaseSeconds,
    parsePositiveInt(
      policy && policy.retryMaxSeconds,
      DEFAULT_NOTIFICATION_POLICY.retryMaxSeconds
    )
  );
  const maxAttempts = parsePositiveInt(
    policy && policy.maxAttempts,
    DEFAULT_NOTIFICATION_POLICY.maxAttempts
  );
  const parsedSuppressionWindow = Number.parseInt(
    policy && policy.suppressionWindowMinutes,
    10
  );
  const suppressionWindowMinutes = Math.max(
    0,
    Number.isNaN(parsedSuppressionWindow)
      ? DEFAULT_NOTIFICATION_POLICY.suppressionWindowMinutes
      : parsedSuppressionWindow
  );
  const dispatchBatchSize = parsePositiveInt(
    policy && policy.dispatchBatchSize,
    DEFAULT_NOTIFICATION_POLICY.dispatchBatchSize
  );

  return {
    retryBaseSeconds,
    retryMaxSeconds,
    maxAttempts,
    suppressionWindowMinutes,
    dispatchBatchSize
  };
}

function isSessionFailure(error) {
  const message = (error && error.message ? error.message : "").toLowerCase();
  return (
    message.includes("session") ||
    message.includes("login") ||
    message.includes("auth") ||
    message.includes("unauthorized")
  );
}

function isTransientNotificationError(error) {
  const message = (error && error.message ? error.message : "").toLowerCase();
  const transientPatterns = [
    "timeout",
    "timed out",
    "network",
    "econnreset",
    "econnrefused",
    "ehostunreach",
    "enotfound",
    "etimedout",
    "eai_again",
    "socket hang up",
    "too many requests",
    "rate limit",
    "temporar",
    "5xx",
    "502",
    "503",
    "504"
  ];
  return transientPatterns.some((pattern) => message.includes(pattern));
}

function computeRetryDelayMs({
  attemptCount,
  retryBaseSeconds,
  retryMaxSeconds
}) {
  const exponent = Math.max(0, attemptCount - 1);
  const rawSeconds = retryBaseSeconds * (2 ** exponent);
  const boundedSeconds = Math.min(rawSeconds, retryMaxSeconds);
  return boundedSeconds * 1000;
}

async function notifySessionFailureIfNeeded({
  db,
  notifier,
  ownerAlertEmail,
  reason
}) {
  const { wasAlreadyExpired } = await db.markSharedSessionExpired(reason);
  if (wasAlreadyExpired) {
    return;
  }
  if (!ownerAlertEmail) {
    return;
  }
  await notifier.sendSessionExpiredEmail({
    toEmail: ownerAlertEmail,
    reason
  });
}

async function dispatchDueNotificationAttempts({
  db,
  notifier,
  notificationPolicy
}) {
  const attempts = await db.claimDueNotificationAttempts({
    limit: notificationPolicy.dispatchBatchSize
  });

  const summary = {
    claimed: attempts.length,
    sent: 0,
    stopped: 0,
    retried: 0,
    failed: 0
  };

  for (const attempt of attempts) {
    const payload = attempt.payload || {};
    const courseName =
      typeof payload.courseName === "string" && payload.courseName.trim()
        ? payload.courseName.trim()
        : attempt.cartId;
    const os = Number.isFinite(Number(payload.os)) ? Number(payload.os) : 0;

    try {
      await notifier.sendCourseOpenEmail({
        toEmail: attempt.toEmail,
        cartId: attempt.cartId,
        courseName,
        os
      });
      await db.markNotificationAttemptSent({ attemptId: attempt.id });
      summary.sent += 1;
    } catch (error) {
      const transient = isTransientNotificationError(error);
      const nextAttemptCount = attempt.attemptCount + 1;
      const canRetry =
        transient && nextAttemptCount < attempt.maxAttempts;
      let nextStatus = "failed";
      let nextRetryAt = null;

      if (canRetry) {
        nextStatus = "retrying";
        const retryDelayMs = computeRetryDelayMs({
          attemptCount: nextAttemptCount,
          retryBaseSeconds: notificationPolicy.retryBaseSeconds,
          retryMaxSeconds: notificationPolicy.retryMaxSeconds
        });
        nextRetryAt = new Date(Date.now() + retryDelayMs);
      }

      await db.markNotificationAttemptFailure({
        attemptId: attempt.id,
        errorMessage: error.message,
        nextStatus,
        nextRetryAt
      });

      if (canRetry) {
        summary.retried += 1;
      } else {
        summary.failed += 1;
      }

      console.error(
        `[monitor] notification attempt id=${attempt.id} ${canRetry ? "retrying" : "failed"}: ${error.message}`
      );
      continue;
    }

    if (attempt.userCourseId) {
      try {
        await db.stopTrackingUserCourse(attempt.userCourseId);
        summary.stopped += 1;
      } catch (stopError) {
        summary.failed += 1;
        console.error(
          `[monitor] sent notification attempt id=${attempt.id} but failed to stop tracking user_course_id=${attempt.userCourseId}: ${stopError.message}`
        );
      }
    }
  }

  return summary;
}

async function processTrackedCourse({
  target,
  db,
  vsbSource,
  notificationPolicy,
  forceRefresh = false
}) {
  function toTimestamp(input) {
    if (!input) {
      return 0;
    }
    const ts = new Date(input).getTime();
    return Number.isFinite(ts) ? ts : 0;
  }

  let shouldForceRefresh = forceRefresh;
  if (!shouldForceRefresh) {
    const latestStored = await db.getSharedLatestJspFile();
    const trackedCreatedAtTs = toTimestamp(target.created_at);
    const latestGeneratedTs = toTimestamp(
      latestStored && (latestStored.generated_at || latestStored.updated_at)
    );

    // New tracked course added after last JSP capture: force one live browser refresh now.
    if (trackedCreatedAtTs > 0 && trackedCreatedAtTs > latestGeneratedTs) {
      shouldForceRefresh = true;
    }
  }

  async function loadLatestFile({ refreshNow }) {
    const candidates = await vsbSource.collectGetClassDataCandidates({
      cartId: target.cart_id,
      forceRefresh: refreshNow
    });
    const latestFile = vsbSource.pickLatestJspFile(candidates);
    if (!latestFile) {
      throw new Error("No getClassData.jsp file available.");
    }
    await db.saveSharedLatestJspFile(latestFile);
    return latestFile;
  }

  let latestFile = await loadLatestFile({ refreshNow: shouldForceRefresh });
  let parsed;
  try {
    parsed = parseCourseFromJsp(latestFile.jspBody, target.cart_id);
  } catch (error) {
    if (shouldForceRefresh) {
      throw error;
    }
    latestFile = await loadLatestFile({ refreshNow: true });
    parsed = parseCourseFromJsp(latestFile.jspBody, target.cart_id);
  }

  await db.upsertCourseFromJsp({
    cartId: target.cart_id,
    courseName: parsed.courseName,
    os: parsed.os
  });

  if (parsed.os > 0) {
    const enqueueResult = await db.enqueueCourseOpenNotification({
      userId: target.user_id,
      userCourseId: target.user_course_id,
      cartId: target.cart_id,
      toEmail: target.email,
      courseName: parsed.courseName,
      os: parsed.os,
      maxAttempts: notificationPolicy.maxAttempts,
      suppressionWindowMinutes: notificationPolicy.suppressionWindowMinutes
    });

    if (
      enqueueResult.action === "suppressed" ||
      enqueueResult.action === "already_sent"
    ) {
      await db.stopTrackingUserCourse(target.user_course_id);
      return {
        status: "suppressed_and_stopped",
        queueAction: enqueueResult.action,
        os: parsed.os
      };
    }

    return {
      status: "open_enqueued",
      queueAction: enqueueResult.action,
      os: parsed.os
    };
  }

  return { status: "still_closed", os: parsed.os };
}

async function monitorOnce({
  db,
  vsbSource,
  notifier,
  ownerAlertEmail,
  notificationPolicy
}) {
  const policy = normalizeNotificationPolicy(notificationPolicy);
  const summary = {
    scanned: 0,
    queued: 0,
    notified: 0,
    suppressed: 0,
    stopped: 0,
    retried: 0,
    dispatchClaimed: 0,
    failures: 0
  };

  function applyDispatchSummary(dispatchSummary) {
    summary.dispatchClaimed += dispatchSummary.claimed;
    summary.notified += dispatchSummary.sent;
    summary.stopped += dispatchSummary.stopped;
    summary.retried += dispatchSummary.retried;
    summary.failures += dispatchSummary.failed;
  }

  const session = await db.getSharedSession();
  const isClockExpired =
    session &&
    session.session_expires_at &&
    new Date(session.session_expires_at).getTime() <= Date.now();

  let recoveredByAutoRelogin = false;
  if (!session || session.session_state !== "ok" || isClockExpired) {
    if (typeof vsbSource.tryAutoRelogin === "function") {
      try {
        const relogin = await vsbSource.tryAutoRelogin({
          reason: isClockExpired
            ? "session_clock_expired"
            : "session_state_not_ok"
        });
        if (relogin && relogin.ok) {
          recoveredByAutoRelogin = true;
          console.log("[monitor] Auto re-login restored session.");
        } else if (relogin && relogin.reason) {
          console.log(`[monitor] Auto re-login skipped/failed: ${relogin.reason}`);
        }
      } catch (error) {
        console.log(`[monitor] Auto re-login error: ${error.message}`);
      }
    }

    if (!recoveredByAutoRelogin) {
      await notifySessionFailureIfNeeded({
        db,
        notifier,
        ownerAlertEmail,
        reason: isClockExpired
          ? "Shared VSB session timed out by expiry timestamp."
          : "Shared VSB session is not active."
      });

      try {
        const dispatchSummary = await dispatchDueNotificationAttempts({
          db,
          notifier,
          notificationPolicy: policy
        });
        applyDispatchSummary(dispatchSummary);
      } catch (dispatchError) {
        summary.failures += 1;
        console.error(`[monitor] notification dispatch failed: ${dispatchError.message}`);
      }
      return summary;
    }
  }

  const trackedCourses = await db.listTrackedCourses();
  for (const target of trackedCourses) {
    summary.scanned += 1;
    try {
      const result = await processTrackedCourse({
        target,
        db,
        vsbSource,
        notificationPolicy: policy,
        forceRefresh: false
      });
      if (result.status === "open_enqueued") {
        if (result.queueAction === "queued" || result.queueAction === "requeued") {
          summary.queued += 1;
        }
      } else if (result.status === "suppressed_and_stopped") {
        summary.suppressed += 1;
        summary.stopped += 1;
      }
    } catch (error) {
      summary.failures += 1;
      if (isSessionFailure(error)) {
        if (typeof vsbSource.tryAutoRelogin === "function") {
          try {
            const relogin = await vsbSource.tryAutoRelogin({
              reason: "mid_scan_session_failure"
            });
            if (relogin && relogin.ok) {
              console.log("[monitor] Auto re-login succeeded after mid-scan session failure.");
              const retryResult = await processTrackedCourse({
                target,
                db,
                vsbSource,
                notificationPolicy: policy,
                forceRefresh: true
              });
              if (retryResult.status === "open_enqueued") {
                if (
                  retryResult.queueAction === "queued" ||
                  retryResult.queueAction === "requeued"
                ) {
                  summary.queued += 1;
                }
              } else if (retryResult.status === "suppressed_and_stopped") {
                summary.suppressed += 1;
                summary.stopped += 1;
              }
              continue;
            }
          } catch (reloginError) {
            console.log(`[monitor] Auto re-login after mid-scan failure errored: ${reloginError.message}`);
          }
        }

        await notifySessionFailureIfNeeded({
          db,
          notifier,
          ownerAlertEmail,
          reason: error.message
        });
        break;
      }
      console.error(
        `[monitor] failed for user_course_id=${target.user_course_id} cart_id=${target.cart_id}: ${error.message}`
      );
    }
  }

  try {
    const dispatchSummary = await dispatchDueNotificationAttempts({
      db,
      notifier,
      notificationPolicy: policy
    });
    applyDispatchSummary(dispatchSummary);
  } catch (dispatchError) {
    summary.failures += 1;
    console.error(`[monitor] notification dispatch failed: ${dispatchError.message}`);
  }

  return summary;
}

async function runImmediateCheckForNewCourse({
  db,
  vsbSource,
  notifier,
  ownerAlertEmail,
  userId,
  cartId,
  notificationPolicy
}) {
  const policy = normalizeNotificationPolicy(notificationPolicy);
  const target = await db.getTrackedCourseByUserAndCart(userId, cartId);
  if (!target) {
    return { status: "not_tracking" };
  }

  try {
    const result = await processTrackedCourse({
      target,
      db,
      vsbSource,
      notificationPolicy: policy,
      forceRefresh: true
    });
    if (result.status !== "open_enqueued") {
      return result;
    }

    const dispatchSummary = await dispatchDueNotificationAttempts({
      db,
      notifier,
      notificationPolicy: {
        ...policy,
        dispatchBatchSize: Math.max(policy.dispatchBatchSize, 1)
      }
    });

    return {
      ...result,
      dispatch: dispatchSummary,
      deliveredNow: dispatchSummary.sent > 0
    };
  } catch (error) {
    if (isSessionFailure(error)) {
      if (typeof vsbSource.tryAutoRelogin === "function") {
        try {
          const relogin = await vsbSource.tryAutoRelogin({
            reason: "immediate_check_session_failure"
          });
          if (relogin && relogin.ok) {
            const retryResult = await processTrackedCourse({
              target,
              db,
              vsbSource,
              notificationPolicy: policy,
              forceRefresh: true
            });
            if (retryResult.status !== "open_enqueued") {
              return retryResult;
            }
            const dispatchSummary = await dispatchDueNotificationAttempts({
              db,
              notifier,
              notificationPolicy: {
                ...policy,
                dispatchBatchSize: Math.max(policy.dispatchBatchSize, 1)
              }
            });
            return {
              ...retryResult,
              dispatch: dispatchSummary,
              deliveredNow: dispatchSummary.sent > 0
            };
          }
        } catch (reloginError) {
          console.log(`[monitor] Auto re-login during immediate check failed: ${reloginError.message}`);
        }
      }

      await notifySessionFailureIfNeeded({
        db,
        notifier,
        ownerAlertEmail,
        reason: error.message
      });
      return { status: "session_failed" };
    }
    throw error;
  }
}

module.exports = {
  monitorOnce,
  runImmediateCheckForNewCourse
};
