const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
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

test("checkWorkerHealthStatus detects healthy, stale, and fatal snapshots", () => {
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

test("API /api/worker-health returns healthy and stale states", async (t) => {
  metrics.reset();
  const healthPath = `/tmp/coursenotif_worker_health_test_${Date.now()}_${Math.floor(
    Math.random() * 100000
  )}.json`;

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
  } finally {
    metrics.reset();
    await fs.rm(healthPath, { force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});
