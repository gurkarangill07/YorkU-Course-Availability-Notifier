const { parseCourseFromJsp } = require("./jspParser");
const { createLogger } = require("./logger");
const { metrics } = require("./metrics");

const DEFAULT_NOTIFICATION_POLICY = {
  retryBaseSeconds: 30,
  retryMaxSeconds: 900,
  maxAttempts: 5,
  suppressionWindowMinutes: 30,
  dispatchBatchSize: 25,
  dispatchLeaseSeconds: 300
};
const monitorLogger = createLogger({ component: "monitor" });
const INVALID_CODE_MAX_ATTEMPTS = parsePositiveInt(
  process.env.INVALID_CODE_MAX_ATTEMPTS,
  2
);

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
  const dispatchLeaseSeconds = parsePositiveInt(
    policy && policy.dispatchLeaseSeconds,
    DEFAULT_NOTIFICATION_POLICY.dispatchLeaseSeconds
  );

  return {
    retryBaseSeconds,
    retryMaxSeconds,
    maxAttempts,
    suppressionWindowMinutes,
    dispatchBatchSize,
    dispatchLeaseSeconds
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

function isPermanentNotificationError(error) {
  const code = String((error && error.code) || "")
    .trim()
    .toUpperCase();
  if (["EAUTH", "EENVELOPE", "EADDRESS"].includes(code)) {
    return true;
  }

  const smtpCode = Number.parseInt(error && error.responseCode, 10);
  if (
    Number.isFinite(smtpCode) &&
    [500, 501, 502, 503, 504, 530, 535, 550, 551, 552, 553, 554].includes(
      smtpCode
    )
  ) {
    return true;
  }

  const message = (error && error.message ? error.message : "").toLowerCase();
  const permanentPatterns = [
    "invalid login",
    "invalid credentials",
    "authentication failed",
    "bad credentials",
    "mailbox unavailable",
    "recipient address rejected",
    "user unknown"
  ];
  return permanentPatterns.some((pattern) => message.includes(pattern));
}

function isTransientNotificationError(error) {
  if (isPermanentNotificationError(error)) {
    return false;
  }

  const code = String((error && error.code) || "")
    .trim()
    .toUpperCase();
  if (
    [
      "ETIMEDOUT",
      "ECONNECTION",
      "ECONNRESET",
      "ECONNREFUSED",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ESOCKET",
      "EPIPE"
    ].includes(code)
  ) {
    return true;
  }

  const smtpCode = Number.parseInt(error && error.responseCode, 10);
  if (Number.isFinite(smtpCode)) {
    if ([421, 429, 450, 451, 452, 454].includes(smtpCode)) {
      return true;
    }
    if (smtpCode >= 500) {
      return false;
    }
  }

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

function formatNotificationError(error) {
  const message =
    (error && error.message && String(error.message).trim()) ||
    "Unknown notification error";
  const code =
    error && error.code ? String(error.code).trim().toUpperCase() : null;
  const smtpCode = Number.parseInt(error && error.responseCode, 10);
  const details = [];
  if (code) {
    details.push(`code=${code}`);
  }
  if (Number.isFinite(smtpCode)) {
    details.push(`smtp=${smtpCode}`);
  }
  if (!details.length) {
    return message;
  }
  return `${message} (${details.join(", ")})`;
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

function isInvalidCourseError(error) {
  const message = (error && error.message ? error.message : "").toLowerCase();
  return message.includes("could not locate cartid");
}

async function notifySessionFailureIfNeeded({
  db,
  notifier,
  ownerAlertEmail,
  reason
}) {
  metrics.increment(
    "worker_session_failures_total",
    1,
    "Total monitor session failure events detected."
  );
  const { wasAlreadyExpired } = await db.markSharedSessionExpired(reason);
  if (wasAlreadyExpired) {
    metrics.increment(
      "worker_session_failure_duplicate_total",
      1,
      "Session failure events suppressed because session was already marked expired."
    );
    return;
  }
  if (!ownerAlertEmail) {
    metrics.increment(
      "worker_session_failure_owner_alert_skipped_total",
      1,
      "Session failure owner alerts skipped because owner email is not configured."
    );
    return;
  }
  await notifier.sendSessionExpiredEmail({
    toEmail: ownerAlertEmail,
    reason
  });
  metrics.increment(
    "worker_session_failure_owner_alert_sent_total",
    1,
    "Session failure owner alerts sent."
  );
}

async function dispatchDueNotificationAttempts({
  db,
  notifier,
  notificationPolicy
}) {
  const attempts = await db.claimDueNotificationAttempts({
    limit: notificationPolicy.dispatchBatchSize,
    leaseSeconds: notificationPolicy.dispatchLeaseSeconds
  });
  metrics.increment(
    "worker_dispatch_claimed_total",
    attempts.length,
    "Notification attempts claimed for dispatch."
  );

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
      const sendResult = await notifier.sendCourseOpenEmail({
        toEmail: attempt.toEmail,
        cartId: attempt.cartId,
        courseName,
        os
      });
      await db.markNotificationAttemptSent({
        attemptId: attempt.id,
        providerMessageId:
          sendResult && sendResult.messageId ? String(sendResult.messageId) : null
      });
      summary.sent += 1;
      metrics.increment(
        "worker_dispatch_sent_total",
        1,
        "Notification attempts marked sent."
      );
    } catch (error) {
      const transient = isTransientNotificationError(error);
      const nextAttemptCount = attempt.attemptCount + 1;
      const canRetry =
        transient && nextAttemptCount < attempt.maxAttempts;
      let nextStatus = "failed";
      let nextRetryAt = null;
      const formattedError = formatNotificationError(error);

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
        errorMessage: formattedError,
        nextStatus,
        nextRetryAt
      });

      if (canRetry) {
        summary.retried += 1;
        metrics.increment(
          "worker_dispatch_retried_total",
          1,
          "Notification attempts scheduled for retry."
        );
      } else {
        summary.failed += 1;
        metrics.increment(
          "worker_dispatch_failed_total",
          1,
          "Notification attempts marked permanently failed."
        );
      }

      monitorLogger.error("notification attempt dispatch failed", {
        event: "monitor.dispatch.failure",
        attemptId: attempt.id,
        nextStatus,
        canRetry,
        errorMessage: formattedError
      });
      continue;
    }

    if (attempt.userCourseId) {
      try {
        await db.markUserCourseNotified(attempt.userCourseId);
        summary.stopped += 1;
        metrics.increment(
          "worker_dispatch_stopped_tracking_total",
          1,
          "Tracked courses stopped after successful notification dispatch."
        );
      } catch (stopError) {
        summary.failed += 1;
        metrics.increment(
          "worker_dispatch_stop_tracking_failures_total",
          1,
          "Failures while stopping tracked courses after successful notification send."
        );
        monitorLogger.error("notification sent but stop-tracking failed", {
          event: "monitor.dispatch.stop_tracking_failure",
          attemptId: attempt.id,
          userCourseId: attempt.userCourseId,
          error: stopError
        });
      }
    }
  }

  return summary;
}

