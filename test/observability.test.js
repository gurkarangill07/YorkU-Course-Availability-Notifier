const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { MetricsRegistry, metrics } = require("../src/metrics");
const {
  checkWorkerHealthStatus
} = require("../src/workerHealth");
const { createApiApp } = require("../src/apiServer");

async function request(baseUrl, routePath, { headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method: "GET",
    headers
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (_error) {
      json = null;
    }
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    json
  };
}

async function listenOrSkip(server, t) {
  try {
    const address = await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(server.address());
      };
      server.on("error", onError);
      server.listen(0, "127.0.0.1", onListening);
    });
    return address;
  } catch (error) {
    if (error && error.code === "EPERM") {
      t.skip("TCP listen is not permitted in this environment.");
      return null;
    }
    throw error;
  }
}

test("MetricsRegistry renders Prometheus counters, gauges, and histograms", () => {
  const registry = new MetricsRegistry({ prefix: "testsvc" });
  registry.increment("requests_total", 2, "Total requests.");
  registry.setGauge("uptime_seconds", 17, "Process uptime.");
  registry.observeHistogram("latency_ms", 42, {
    help: "Latency histogram.",
    buckets: [10, 50]
  });
  registry.observeHistogram("latency_ms", 8, {
    help: "Latency histogram.",
    buckets: [10, 50]
  });

  const body = registry.renderPrometheus();
  assert.match(body, /testsvc_requests_total 2/);
  assert.match(body, /testsvc_uptime_seconds 17/);
  assert.match(body, /testsvc_latency_ms_bucket\{le="10"\} 1/);
  assert.match(body, /testsvc_latency_ms_bucket\{le="50"\} 2/);
  assert.match(body, /testsvc_latency_ms_count 2/);
});

