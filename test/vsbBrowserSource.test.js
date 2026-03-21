const test = require("node:test");
const assert = require("node:assert/strict");
const { createVsbBrowserSource } = require("../src/vsbBrowserSource");

class FakeLocator {
  constructor(selector, behavior = {}) {
    this.selector = selector;
    this.behavior = behavior;
  }

  first() {
    return this;
  }

  nth() {
    return this;
  }

  filter() {
    return this;
  }

  async waitFor() {
    this.#consume("waitFor", undefined);
  }

  async isVisible() {
    return this.#consume("isVisible", false);
  }

  async count() {
    return this.#consume("count", 1);
  }

  async isChecked() {
    return this.#consume("isChecked", false);
  }

  async click() {
    this.#consume("click", undefined);
  }

  async fill() {
    this.#consume("fill", undefined);
  }

  async press() {
    this.#consume("press", undefined);
  }

  #consume(kind, defaultValue) {
    const queue = this.behavior[kind];
    if (!Array.isArray(queue) || queue.length === 0) {
      return defaultValue;
    }
    const next = queue.shift();
    if (next instanceof Error) {
      throw next;
    }
    if (typeof next === "function") {
      return next();
    }
    return next;
  }
}

class FakePage {
  constructor({ url = "about:blank", selectorBehaviors = {} } = {}) {
    this.currentUrl = url;
    this.selectorBehaviors = selectorBehaviors;
    this.gotoCalls = [];
    this.timeoutCalls = [];
    this.reloadCalls = [];
    this.eventHandlers = new Map();
    this.closed = false;
  }

  url() {
    return this.currentUrl;
  }

  isClosed() {
    return this.closed;
  }

  async goto(url, options = {}) {
    this.currentUrl = url;
    this.gotoCalls.push({ url, options });
  }

  locator(selector) {
    if (!this.selectorBehaviors[selector]) {
      this.selectorBehaviors[selector] = {};
    }
    return new FakeLocator(selector, this.selectorBehaviors[selector]);
  }

  async waitForTimeout(ms) {
    this.timeoutCalls.push(ms);
  }

  async reload(options = {}) {
    this.reloadCalls.push(options);
  }

  on(eventName, handler) {
    const handlers = this.eventHandlers.get(eventName) || [];
    handlers.push(handler);
    this.eventHandlers.set(eventName, handlers);
  }

  off(eventName, handler) {
    const handlers = this.eventHandlers.get(eventName) || [];
    this.eventHandlers.set(
      eventName,
      handlers.filter((entry) => entry !== handler)
    );
  }

  frames() {
    return [];
  }
}

function createFakeContext({
  pagesError = null,
  pages = [],
  newPage = null,
  closeImpl = null
} = {}) {
  let closed = false;
  return {
    pages() {
      if (pagesError) {
        throw pagesError;
      }
      return pages;
    },
    async newPage() {
      if (newPage) {
        return newPage;
      }
      const page = new FakePage();
      pages.push(page);
      return page;
    },
    async close() {
      closed = true;
      if (typeof closeImpl === "function") {
        await closeImpl();
      }
    },
    get closed() {
      return closed;
    }
  };
}

function makeBrowserConfig(overrides = {}) {
  return {
    vsbUrl: "https://vsb.example.edu",
    vsbUserDataDir: ".data/vsb-profile-test",
    vsbHeadless: true,
    vsbSearchSelector: "#search",
    vsbLoggedOutSelector: "#login",
    vsbSearchTimeoutMs: 1000,
    vsbDropdownTimeoutMs: 1000,
    vsbCaptureWaitMs: 10,
    vsbLoginWaitSeconds: 5,
    vsbLoginUsernameSelector: "#username",
    vsbLoginPasswordSelector: "#password",
    vsbLoginSubmitSelector: "#submit",
    vsbLoginContinueSelector: "#continue",
    vsbPostLoginWaitMs: 10,
    vsbAutoReloginEnabled: true,
    vsbLoginUsername: "student@example.com",
    vsbLoginPassword: "secret",
    vsbSyncTrackedCoursesOnStart: false,
    vsbSyncTrackedCoursesLimit: 50,
    vsbRefreshIntervalMinutes: 15,
    sessionDurationMinutes: 90,
    ...overrides
  };
}

test("browser source init-login recovers when the existing browser context is closed", async () => {
  const markSharedSessionOkCalls = [];
  const db = {
    markSharedSessionOk: async ({ sessionDurationMinutes }) => {
      markSharedSessionOkCalls.push(sessionDurationMinutes);
    }
  };

  const recoveredPage = new FakePage({
    selectorBehaviors: {
      "#search": {
        waitFor: [true]
      }
    }
  });
  let closedContexts = 0;
  const firstContext = createFakeContext({
    pagesError: new Error("Target page, context or browser has been closed"),
    closeImpl: async () => {
      closedContexts += 1;
    }
  });
  const secondContext = createFakeContext({
    pages: [recoveredPage]
  });
  const launchedContexts = [firstContext, secondContext];
  let launchCount = 0;

  const source = createVsbBrowserSource(db, makeBrowserConfig(), {
    playwright: {
      chromium: {
        launchPersistentContext: async () => launchedContexts[launchCount++]
      }
    }
  });

  try {
    const result = await source.initLoginSession();

    assert.deepEqual(result, { status: "session_ok_auto" });
    assert.equal(launchCount, 2);
    assert.equal(closedContexts, 1);
    assert.deepEqual(markSharedSessionOkCalls, [90]);
    assert.equal(recoveredPage.gotoCalls.length >= 2, true);
  } finally {
    await source.close();
  }
});

test("browser source reuses fresh cached JSP after auto re-login recovers the session UI", async () => {
  const markSharedSessionOkCalls = [];
  const latestStored = {
    file_name: "cached.jsp",
    jsp_body: JSON.stringify([{ cartid: "ABC123", os: 0, code: "EECS 1001" }]),
    source_path: "/tmp/cached.jsp",
    payload_hash: "cached-hash",
    generated_at: new Date().toISOString()
  };
  const db = {
    getSharedLatestJspFile: async () => latestStored,
    markSharedSessionOk: async ({ sessionDurationMinutes }) => {
      markSharedSessionOkCalls.push(sessionDurationMinutes);
    },
    listTrackedCourses: async () => []
  };

  const page = new FakePage({
    selectorBehaviors: {
      "#search": {
        waitFor: [new Error("search field missing"), true]
      },
      "#login": {
        isVisible: [true]
      }
    }
  });
  const context = createFakeContext({
    pages: [page]
  });

  const source = createVsbBrowserSource(
    db,
    makeBrowserConfig({ vsbSyncTrackedCoursesOnStart: true }),
    {
      playwright: {
        chromium: {
          launchPersistentContext: async () => context
        }
      }
    }
  );

  try {
    const candidates = await source.collectGetClassDataCandidates({
      cartId: "ABC123"
    });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].fileName, "cached.jsp");
    assert.deepEqual(markSharedSessionOkCalls, [90]);
    assert.equal(page.gotoCalls.length, 2);
  } finally {
    await source.close();
  }
});