async function processTrackedCourse({
  target,
  db,
  vsbSource,
  notifier,
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
      if (isInvalidCourseError(error)) {
        const attempts = await db.incrementUserCourseInvalidAttempts(
          target.user_course_id
        );
        if (attempts !== null && attempts >= INVALID_CODE_MAX_ATTEMPTS) {
          await notifier.sendInvalidCourseEmail({
            toEmail: target.email,
            cartId: target.cart_id,
            courseName: target.display_name || target.course_name || target.cart_id
          });
          await db.stopTrackingUserCourse(target.user_course_id);
          return {
            status: "invalid_and_stopped",
            queueAction: "invalid",
            os: 0
          };
        }
      }
      throw error;
    }
    latestFile = await loadLatestFile({ refreshNow: true });
    try {
      parsed = parseCourseFromJsp(latestFile.jspBody, target.cart_id);
    } catch (retryError) {
      if (isInvalidCourseError(retryError)) {
        const attempts = await db.incrementUserCourseInvalidAttempts(
          target.user_course_id
        );
        if (attempts !== null && attempts >= INVALID_CODE_MAX_ATTEMPTS) {
          await notifier.sendInvalidCourseEmail({
            toEmail: target.email,
            cartId: target.cart_id,
            courseName: target.display_name || target.course_name || target.cart_id
          });
          await db.stopTrackingUserCourse(target.user_course_id);
          return {
            status: "invalid_and_stopped",
            queueAction: "invalid",
            os: 0
          };
        }
      }
      throw retryError;
    }
  }

  await db.upsertCourseFromJsp({
    cartId: target.cart_id,
    courseName: parsed.courseName,
    os: parsed.os
  });
  await db.resetUserCourseInvalidAttempts(target.user_course_id);

  if (parsed.os > 0) {
    metrics.increment(
      "worker_open_seat_detected_total",
      1,
      "Open-seat detections during monitor scans."
    );
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
    metrics.increment(
      `worker_enqueue_action_${enqueueResult.action}_total`,
      1,
      "Notification enqueue outcomes by action."
    );

    if (enqueueResult.action === "already_failed") {
      await db.stopTrackingUserCourse(target.user_course_id);
      return {
        status: "failed_and_stopped",
        queueAction: enqueueResult.action,
        os: parsed.os
      };
    }

    if (
      enqueueResult.action === "suppressed" ||
      enqueueResult.action === "already_sent" ||
      enqueueResult.action === "already_suppressed"
    ) {
      await db.markUserCourseNotified(target.user_course_id);
      return {
        status: "suppressed_and_notified",
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
  const runStartedAtMs = Date.now();
  metrics.increment(
    "worker_monitor_runs_total",
    1,
    "Total monitor loop executions."
  );
  metrics.setGauge(
    "worker_monitor_last_run_started_at_seconds",
    Math.floor(runStartedAtMs / 1000),
    "Unix timestamp of the latest monitor run start."
  );

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

  function finalizeRun(resultSummary) {
    const durationMs = Date.now() - runStartedAtMs;
    metrics.increment(
      "worker_monitor_scanned_total",
      resultSummary.scanned,
      "Total tracked-course scan checks executed by the monitor."
    );
    metrics.increment(
      "worker_monitor_queued_total",
      resultSummary.queued,
      "Total queue insertions/requeues from monitor scans."
    );
    metrics.increment(
      "worker_monitor_suppressed_total",
      resultSummary.suppressed,
      "Total suppressed notifications encountered during monitor scans."
    );
    metrics.increment(
      "worker_monitor_notified_total",
      resultSummary.notified,
      "Total notifications delivered by monitor dispatch."
    );
    metrics.increment(
      "worker_monitor_stopped_total",
      resultSummary.stopped,
      "Total tracked courses stopped by monitor flow."
    );
    metrics.increment(
      "worker_monitor_retried_total",
      resultSummary.retried,
      "Total notification retries scheduled by monitor dispatch."
    );
    metrics.increment(
      "worker_monitor_failures_total",
      resultSummary.failures,
      "Total monitor failures recorded in run summaries."
    );
    metrics.observeHistogram("worker_monitor_run_duration_ms", durationMs, {
      help: "Worker monitor run duration in milliseconds."
    });
    metrics.setGauge(
      "worker_monitor_last_run_duration_ms",
      durationMs,
      "Duration of the latest monitor run in milliseconds."
    );
    metrics.setGauge(
      "worker_monitor_last_run_completed_at_seconds",
      Math.floor(Date.now() / 1000),
      "Unix timestamp of the latest monitor run completion."
    );
    return resultSummary;
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
          metrics.increment(
            "worker_session_auto_relogin_success_total",
            1,
            "Auto re-login attempts that successfully recovered session state."
          );
          monitorLogger.info("auto re-login restored session", {
            event: "monitor.session.auto_relogin.success",
            reason: isClockExpired
              ? "session_clock_expired"
              : "session_state_not_ok"
          });
        } else if (relogin && relogin.reason) {
          metrics.increment(
            "worker_session_auto_relogin_failure_total",
            1,
            "Auto re-login attempts that did not recover session state."
          );
          monitorLogger.warn("auto re-login skipped or failed", {
            event: "monitor.session.auto_relogin.skipped_or_failed",
            reason: relogin.reason
          });
        }
      } catch (error) {
        metrics.increment(
          "worker_session_auto_relogin_failure_total",
          1,
          "Auto re-login attempts that errored."
        );
        monitorLogger.warn("auto re-login errored", {
          event: "monitor.session.auto_relogin.error",
          error
        });
      }
    }

    if (!recoveredByAutoRelogin) {
      if (isClockExpired) {
        metrics.increment(
          "worker_session_expired_loop_total",
          1,
          "Monitor loops that detected expired session timestamp."
        );
      }
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
        monitorLogger.error("notification dispatch failed", {
          event: "monitor.dispatch.batch_failure",
          error: dispatchError
        });
      }
      return finalizeRun(summary);
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
        notifier,
        notificationPolicy: policy,
        forceRefresh: false
      });
      if (result.status === "open_enqueued") {
        if (result.queueAction === "queued" || result.queueAction === "requeued") {
          summary.queued += 1;
        }
      } else if (result.status === "suppressed_and_notified") {
        summary.suppressed += 1;
        summary.stopped += 1;
      } else if (result.status === "failed_and_stopped" || result.status === "invalid_and_stopped") {
        summary.failures += 1;
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
              metrics.increment(
                "worker_session_auto_relogin_success_total",
                1,
                "Auto re-login recoveries after mid-scan failures."
              );
              monitorLogger.info("auto re-login succeeded after mid-scan failure", {
                event: "monitor.session.auto_relogin.success_mid_scan",
                userCourseId: target.user_course_id,
                cartId: target.cart_id
              });
              const retryResult = await processTrackedCourse({
                target,
                db,
                vsbSource,
                notifier,
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
              } else if (retryResult.status === "suppressed_and_notified") {
                summary.suppressed += 1;
                summary.stopped += 1;
              } else if (retryResult.status === "failed_and_stopped" || retryResult.status === "invalid_and_stopped") {
                summary.failures += 1;
                summary.stopped += 1;
              }
              continue;
            }
          } catch (reloginError) {
            metrics.increment(
              "worker_session_auto_relogin_failure_total",
              1,
              "Auto re-login retries that errored after mid-scan failures."
            );
            monitorLogger.warn("auto re-login after mid-scan failure errored", {
              event: "monitor.session.auto_relogin.error_mid_scan",
              error: reloginError
            });
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
      monitorLogger.error("tracked course processing failed", {
        event: "monitor.scan.course_failure",
        userCourseId: target.user_course_id,
        cartId: target.cart_id,
        error
      });
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
    monitorLogger.error("notification dispatch failed", {
      event: "monitor.dispatch.batch_failure",
      error: dispatchError
    });
  }

  return finalizeRun(summary);
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
      notifier,
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
            metrics.increment(
              "worker_session_auto_relogin_success_total",
              1,
              "Auto re-login recoveries during immediate checks."
            );
            const retryResult = await processTrackedCourse({
              target,
              db,
              vsbSource,
              notifier,
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
          metrics.increment(
            "worker_session_auto_relogin_failure_total",
            1,
            "Auto re-login retries that errored during immediate checks."
          );
          monitorLogger.warn("auto re-login during immediate check failed", {
            event: "monitor.session.auto_relogin.error_immediate_check",
            error: reloginError
          });
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