test("checkWorkerHealthStatus detects healthy, stale, fatal, and disabled snapshots", () => {
  const healthy = checkWorkerHealthStatus(
    {
      pid: process.pid,
      state: "running",
      updatedAt: new Date().toISOString()
    },
    {
      maxStaleSeconds: 300,
      requirePidAlive: true
    }
  );
  assert.equal(healthy.ok, true);
  assert.equal(healthy.reason, "healthy");

  const stale = checkWorkerHealthStatus(
    {
      pid: process.pid,
      state: "running",
      updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    },
    {
      maxStaleSeconds: 60,
      requirePidAlive: true
    }
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale_heartbeat");

  const fatal = checkWorkerHealthStatus(
    {
      pid: process.pid,
      state: "fatal",
      updatedAt: new Date().toISOString()
    },
    {
      maxStaleSeconds: 300,
      requirePidAlive: true
    }
  );
  assert.equal(fatal.ok, false);
  assert.equal(fatal.reason, "fatal_state");

  const disabled = checkWorkerHealthStatus(
    {
      pid: 999999,
      state: "disabled",
      updatedAt: new Date().toISOString()
    },
    {
      maxStaleSeconds: 300,
      requirePidAlive: true
    }
  );
  assert.equal(disabled.ok, true);
  assert.equal(disabled.reason, "disabled");
});

test("API /api/metrics enforces bearer auth and serves metrics", async (t) => {
  metrics.reset();
  const app = createApiApp({
    db: {},
    notifierModule: {
      sendLoginOtpEmail: async () => {},
      sendCourseOpenEmail: async () => ({ messageId: "mid" }),
      sendSessionExpiredEmail: async () => {}
    },
    env: {
      ...process.env,
      OTP_PEPPER: process.env.OTP_PEPPER || "test-pepper",
      AUTH_COOKIE_SECURE: "false",
      METRICS_BEARER_TOKEN: "secret-token"
    }
  });
  const server = http.createServer(app);
  const address = await listenOrSkip(server, t);
  if (!address) {
    return;
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const unauthorized = await request(baseUrl, "/api/metrics");
    assert.equal(unauthorized.status, 401);

    const authorizedFirst = await request(baseUrl, "/api/metrics", {
      headers: {
        authorization: "Bearer secret-token"
      }
    });
    assert.equal(authorizedFirst.status, 200);
    assert.match(
      String(authorizedFirst.headers.get("content-type") || ""),
      /text\/plain/
    );

    const authorizedSecond = await request(baseUrl, "/api/metrics", {
      headers: {
        authorization: "Bearer secret-token"
      }
    });
    assert.equal(authorizedSecond.status, 200);
    assert.match(authorizedSecond.text, /coursenotif_api_http_requests_total/);
  } finally {
    metrics.reset();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("API observability endpoints stay disabled until bearer auth is configured", async (t) => {
  metrics.reset();
  const app = createApiApp({
    db: {},
    notifierModule: {
      sendLoginOtpEmail: async () => {},
      sendCourseOpenEmail: async () => ({ messageId: "mid" }),
      sendSessionExpiredEmail: async () => {}
    },
    env: {
      ...process.env,
      OTP_PEPPER: process.env.OTP_PEPPER || "test-pepper",
      AUTH_COOKIE_SECURE: "false",
      METRICS_BEARER_TOKEN: ""
    }
  });
  const server = http.createServer(app);
  const address = await listenOrSkip(server, t);
  if (!address) {
    return;
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const metricsResponse = await request(baseUrl, "/api/metrics");
    assert.equal(metricsResponse.status, 503);
    assert.equal(metricsResponse.json.ok, false);
    assert.equal(metricsResponse.json.reason, "observability_auth_not_configured");

    const workerMetricsResponse = await request(baseUrl, "/api/worker-metrics");
    assert.equal(workerMetricsResponse.status, 503);
    assert.equal(
      workerMetricsResponse.json.reason,
      "observability_auth_not_configured"
    );

    const workerHealthResponse = await request(baseUrl, "/api/worker-health");
    assert.equal(workerHealthResponse.status, 503);
    assert.equal(
      workerHealthResponse.json.reason,
      "observability_auth_not_configured"
    );
  } finally {
    metrics.reset();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("API responses include baseline security headers", async (t) => {
  const app = createApiApp({
    db: {},
    notifierModule: {
      sendLoginOtpEmail: async () => {},
      sendCourseOpenEmail: async () => ({ messageId: "mid" }),
      sendSessionExpiredEmail: async () => {}
    },
    env: {
      ...process.env,
      OTP_PEPPER: process.env.OTP_PEPPER || "test-pepper",
      AUTH_COOKIE_SECURE: "false",
      METRICS_BEARER_TOKEN: "secret-token"
    }
  });
  const server = http.createServer(app);
  const address = await listenOrSkip(server, t);
  if (!address) {
    return;
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await request(baseUrl, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(health.headers.get("x-frame-options"), "DENY");
    assert.equal(health.headers.get("referrer-policy"), "same-origin");
    assert.equal(health.headers.get("x-powered-by"), null);
    assert.match(
      String(health.headers.get("content-security-policy") || ""),
      /default-src 'self'/
    );
    assert.match(
      String(health.headers.get("content-security-policy") || ""),
      /frame-ancestors 'none'/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("API malformed JSON responses still include baseline security headers", async (t) => {
  const app = createApiApp({
    db: {},
    notifierModule: {
      sendLoginOtpEmail: async () => {},
      sendCourseOpenEmail: async () => ({ messageId: "mid" }),
      sendSessionExpiredEmail: async () => {}
    },
    env: {
      ...process.env,
      OTP_PEPPER: process.env.OTP_PEPPER || "test-pepper",
      AUTH_COOKIE_SECURE: "false",
      METRICS_BEARER_TOKEN: "secret-token"
    }
  });
  const server = http.createServer(app);
  const address = await listenOrSkip(server, t);
  if (!address) {
    return;
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/auth/send-otp`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: "{"
    });
    const text = await response.text();

    assert.equal(response.status, 500);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "same-origin");
    assert.match(
      String(response.headers.get("content-security-policy") || ""),
      /default-src 'self'/
    );
    assert.match(text, /internal server error/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("API /api/worker-health returns healthy and stale states", async (t) => {
  metrics.reset();
  const healthPath = path.join(
    os.tmpdir(),
    `coursenotif_worker_health_test_${Date.now()}_${Math.floor(
      Math.random() * 100000
    )}.json`
  );

  const app = createApiApp({
    db: {},
    notifierModule: {
      sendLoginOtpEmail: async () => {},
      sendCourseOpenEmail: async () => ({ messageId: "mid" }),
      sendSessionExpiredEmail: async () => {}
    },
    env: {
      ...process.env,
      OTP_PEPPER: process.env.OTP_PEPPER || "test-pepper",
      AUTH_COOKIE_SECURE: "false",
      METRICS_BEARER_TOKEN: "secret-token",
      WORKER_HEALTH_PATH: healthPath,
      WORKER_HEALTH_MAX_STALE_SECONDS: "60"
    }
  });
  const server = http.createServer(app);
  const address = await listenOrSkip(server, t);
  if (!address) {
    return;
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fs.writeFile(
      healthPath,
      JSON.stringify(
        {
          pid: process.pid,
          state: "running",
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )
    );

    const healthy = await request(baseUrl, "/api/worker-health", {
      headers: {
        authorization: "Bearer secret-token"
      }
    });
    assert.equal(healthy.status, 200);
    assert.equal(healthy.json.ok, true);
    assert.equal(healthy.json.reason, "healthy");

    await fs.writeFile(
      healthPath,
      JSON.stringify(
        {
          pid: process.pid,
          state: "running",
          updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
        },
        null,
        2
      )
    );

    const stale = await request(baseUrl, "/api/worker-health", {
      headers: {
        authorization: "Bearer secret-token"
      }
    });
    assert.equal(stale.status, 503);
    assert.equal(stale.json.ok, false);
    assert.equal(stale.json.reason, "stale_heartbeat");

    await fs.writeFile(
      healthPath,
      JSON.stringify(
        {
          pid: 999999,
          state: "disabled",
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )
    );

    const disabled = await request(baseUrl, "/api/worker-health", {
      headers: {
        authorization: "Bearer secret-token"
      }
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.ok, true);
    assert.equal(disabled.json.reason, "disabled");
  } finally {
    metrics.reset();
    await fs.rm(healthPath, { force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("API /api/worker-metrics enforces bearer auth and serves worker metrics", async (t) => {
  metrics.reset();
  const metricsPath = path.join(
    os.tmpdir(),
    `coursenotif_worker_metrics_test_${Date.now()}_${Math.floor(
      Math.random() * 100000
    )}.prom`
  );

  const app = createApiApp({
    db: {},
    notifierModule: {
      sendLoginOtpEmail: async () => {},
      sendCourseOpenEmail: async () => ({ messageId: "mid" }),
      sendSessionExpiredEmail: async () => {}
    },
    env: {
      ...process.env,
      OTP_PEPPER: process.env.OTP_PEPPER || "test-pepper",
      AUTH_COOKIE_SECURE: "false",
      METRICS_BEARER_TOKEN: "secret-token",
      WORKER_METRICS_PATH: metricsPath
    }
  });
  const server = http.createServer(app);
  const address = await listenOrSkip(server, t);
  if (!address) {
    return;
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fs.writeFile(
      metricsPath,
      "# HELP coursenotif_worker_monitor_runs_total Total worker runs.\n# TYPE coursenotif_worker_monitor_runs_total counter\ncoursenotif_worker_monitor_runs_total 7\n"
    );

    const unauthorized = await request(baseUrl, "/api/worker-metrics");
    assert.equal(unauthorized.status, 401);

    const authorized = await request(baseUrl, "/api/worker-metrics", {
      headers: {
        authorization: "Bearer secret-token"
      }
    });
    assert.equal(authorized.status, 200);
    assert.match(
      String(authorized.headers.get("content-type") || ""),
      /text\/plain/
    );
    assert.match(
      authorized.text,
      /coursenotif_worker_monitor_runs_total 7/
    );

    await fs.rm(metricsPath, { force: true });

    const missing = await request(baseUrl, "/api/worker-metrics", {
      headers: {
        authorization: "Bearer secret-token"
      }
    });
    assert.equal(missing.status, 503);
    assert.equal(missing.json.ok, false);
    assert.equal(missing.json.reason, "worker_metrics_unreadable");
  } finally {
    metrics.reset();
    await fs.rm(metricsPath, { force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});
