const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { createLogger } = require("./logger");
const { metrics } = require("./metrics");

const notificationLogger = createLogger({ component: "notification" });

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

function getSmtpConfig({ passEnvName = "SMTP_PASS" } = {}) {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number.parseInt(process.env.SMTP_PORT || "465", 10);
  const secure = parseBoolean(process.env.SMTP_SECURE, true);
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env[passEnvName] || process.env.SMTP_PASS || "").trim();
  const from = String(process.env.SMTP_FROM || user || "").trim();

  if (!user || !pass) {
    throw new Error(
      "SMTP_USER and SMTP_PASS (or pass override env var) are required to send emails. Configure Gmail SMTP app-password credentials."
    );
  }

  if (!from) {
    throw new Error("SMTP_FROM is required when SMTP_USER is not set.");
  }

  return {
    host,
    port: Number.isFinite(port) ? port : 465,
    secure,
    user,
    pass,
    from
  };
}

const transporterCache = new Map();

function createTransportKey(config) {
  const passFingerprint = crypto
    .createHash("sha256")
    .update(config.pass)
    .digest("hex");
  return [
    config.host,
    config.port,
    config.secure,
    config.user,
    config.from,
    passFingerprint
  ].join("|");
}

function getTransporter({ passEnvName = "SMTP_PASS" } = {}) {
  const config = getSmtpConfig({ passEnvName });
  const transportKey = createTransportKey(config);
  let transporter = transporterCache.get(transportKey);

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass
      }
    });
    transporterCache.set(transportKey, transporter);
  }

  return {
    config,
    transporter
  };
}

async function sendMail({ toEmail, subject, text, html, passEnvName = "SMTP_PASS" }) {
  if (!toEmail) {
    throw new Error("Recipient email is required.");
  }
  const { config, transporter } = getTransporter({ passEnvName });
  const startedAtMs = Date.now();
  try {
    const info = await transporter.sendMail({
      from: config.from,
      to: toEmail,
      subject,
      text,
      html
    });
    const durationMs = Date.now() - startedAtMs;
    metrics.increment(
      "notification_emails_sent_total",
      1,
      "Total SMTP emails sent successfully."
    );
    metrics.observeHistogram("notification_email_send_duration_ms", durationMs, {
      help: "SMTP send duration in milliseconds."
    });
    notificationLogger.info("email sent", {
      event: "notification.email.sent",
      toEmail,
      subject,
      messageId: info && info.messageId ? String(info.messageId) : null,
      durationMs
    });
    return {
      messageId: info && info.messageId ? String(info.messageId) : null
    };
  } catch (error) {
    metrics.increment(
      "notification_email_send_failures_total",
      1,
      "Total SMTP email send failures."
    );
    notificationLogger.error("email send failed", {
      event: "notification.email.failed",
      toEmail,
      subject,
      passEnvName,
      error
    });
    throw error;
  }
}

async function sendCourseOpenEmail({ toEmail, cartId, courseName, os }) {
  const cartIdText = String(cartId || "").trim();
  const courseTitle = String(courseName || cartIdText || "Tracked course").trim();
  const openSeats = Number.isFinite(Number(os)) ? Number(os) : 0;

  const subject = `Course ${cartIdText || courseTitle} is now open`;
  const text = [
    "Good news!",
    "",
    `${courseTitle} now has ${openSeats} open seat(s).`,
    `Cart ID: ${cartIdText || "unknown"}`
  ].join("\n");
  const html = [
    "<p><strong>Good news!</strong></p>",
    `<p>${courseTitle} now has <strong>${openSeats}</strong> open seat(s).</p>`,
    `<p>Cart ID: <code>${cartIdText || "unknown"}</code></p>`
  ].join("");

  return sendMail({
    toEmail,
    subject,
    text,
    html
  });
}

async function sendSessionExpiredEmail({ toEmail, reason }) {
  const reasonText = String(reason || "Unknown session error").trim();
  const subject = "VSB session expired or failed";
  const text = [
    "CourseNotif detected a session problem while monitoring courses.",
    "",
    `Reason: ${reasonText}`
  ].join("\n");

  await sendMail({
    toEmail,
    subject,
    text
  });
}

async function sendLoginOtpEmail({ toEmail, otpCode, expiresMinutes = 10 }) {
  const code = String(otpCode || "").trim();
  if (!/^\d{6}$/.test(code)) {
    throw new Error("A 6-digit OTP code is required.");
  }

  const ttl = Number.isFinite(Number(expiresMinutes))
    ? Math.max(1, Number(expiresMinutes))
    : 10;

  const subject = "Your CourseNotif login code";
  const text = [
    "Use this one-time code to sign in to CourseNotif:",
    "",
    code,
    "",
    `This code expires in ${ttl} minute(s).`,
    "If you did not request this code, you can ignore this email."
  ].join("\n");

  const html = [
    "<p>Use this one-time code to sign in to <strong>CourseNotif</strong>:</p>",
    `<p style="font-size: 24px; font-weight: 700; letter-spacing: 2px;"><code>${code}</code></p>`,
    `<p>This code expires in <strong>${ttl} minute(s)</strong>.</p>`,
    "<p>If you did not request this code, you can ignore this email.</p>"
  ].join("");

  await sendMail({
    toEmail,
    subject,
    text,
    html,
    passEnvName: "SMTP_PASS_AUTH"
  });
}

module.exports = {
  sendCourseOpenEmail,
  sendSessionExpiredEmail,
  sendLoginOtpEmail
};
