const nodemailer = require("nodemailer");

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

function getSmtpConfig() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number.parseInt(process.env.SMTP_PORT || "465", 10);
  const secure = parseBoolean(process.env.SMTP_SECURE, true);
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  const from = String(process.env.SMTP_FROM || user || "").trim();

  if (!user || !pass) {
    throw new Error(
      "SMTP_USER and SMTP_PASS are required to send emails. Configure Gmail SMTP app-password credentials."
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

let cachedTransporter = null;
let cachedTransportKey = null;

function createTransportKey(config) {
  return [config.host, config.port, config.secure, config.user].join("|");
}

function getTransporter() {
  const config = getSmtpConfig();
  const transportKey = createTransportKey(config);

  if (!cachedTransporter || cachedTransportKey !== transportKey) {
    cachedTransporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass
      }
    });
    cachedTransportKey = transportKey;
  }

  return {
    config,
    transporter: cachedTransporter
  };
}

async function sendMail({ toEmail, subject, text, html }) {
  if (!toEmail) {
    throw new Error("Recipient email is required.");
  }
  const { config, transporter } = getTransporter();
  const info = await transporter.sendMail({
    from: config.from,
    to: toEmail,
    subject,
    text,
    html
  });
  console.log(
    JSON.stringify({
      event: "EMAIL_SENT",
      toEmail,
      subject,
      messageId: info.messageId,
      timestamp: new Date().toISOString()
    })
  );
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

  await sendMail({
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

module.exports = {
  sendCourseOpenEmail,
  sendSessionExpiredEmail
};
