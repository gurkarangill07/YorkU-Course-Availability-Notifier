const path = require("path");
const { createLogger } = require("./logger");

const vsbLogger = createLogger({ component: "vsb" });

function normalizeLogValue(value) {
  if (value instanceof Error) {
    return {
      name: value.name || "Error",
      message: value.message || String(value),
      code: value.code || null
    };
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return String(value);
  }
}

function logWithLevel(level, args) {
  const parts = Array.isArray(args) ? args : [];
  if (!parts.length) {
    return;
  }
  const [first, ...rest] = parts;
  let message = "vsb log";

  if (typeof first === "string" && first.trim()) {
    message = first;
  } else if (first instanceof Error) {
    message = first.message || "vsb error";
  } else {
    message = String(first);
  }

  const errorFromFirst = first instanceof Error ? first : null;
  const errorFromRest =
    rest.find((item) => item instanceof Error) || null;
  const details = rest
    .filter((item) => !(item instanceof Error))
    .map((item) => normalizeLogValue(item));
  const fields = {
    event: "vsb.log",
    details: details.length ? details : undefined,
    error: errorFromFirst || errorFromRest || undefined
  };

  if (level === "error") {
    vsbLogger.error(message, fields);
    return;
  }
  if (level === "warn") {
    vsbLogger.warn(message, fields);
    return;
  }
  vsbLogger.info(message, fields);
}

function logInfo(...args) {
  logWithLevel("info", args);
}

function logError(...args) {
  logWithLevel("error", args);
}

function toDate(input) {
  if (!input) {
    return new Date(0);
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(0);
  }
  return parsed;
}

function pickLatestJspFile(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return null;
  }

  return files
    .slice()
    .sort((a, b) => toDate(b.generatedAt) - toDate(a.generatedAt))[0];
}

function mapDbJspRowToCandidate(row) {
  if (!row) {
    return null;
  }
  return {
    fileName: row.file_name,
    jspBody: row.jsp_body,
    sourcePath: row.source_path,
    payloadHash: row.payload_hash,
    generatedAt: row.generated_at || row.updated_at
  };
}

