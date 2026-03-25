const test = require("node:test");
const assert = require("node:assert/strict");
const nodemailer = require("nodemailer");
const notification = require("../src/notification");

function withEnv(overrides) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

test("notification emails escape HTML course content", async (t) => {
  const sentMessages = [];
  const originalCreateTransport = nodemailer.createTransport;
  notification.__testOnly.resetTransporterCache();
  nodemailer.createTransport = () => ({
    sendMail: async (message) => {
      sentMessages.push(message);
      return { messageId: "test-message-id" };
    }
  });

  const restoreEnv = withEnv({
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: `mailer-${Date.now()}@example.com`,
    SMTP_PASS: "smtp-pass",
    SMTP_FROM: "YorkU Course Availability Notifier <mailer@example.com>",
    APP_BASE_URL: 'https://app.example.com/?next="quoted"&course=<unsafe>'
  });

  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
    notification.__testOnly.resetTransporterCache();
    restoreEnv();
  });

  await notification.sendCourseOpenEmail({
    toEmail: "student@example.com",
    cartId: "AB1234",
    courseName: '<img src=x onerror="alert(1)">',
    os: 2
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(sentMessages[0].html, /<img src=x onerror="alert\(1\)">/);
  assert.match(sentMessages[0].html, /https:\/\/app\.example\.com\/\?next=&quot;quoted&quot;&amp;course=&lt;unsafe&gt;/);
});

test("notification subject sanitization removes newlines", () => {
  assert.equal(
    notification.__testOnly.sanitizeEmailHeaderValue("line one\r\nline two"),
    "line one line two"
  );
});
