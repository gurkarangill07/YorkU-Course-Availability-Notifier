const LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function normalizeLevel(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LEVEL_PRIORITY, normalized)) {
    return normalized;
  }
  return "info";
}

function normalizeFormat(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "json") {
    return "json";
  }
  return "text";
}

function removeUndefinedFields(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function normalizeError(error) {
  if (error === undefined || error === null) {
    return {};
  }
  if (!(error instanceof Error)) {
    return removeUndefinedFields({
      errorName:
        typeof error === "object" && error && typeof error.name === "string"
          ? error.name
          : "Error",
      errorMessage:
        typeof error === "object" && error && typeof error.message === "string"
          ? error.message
          : String(error),
      errorCode:
        typeof error === "object" && error && error.code !== undefined
          ? error.code
          : null
    });
  }
  return removeUndefinedFields({
    errorName: error.name || "Error",
    errorMessage: error.message || String(error),
    errorCode: error.code || null,
    errorStack: error.stack || null
  });
}

function formatFieldValue(value) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return JSON.stringify(String(value));
  }
}

function formatTextLine(entry) {
  const { ts, level, component, event, message, ...rest } = entry;
  const head = [
    `[${ts}]`,
    level.toUpperCase(),
    component || "app",
    event || "log",
    message || ""
  ]
    .filter(Boolean)
    .join(" ");

  const fields = Object.entries(rest)
    .map(([key, value]) => `${key}=${formatFieldValue(value)}`)
    .join(" ");

  return fields ? `${head} ${fields}` : head;
}

function writeLine(level, line) {
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

function createLogger({
  component = "app",
  env = process.env,
  level,
  format,
  defaultFields = {}
} = {}) {
  const minLevel = normalizeLevel(level || env.LOG_LEVEL || "info");
  const minPriority = LEVEL_PRIORITY[minLevel];
  const outputFormat = normalizeFormat(format || env.LOG_FORMAT || "text");
  const sharedFields = removeUndefinedFields(defaultFields);

  function isEnabled(targetLevel) {
    return LEVEL_PRIORITY[targetLevel] >= minPriority;
  }

  function emit(targetLevel, message, fields = {}) {
    if (!isEnabled(targetLevel)) {
      return;
    }

    const hasMessage = message !== undefined && message !== null;
    const text = (hasMessage ? String(message) : "").trim() || "(no message)";
    const mergedFields = removeUndefinedFields({
      ...sharedFields,
      ...fields
    });

    const errorFields = normalizeError(mergedFields.error);
    delete mergedFields.error;

    const entry = removeUndefinedFields({
      ts: new Date().toISOString(),
      level: targetLevel,
      component,
      event: mergedFields.event || null,
      message: text,
      ...mergedFields,
      ...errorFields
    });

    const line =
      outputFormat === "json" ? JSON.stringify(entry) : formatTextLine(entry);
    writeLine(targetLevel, line);
  }

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    isLevelEnabled: (value) => isEnabled(normalizeLevel(value)),
    child: (childFields = {}) =>
      createLogger({
        component,
        env,
        level: minLevel,
        format: outputFormat,
        defaultFields: {
          ...sharedFields,
          ...removeUndefinedFields(childFields)
        }
      })
  };
}

module.exports = {
  createLogger
};