function isWithinRefreshWindow(dateLike, refreshWindowMs) {
  const ts = toDate(dateLike).getTime();
  if (ts <= 0) {
    return false;
  }
  return Date.now() - ts < refreshWindowMs;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createVsbBrowserSource(db, config) {
  let context = null;
  let page = null;
  let hasSyncedTrackedCoursesForContext = false;
  const coursePresenceCache = new Map();
  const coursePresenceCacheTtlMs = 45 * 60 * 1000;

  function normalizeCartId(value) {
    return String(value || "").trim().toUpperCase();
  }

  function setCoursePresenceCache(cartId, isPresent, source = "unknown") {
    const key = normalizeCartId(cartId);
    if (!key) {
      return;
    }
    coursePresenceCache.set(key, {
      isPresent: Boolean(isPresent),
      updatedAt: Date.now(),
      source
    });
  }

  function getCoursePresenceCache(cartId) {
    const key = normalizeCartId(cartId);
    if (!key) {
      return null;
    }
    const cached = coursePresenceCache.get(key);
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.updatedAt > coursePresenceCacheTtlMs) {
      coursePresenceCache.delete(key);
      return null;
    }
    return cached;
  }

  function clearCoursePresenceCache() {
    coursePresenceCache.clear();
  }

  function hasCartIdToken(jspBody, cartId) {
    const token = normalizeCartId(cartId);
    if (!token) {
      return false;
    }
    const raw = String(jspBody || "").toUpperCase();
    const tokenRegex = new RegExp(
      `(^|[^A-Z0-9])${escapeRegExp(token)}([^A-Z0-9]|$)`,
      "i"
    );
    return tokenRegex.test(raw);
  }

  function recordPresenceFromCandidate(cartId, candidate) {
    const token = normalizeCartId(cartId);
    if (!token || !candidate) {
      return;
    }
    const present = hasCartIdToken(candidate.jspBody, token);
    setCoursePresenceCache(token, present, present ? "jsp_capture_present" : "jsp_capture_absent");
  }

  function getVsbHost() {
    try {
      return new URL(config.vsbUrl).host;
    } catch (_) {
      return null;
    }
  }

  function requirePlaywright() {
    try {
      return require("playwright");
    } catch (_) {
      throw new Error(
        "Playwright is not installed. Run: npm install && npx playwright install chromium"
      );
    }
  }

  function isBrowserClosedError(error) {
    const message = String((error && error.message) || "").toLowerCase();
    return (
      message.includes("target page, context or browser has been closed") ||
      message.includes("browsercontext.newpage") ||
      message.includes("browsercontext.pages") ||
      message.includes("browser has been closed") ||
      message.includes("browser has disconnected") ||
      message.includes("context closed")
    );
  }

  async function resetBrowserState() {
    if (context) {
      try {
        await context.close();
      } catch (_) {
        // Context may already be closed.
      }
    }
    context = null;
    page = null;
    hasSyncedTrackedCoursesForContext = false;
    clearCoursePresenceCache();
  }

  async function ensureBrowser({ allowRecover = true } = {}) {
    if (!config.vsbUrl) {
      throw new Error("VSB_URL is required for browser automation mode.");
    }

    try {
      if (!context) {
        const { chromium } = requirePlaywright();
        const userDataDir = path.resolve(config.vsbUserDataDir);
        context = await chromium.launchPersistentContext(userDataDir, {
          headless: config.vsbHeadless
        });
        hasSyncedTrackedCoursesForContext = false;
        clearCoursePresenceCache();
      }

      const pages = context.pages().filter((p) => !p.isClosed());
      const vsbHost = getVsbHost();
      const preferredPage =
        pages.find((p) => {
          const url = p.url();
          if (!url || !vsbHost) {
            return false;
          }
          return url.includes(vsbHost);
        }) || pages[0] || null;

      if (preferredPage) {
        page = preferredPage;
      } else {
        page = await context.newPage();
      }

      if (!page.url() || page.url() === "about:blank") {
        await page.goto(config.vsbUrl, { waitUntil: "domcontentloaded" });
      }
    } catch (error) {
      if (allowRecover && isBrowserClosedError(error)) {
        logInfo("[vsb] Browser context/page closed unexpectedly; relaunching browser context.");
        await resetBrowserState();
        return ensureBrowser({ allowRecover: false });
      }
      throw error;
    }
  }

  async function isLoggedOutScreenVisible() {
    if (!config.vsbLoggedOutSelector) {
      return false;
    }
    try {
      return await page
        .locator(config.vsbLoggedOutSelector)
        .first()
        .isVisible({ timeout: 1000 });
    } catch (_) {
      return false;
    }
  }

  function hasAutoReloginCredentials() {
    return Boolean(
      config.vsbAutoReloginEnabled &&
      String(config.vsbLoginUsername || "").trim() &&
      String(config.vsbLoginPassword || "").trim()
    );
  }

  async function waitForSearchField() {
    await page
      .locator(config.vsbSearchSelector)
      .first()
      .waitFor({ state: "visible", timeout: config.vsbSearchTimeoutMs });

    // Guard against overly broad search selectors that can match login forms.
    if (await isLoggedOutScreenVisible()) {
      throw new Error("login_ui_visible");
    }
  }

  async function tryFallbackLoginInFrame(frame) {
    const passwordInput = frame.locator(config.vsbLoginPasswordSelector).first();
    const passwordCount = await passwordInput.count().catch(() => 0);
    if (passwordCount === 0) {
      return { ok: false, reason: "password_field_missing" };
    }

    try {
      await passwordInput.waitFor({
        state: "visible",
        timeout: 1500
      });
    } catch (_) {
      return { ok: false, reason: "password_field_not_visible" };
    }

    const fallbackUsernameSelector = [
      config.vsbLoginUsernameSelector,
      "input[type='text']",
      "input[type='email']",
      "input[name*='user']",
      "input[id*='user']",
      "input[name*='email']",
      "input[id*='email']",
      "input[name*='login']",
      "input[id*='login']"
    ].join(", ");

    const usernameInput = frame.locator(fallbackUsernameSelector).first();
    const usernameCount = await usernameInput.count().catch(() => 0);
    if (usernameCount === 0) {
      return { ok: false, reason: "username_field_missing" };
    }

    try {
      await usernameInput.waitFor({
        state: "visible",
        timeout: 1500
      });
    } catch (_) {
      return { ok: false, reason: "username_field_not_visible" };
    }

    await usernameInput.fill(String(config.vsbLoginUsername));
    await passwordInput.fill(String(config.vsbLoginPassword));

    const submitSelector = [
      config.vsbLoginSubmitSelector,
      "button[type='submit']",
      "input[type='submit']",
      "button[name='login']",
      "button"
    ].join(", ");
    const submit = frame.locator(submitSelector).first();
    const submitCount = await submit.count().catch(() => 0);
    if (submitCount > 0) {
      try {
        await submit.click({ timeout: 1500 });
      } catch (_) {
        await passwordInput.press("Enter");
      }
    } else {
      await passwordInput.press("Enter");
    }

    return { ok: true };
  }

  async function attemptFallbackLoginAcrossFrames() {
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const result = await tryFallbackLoginInFrame(frame);
        if (result.ok) {
          return { ok: true };
        }
      } catch (_) {
        // Try next frame.
      }
    }
    return { ok: false, reason: "login fields not found" };
  }

  async function tryPassportContinueHandoff() {
    const continueLink = page.locator(config.vsbLoginContinueSelector).first();
    const continueCount = await continueLink.count().catch(() => 0);
    if (continueCount === 0) {
      return false;
    }

    try {
      await continueLink.click({ timeout: 3000 });
      await page.waitForTimeout(1200);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function attemptAutoRelogin(reason) {
    if (!hasAutoReloginCredentials()) {
      return {
        ok: false,
        reason: "missing auto-relogin credentials"
      };
    }

    await ensureBrowser();
    await page.goto(config.vsbUrl, { waitUntil: "domcontentloaded" });

    // If session cookies are still valid, search field may already be visible.
    try {
      await waitForSearchField();
      await db.markSharedSessionOk({
        sessionDurationMinutes: config.sessionDurationMinutes
      });
      logInfo("[vsb] Session already active; auto re-login marked session ok.");
      return {
        ok: true,
        reason: "already_active"
      };
    } catch (_) {
      // Continue with credential-based login flow.
    }

    logInfo(`[vsb] Attempting auto re-login (${reason || "unknown_reason"})...`);

    const usernameInput = page.locator(config.vsbLoginUsernameSelector).first();
    const passwordInput = page.locator(config.vsbLoginPasswordSelector).first();

    try {
      await usernameInput.waitFor({
        state: "visible",
        timeout: config.vsbSearchTimeoutMs
      });
      await passwordInput.waitFor({
        state: "visible",
        timeout: config.vsbSearchTimeoutMs
      });
    } catch (_) {
      try {
        await waitForSearchField();
        await db.markSharedSessionOk({
          sessionDurationMinutes: config.sessionDurationMinutes
        });
        logInfo("[vsb] Session restored without login form; marked session ok.");
        return {
          ok: true,
          reason: "already_active_no_login_form"
        };
      } catch (_) {
        // Keep original failure result.
      }

      const fallback = await attemptFallbackLoginAcrossFrames();
      if (!fallback.ok) {
        const handoffClicked = await tryPassportContinueHandoff();
        if (handoffClicked) {
          try {
            await waitForSearchField();
            await db.markSharedSessionOk({
              sessionDurationMinutes: config.sessionDurationMinutes
            });
            hasSyncedTrackedCoursesForContext = false;
            clearCoursePresenceCache();
            logInfo("[vsb] Auto re-login succeeded via continue handoff without login form.");
            return {
              ok: true,
              reason: "continue_handoff_only"
            };
          } catch (_) {
            // Keep original failure if handoff did not reach VSB search UI.
          }
        }
        return {
          ok: false,
          reason: fallback.reason || "login fields not found"
        };
      }

      await page.waitForTimeout(config.vsbPostLoginWaitMs);

      try {
        await waitForSearchField();
      } catch (_) {
        const handoffClicked = await tryPassportContinueHandoff();
        if (!handoffClicked) {
          return {
            ok: false,
            reason: "search field still not visible after fallback login"
          };
        }
        try {
          await waitForSearchField();
        } catch (_) {
          return {
            ok: false,
            reason: "search field still not visible after fallback continue handoff"
          };
        }
      }

      await db.markSharedSessionOk({
        sessionDurationMinutes: config.sessionDurationMinutes
      });
      hasSyncedTrackedCoursesForContext = false;
      clearCoursePresenceCache();
      logInfo("[vsb] Auto re-login succeeded via fallback login flow.");
      return {
        ok: true,
        reason: "fallback_login"
      };
    }

    await usernameInput.fill(String(config.vsbLoginUsername));
    await passwordInput.fill(String(config.vsbLoginPassword));

    const submit = page.locator(config.vsbLoginSubmitSelector).first();
    const submitCount = await submit.count().catch(() => 0);
    if (submitCount > 0) {
      try {
        await submit.click({ timeout: config.vsbSearchTimeoutMs });
      } catch (_) {
        await passwordInput.press("Enter");
      }
    } else {
      await passwordInput.press("Enter");
    }

    await page.waitForTimeout(config.vsbPostLoginWaitMs);

    try {
      await waitForSearchField();
    } catch (_) {
      const handoffClicked = await tryPassportContinueHandoff();
      if (!handoffClicked) {
        return {
          ok: false,
          reason: "search field still not visible after auto login"
        };
      }
      try {
        await waitForSearchField();
      } catch (_) {
        return {
          ok: false,
          reason: "search field still not visible after continue handoff"
        };
      }
    }

    await db.markSharedSessionOk({
      sessionDurationMinutes: config.sessionDurationMinutes
    });

    hasSyncedTrackedCoursesForContext = false;
    clearCoursePresenceCache();

    logInfo("[vsb] Auto re-login succeeded.");
    return {
      ok: true
    };
  }

  async function ensureSessionReady() {
    await ensureBrowser();
    if (!page.url().includes("http")) {
      await page.goto(config.vsbUrl, { waitUntil: "domcontentloaded" });
    }
    try {
      await waitForSearchField();
    } catch (error) {
      const loggedOutVisible = await isLoggedOutScreenVisible();
      if (loggedOutVisible) {
        const relogin = await attemptAutoRelogin("session_ui_detected");
        if (!relogin.ok) {
          throw new Error(
            `VSB session/login expired and auto re-login failed: ${relogin.reason}`
          );
        }
      } else {
        const relogin = await attemptAutoRelogin("search_field_missing");
        if (!relogin.ok) {
          throw new Error("VSB session/login required: Enter Course field not available.");
        }
      }
    }

    if (!hasSyncedTrackedCoursesForContext) {
      await syncTrackedCoursesInBrowser();
    }
  }

  async function withGetClassCapture(runActions) {
    const captured = [];
    const onResponse = async (response) => {
      const responseUrl = response.url();
      if (!responseUrl.toLowerCase().includes("getclassdata.jsp")) {
        return;
      }
      try {
        const jspBody = await response.text();
        captured.push({
          fileName: `getClassData-${Date.now()}.jsp`,
          jspBody,
          sourcePath: responseUrl,
          payloadHash: null,
          generatedAt: new Date()
        });
      } catch (error) {
        logError(`[vsb] failed to read response body: ${error.message}`);
      }
    };

    page.on("response", onResponse);
    try {
      await runActions();
      await page.waitForTimeout(config.vsbCaptureWaitMs);
    } finally {
      page.off("response", onResponse);
    }
    
    if (captured.length === 0) {
      logInfo("[vsb] No JSP response captured. Captured responses:", captured.length);
    }
    
    return captured;
  }

  async function uncheckCourseCheckbox(cartId) {
    const cartIdText = String(cartId).trim();
    if (!cartIdText) {
      return;
    }
    const result = await page.evaluate(
      ({ targetCartId, rowSelector, checkboxSelector }) => {
        const normalize = (value) => String(value || "").trim().toUpperCase();
        const cartIdNorm = normalize(targetCartId);

        const checkedClassRegex =
          /(checked|selected|active|is-checked|mdc-checkbox--selected|mat-mdc-checkbox-checked|ng-checked)/i;

        function queryAll(root, selector) {
          try {
            return Array.from(root.querySelectorAll(selector));
          } catch (_) {
            return [];
          }
        }

        function isVisible(el) {
          if (!el) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            return false;
          }
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden";
        }

        function classLooksChecked(el) {
          if (!el) {
            return false;
          }
          const className = typeof el.className === "string" ? el.className : "";
          return checkedClassRegex.test(className);
        }

        function checkboxState(el) {
          if (!el) {
            return null;
          }
          if (el instanceof HTMLInputElement && el.type.toLowerCase() === "checkbox") {
            return Boolean(el.checked);
          }

          const aria = el.getAttribute("aria-checked");
          if (aria === "true") {
            return true;
          }
          if (aria === "false") {
            return false;
          }

          const ariaOwner = el.closest("[aria-checked]");
          if (ariaOwner) {
            const ownerAria = ariaOwner.getAttribute("aria-checked");
            if (ownerAria === "true") {
              return true;
            }
            if (ownerAria === "false") {
              return false;
            }
          }

          if (classLooksChecked(el) || classLooksChecked(el.closest("[class]"))) {
            return true;
          }

          return null;
        }

        function clickToggle(el) {
          if (!el) {
            return;
          }
          const clickable =
            el.closest("label, button, [role='checkbox'], [role='button']") || el;
          clickable.dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window
            })
          );
        }

        const candidates = [];
        const seen = new Set();
        const addCandidate = (el, source) => {
          if (!el || seen.has(el)) {
            return;
          }
          seen.add(el);
          candidates.push({ el, source });
        };

        const rows = queryAll(document, rowSelector).filter((el) =>
          normalize(el.textContent).includes(cartIdNorm)
        );

        for (const row of rows.slice(0, 20)) {
          let node = row;
          for (let depth = 0; node && depth < 4; depth += 1) {
            for (const checkbox of queryAll(node, checkboxSelector)) {
              addCandidate(checkbox, `row_depth_${depth}`);
            }
            node = node.parentElement;
          }
        }

        if (candidates.length === 0) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const anchorParents = [];
          let currentNode = walker.nextNode();
          while (currentNode) {
            if (normalize(currentNode.textContent).includes(cartIdNorm)) {
              if (currentNode.parentElement) {
                anchorParents.push(currentNode.parentElement);
              }
              if (anchorParents.length >= 20) {
                break;
              }
            }
            currentNode = walker.nextNode();
          }

          for (const parent of anchorParents) {
            let node = parent;
            for (let depth = 0; node && depth < 4; depth += 1) {
              for (const checkbox of queryAll(node, checkboxSelector)) {
                addCandidate(checkbox, `text_depth_${depth}`);
              }
              node = node.parentElement;
            }
          }
        }

        const visibleCandidates = candidates.filter((entry) => isVisible(entry.el));
        let target =
          visibleCandidates.find((entry) => checkboxState(entry.el) === true) ||
          visibleCandidates.find((entry) => checkboxState(entry.el) === null) ||
          visibleCandidates[0] ||
          null;

        if (!target) {
          const globalChecked = queryAll(
            document,
            "input[type='checkbox'], [role='checkbox']"
          ).filter((entry) => isVisible(entry) && checkboxState(entry) === true);
          if (globalChecked.length === 1) {
            target = {
              el: globalChecked[0],
              source: "global_unique_checked"
            };
          } else {
            return {
              status: "not_found",
              rowMatches: rows.length,
              candidateCount: candidates.length,
              globalCheckedCount: globalChecked.length
            };
          }
        }

        const before = checkboxState(target.el);
        if (before === false) {
          return {
            status: "already_unchecked",
            source: target.source
          };
        }

        clickToggle(target.el);
        const after = checkboxState(target.el);
        if (after === false) {
          return {
            status: "unchecked",
            source: target.source
          };
        }
        if (after === true) {
          return {
            status: "still_checked",
            source: target.source
          };
        }

        return {
          status: before === null ? "clicked_unknown_state" : "state_unknown_after_click",
          source: target.source
        };
      },
      {
        targetCartId: cartIdText,
        rowSelector: config.vsbCourseRowSelector,
        checkboxSelector: config.vsbCourseCheckboxSelector
      }
    );

    if (result.status === "unchecked") {
      logInfo(`[vsb] Unchecked course checkbox for ${cartIdText}.`);
      return;
    }
    if (result.status === "already_unchecked") {
      logInfo(`[vsb] Course checkbox already unchecked for ${cartIdText}.`);
      return;
    }
    if (result.status === "still_checked") {
      logInfo(
        `[vsb] Attempted to uncheck checkbox for ${cartIdText}, but it is still checked.`
      );
      return;
    }
    if (
      result.status === "clicked_unknown_state" ||
      result.status === "state_unknown_after_click"
    ) {
      logInfo(
        `[vsb] Clicked checkbox for ${cartIdText}, but could not reliably read post-click state.`
      );
      return;
    }

    logInfo(
      `[vsb] Could not locate a unique checkbox for ${cartIdText} (rows=${result.rowMatches || 0}, candidates=${result.candidateCount || 0}, globallyChecked=${result.globalCheckedCount || 0}).`
    );
  }

  async function searchAndSelectCourse(cartId, { applyUncheck = true } = {}) {
    const searchInput = page.locator(config.vsbSearchSelector).first();
    const cartIdText = String(cartId).trim();

    logInfo(`[vsb] Searching for course: ${cartIdText}`);
    
    await searchInput.click({ timeout: config.vsbSearchTimeoutMs });
    await searchInput.fill("");
    await searchInput.fill(cartIdText);
    await page.waitForTimeout(500);

    logInfo(`[vsb] Course code entered. Waiting for dropdown...`);
    
    const options = page.locator(config.vsbDropdownOptionSelector);
    try {
      await options
        .first()
        .waitFor({ state: "visible", timeout: config.vsbDropdownTimeoutMs });

      const matchingOption = options.filter({ hasText: cartIdText }).first();
      if ((await matchingOption.count()) > 0) {
        logInfo(`[vsb] Found matching option, clicking...`);
        await matchingOption.click();
      } else {
        logInfo(`[vsb] No exact match, clicking first option...`);
        await options.first().click();
      }
    } catch (_) {
      logInfo(`[vsb] No dropdown found, pressing Enter...`);
      await searchInput.press("Enter");
    }

    if (applyUncheck) {
      await page.waitForTimeout(600);
      try {
        await uncheckCourseCheckbox(cartIdText);
      } catch (error) {
        logInfo(`[vsb] Warning: failed to uncheck checkbox for ${cartIdText}: ${error.message}`);
      }
    }
  }

  async function searchSelectAndRefresh(cartId) {
    await searchAndSelectCourse(cartId, { applyUncheck: true });

    await page.waitForTimeout(1000);
    logInfo(`[vsb] Reloading page to capture JSP response...`);
    await page.reload({ waitUntil: "load" });
  }

  async function refreshOnlyForCapture(cartId) {
    const cartIdText = String(cartId || "").trim();
    if (cartIdText) {
      logInfo(`[vsb] ${cartIdText} already present; refreshing page for JSP capture...`);
    } else {
      logInfo("[vsb] Refreshing page for JSP capture...");
    }
    await page.reload({ waitUntil: "load" });
  }

  async function isCoursePresentInWindow(cartId) {
    const cartIdText = String(cartId).trim();
    if (!cartIdText) {
      return false;
    }

    const cached = getCoursePresenceCache(cartIdText);
    if (cached && cached.isPresent) {
      return true;
    }

    try {
      const presentByDom = await page.evaluate(
        ({ targetCartId, presenceSelector, tokenPattern }) => {
          const cartIdNorm = String(targetCartId || "")
            .trim()
            .toUpperCase();
          if (!cartIdNorm) {
            return false;
          }

          function isVisible(el) {
            if (!el) {
              return false;
            }
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
              return false;
            }
            const style = window.getComputedStyle(el);
            return style.display !== "none" && style.visibility !== "hidden";
          }

          const tokenRegex = new RegExp(tokenPattern, "i");
          const candidates = (() => {
            try {
              return Array.from(document.querySelectorAll(presenceSelector));
            } catch (_) {
              return [];
            }
          })();

          for (const node of candidates) {
            if (!isVisible(node)) {
              continue;
            }
            const text = String(node.textContent || "").toUpperCase();
            if (tokenRegex.test(text)) {
              return true;
            }
          }

          return false;
        },
        {
          targetCartId: cartIdText,
          presenceSelector: config.vsbCoursePresenceSelector,
          tokenPattern: `(^|[^A-Z0-9])${escapeRegExp(cartIdText.toUpperCase())}([^A-Z0-9]|$)`
        }
      );
      if (presentByDom) {
        setCoursePresenceCache(cartIdText, true, "dom_visible_match");
      }
      return presentByDom;
    } catch (_) {
      return false;
    }
  }

  async function syncTrackedCoursesInBrowser() {
    if (!config.vsbSyncTrackedCoursesOnStart || hasSyncedTrackedCoursesForContext) {
      return;
    }

    const trackedRows = await db.listTrackedCourses();
    const uniqueCartIds = [];
    const seen = new Set();
    for (const row of trackedRows) {
      const cartId = String(row.cart_id || "").trim();
      if (!cartId || seen.has(cartId)) {
        continue;
      }
      seen.add(cartId);
      uniqueCartIds.push(cartId);
      if (uniqueCartIds.length >= config.vsbSyncTrackedCoursesLimit) {
        break;
      }
    }

    if (uniqueCartIds.length === 0) {
      hasSyncedTrackedCoursesForContext = true;
      return;
    }

    let allSynced = true;
    logInfo(`[vsb] Syncing ${uniqueCartIds.length} tracked course(s) into VSB page...`);
    for (const cartId of uniqueCartIds) {
      try {
        const exists = await isCoursePresentInWindow(cartId);
        if (exists) {
          setCoursePresenceCache(cartId, true, "sync_precheck_present");
          continue;
        }
        logInfo(`[vsb] ${cartId} missing in VSB page; adding...`);
        await searchAndSelectCourse(cartId, { applyUncheck: true });
        await page.waitForTimeout(350);

        const existsAfterAdd = await isCoursePresentInWindow(cartId);
        if (!existsAfterAdd) {
          setCoursePresenceCache(cartId, false, "sync_post_add_absent");
          allSynced = false;
          logInfo(`[vsb] ${cartId} still not visible after add attempt; will retry later.`);
        } else {
          setCoursePresenceCache(cartId, true, "sync_post_add_present");
        }
      } catch (error) {
        setCoursePresenceCache(cartId, false, "sync_error");
        allSynced = false;
        logInfo(`[vsb] Warning: failed to sync tracked course ${cartId}: ${error.message}`);
      }
    }

    hasSyncedTrackedCoursesForContext = allSynced;
    if (!allSynced) {
      logInfo("[vsb] Tracked-course sync incomplete; will retry on next refresh.");
    }
  }

  async function collectGetClassDataCandidates({ cartId, forceRefresh = false } = {}) {
    const refreshWindowMs = config.vsbRefreshIntervalMinutes * 60 * 1000;
    const latestStored = await db.getSharedLatestJspFile();
    const latestStoredCandidate = mapDbJspRowToCandidate(latestStored);
    const hasFreshStoredFile =
      latestStoredCandidate &&
      isWithinRefreshWindow(latestStoredCandidate.generatedAt, refreshWindowMs);

    if (!forceRefresh && hasFreshStoredFile) {
      // Keep the browser window open between scans while reusing fresh cached JSP.
      await ensureBrowser();
      if (!hasSyncedTrackedCoursesForContext) {
        await ensureSessionReady();
      }
      if (latestStoredCandidate && cartId) {
        recordPresenceFromCandidate(cartId, latestStoredCandidate);
      }
      return [latestStoredCandidate];
    }

    await ensureSessionReady();

    // Click on Fall/Winter radio button before adding course
    try {
      const allRadios = page.locator(config.vsbFallWinterSelector);
      const radioCount = await allRadios.count();
      
      if (radioCount >= 2) {
        // There are typically 2 radio buttons: Summer (first) and Fall/Winter (second)
        // Click the Fall/Winter button (index 1, or .last())
        const fallWinterRadio = allRadios.nth(1);
        const isAlreadyChecked = await fallWinterRadio.isChecked().catch(() => false);
        
        if (!isAlreadyChecked) {
          logInfo("[vsb] Clicking Fall/Winter 2025-2026 radio button...");
          await fallWinterRadio.click({ timeout: config.vsbSearchTimeoutMs });
          await page.waitForTimeout(800);
          logInfo("[vsb] Fall/Winter term selected successfully.");
        } else {
          logInfo("[vsb] Fall/Winter term already selected.");
        }
      } else {
        logInfo("[vsb] Expected 2 session radio buttons, found " + radioCount);
      }
    } catch (e) {
      logInfo("[vsb] Warning: Could not select Fall/Winter term:", e.message);
    }

    const cartIdText = String(cartId || "").trim();
    let attemptedRefreshOnly = false;
    let candidates = await withGetClassCapture(async () => {
      const isPresent = cartIdText ? await isCoursePresentInWindow(cartIdText) : false;
      if (isPresent) {
        attemptedRefreshOnly = true;
        await refreshOnlyForCapture(cartIdText);
        return;
      }
      await searchSelectAndRefresh(cartIdText);
    });

    if (attemptedRefreshOnly && cartIdText && candidates.length === 0) {
      logInfo(
        `[vsb] No JSP captured on refresh-only for ${cartIdText}; trying targeted search capture.`
      );
      candidates = await withGetClassCapture(async () => {
        await searchSelectAndRefresh(cartIdText);
      });
    }

    if (candidates.length === 0) {
      if (latestStoredCandidate && hasFreshStoredFile) {
        logInfo("[vsb] No fresh JSP captured; reusing fresh cached JSP.");
        if (cartId) {
          recordPresenceFromCandidate(cartId, latestStoredCandidate);
        }
        return [latestStoredCandidate];
      }
      throw new Error("No getClassData.jsp response captured from VSB network and no fresh cached JSP is available.");
    }

    if (cartId) {
      const latestCandidate = pickLatestJspFile(candidates);
      if (latestCandidate) {
        recordPresenceFromCandidate(cartId, latestCandidate);
      }
    }

    await db.markSharedSessionOk({
      sessionDurationMinutes: config.sessionDurationMinutes
    });

    return candidates;
  }

  async function initLoginSession() {
    await ensureBrowser();
    hasSyncedTrackedCoursesForContext = false;
    clearCoursePresenceCache();
    await page.goto(config.vsbUrl, { waitUntil: "domcontentloaded" });

    const autoResult = await attemptAutoRelogin("init_login_session");
    if (autoResult.ok) {
      return { status: "session_ok_auto" };
    }

    logInfo(
      `[vsb] Login required. Please login in the opened browser window. Waiting up to ${config.vsbLoginWaitSeconds} seconds.`
    );

    try {
      await page
        .locator(config.vsbSearchSelector)
        .first()
        .waitFor({
          state: "visible",
          timeout: config.vsbLoginWaitSeconds * 1000
        });
    } catch (_) {
      if (await isLoggedOutScreenVisible()) {
        throw new Error("VSB login not completed: login UI is still visible.");
      }
      logInfo(
        "[vsb] Enter Course selector not detected after login wait. Continuing with manual session fallback."
      );
    }

    await db.markSharedSessionOk({
      sessionDurationMinutes: config.sessionDurationMinutes
    });
    return { status: "session_ok" };
  }

  async function close() {
    await resetBrowserState();
  }

  async function tryAutoRelogin({ reason } = {}) {
    const result = await attemptAutoRelogin(reason || "monitor_session_check");
    return result;
  }

  return {
    collectGetClassDataCandidates,
    pickLatestJspFile,
    initLoginSession,
    tryAutoRelogin,
    close
  };
}

module.exports = {
  createVsbBrowserSource,
  pickLatestJspFile
};
