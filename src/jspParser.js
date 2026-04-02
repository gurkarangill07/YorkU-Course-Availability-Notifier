function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readFirstValue(obj, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return obj[key];
    }
  }
  return undefined;
}

function tryJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractEmbeddedJsonArray(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return tryJsonParse(text.slice(start, end + 1));
}

function findObjectByCartId(node, cartId) {
  if (!node) {
    return null;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findObjectByCartId(item, cartId);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof node === "object") {
    const value = readFirstValue(node, ["cartid", "cartId", "cart_id", "courseCode", "course_code"]);
    if (value !== undefined && String(value).trim() === String(cartId).trim()) {
      return node;
    }
    for (const nested of Object.values(node)) {
      const found = findObjectByCartId(nested, cartId);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function parseFromObject(obj) {
  const osValue = readFirstValue(obj, ["os", "openSeats", "open_seats"]);
  const codeValue = readFirstValue(obj, ["code", "courseName", "course_name", "key", "name"]);
  const os = parseNumber(osValue);
  const courseName = codeValue ? String(codeValue).trim() : null;

  if (os === null) {
    return null;
  }

  return {
    os,
    courseName: courseName || "UNKNOWN_COURSE"
  };
}

function parseTagAttributes(tagText) {
  const attrs = {};
  const attrRegex = /\b([A-Za-z_:][A-Za-z0-9:._-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>/]+))/g;
  let match;
  while ((match = attrRegex.exec(tagText)) !== null) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    attrs[key] = value;
  }
  return attrs;
}

function findNearestParentCode(rawBody, fromIndex) {
  const windowBody = rawBody.slice(0, fromIndex);
  const codeTagRegex = /<[A-Za-z][A-Za-z0-9:_-]*\b[^>]*\bcode\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  let lastCode = null;
  while ((match = codeTagRegex.exec(windowBody)) !== null) {
    lastCode = String(match[1] || "").trim();
  }
  return lastCode || null;
}

function parseFromXmlLikeTag(rawBody, cartId) {
  const escapedCartId = escapeRegExp(String(cartId).trim());
  const tagRegex = new RegExp(
    `<[A-Za-z][^>]*\\bcartid\\s*=\\s*["']${escapedCartId}["'][^>]*>`,
    "gi"
  );

  let match;
  while ((match = tagRegex.exec(rawBody)) !== null) {
    const attrs = parseTagAttributes(match[0]);
    const osValue = attrs.os ?? attrs.openSeats ?? attrs.open_seats;
    const os = parseNumber(osValue);
    if (os === null) {
      continue;
    }

    const nearestParentCode = findNearestParentCode(rawBody, match.index);
    const courseName =
      attrs.code ||
      nearestParentCode ||
      attrs.courseName ||
      attrs.course_name ||
      attrs.key ||
      attrs.name ||
      attrs.disp ||
      String(cartId).trim();

    return {
      os,
      courseName: String(courseName).trim() || String(cartId).trim()
    };
  }

  return null;
}

function parseWithRegex(jspBody, cartId) {
  const cartIdText = String(cartId).trim();
  const cartIdIndex = jspBody.indexOf(cartIdText);
  if (cartIdIndex === -1) {
    return null;
  }

  // Look for os value near the cart ID
  const windowStart = Math.max(0, cartIdIndex - 500);
  const windowEnd = Math.min(jspBody.length, cartIdIndex + 300);
  const windowBody = jspBody.slice(windowStart, windowEnd);
  
  const osMatch = windowBody.match(/os\s*=\s*["']?(-?\d+)/);
  if (!osMatch) {
    return null;
  }

  const osValue = Number.parseInt(osMatch[1], 10);

  // Now search backwards for the parent <course> element that contains this cartid
  // Look for the nearest <course> tag before this cartid position
  const beforeCartId = jspBody.substring(0, cartIdIndex);
  const lastCourseIndex = beforeCartId.lastIndexOf('<course');
  
  if (lastCourseIndex === -1) {
    return { os: osValue, courseName: cartIdText };
  }

  // Extract the course element (up to its closing >)
  const courseTagEnd = jspBody.indexOf('>', lastCourseIndex);
  if (courseTagEnd === -1) {
    return { os: osValue, courseName: cartIdText };
  }

  const courseTag = jspBody.substring(lastCourseIndex, courseTagEnd + 1);

  // Extract code attribute from course tag
  const codeMatch = courseTag.match(/code\s*=\s*["']([^"']+)["']/);
  if (codeMatch) {
    return {
      os: osValue,
      courseName: codeMatch[1].trim()
    };
  }

  // Fallback to title attribute if code not found
  const titleMatch = courseTag.match(/title\s*=\s*["']([^"']+)["']/);
  if (titleMatch) {
    return {
      os: osValue,
      courseName: titleMatch[1].trim()
    };
  }

  return {
    os: osValue,
    courseName: cartIdText
  };
}

function parseCourseFromJsp(jspBody, cartId) {
  const raw = String(jspBody || "");
  if (!raw.trim()) {
    throw new Error("JSP payload is empty.");
  }

  const direct = tryJsonParse(raw);
  const embedded = direct ? null : extractEmbeddedJsonArray(raw);
  const candidateJson = direct || embedded;
  if (candidateJson) {
    const matchObject = findObjectByCartId(candidateJson, cartId);
    if (matchObject) {
      const parsed = parseFromObject(matchObject);
      if (parsed) {
        return parsed;
      }
    }
  }

  const xmlParsed = parseFromXmlLikeTag(raw, cartId);
  if (xmlParsed) {
    return xmlParsed;
  }

  const regexParsed = parseWithRegex(raw, cartId);
  if (regexParsed) {
    return regexParsed;
  }

  throw new Error(`Could not locate cartid ${cartId} with os in getClassData.jsp payload.`);
}

function parseAllCoursesFromXmlLike(rawBody) {
  const results = new Map();
  const tagRegex = /<[A-Za-z][^>]*\bcartid\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = tagRegex.exec(rawBody)) !== null) {
    const cartId = String(match[1] || "").trim();
    if (!cartId) {
      continue;
    }
    const attrs = parseTagAttributes(match[0]);
    const osValue = attrs.os ?? attrs.openSeats ?? attrs.open_seats;
    const os = parseNumber(osValue);
    if (os === null) {
      continue;
    }
    const nearestParentCode = findNearestParentCode(rawBody, match.index);
    const courseName =
      attrs.code ||
      nearestParentCode ||
      attrs.courseName ||
      attrs.course_name ||
      attrs.key ||
      attrs.name ||
      attrs.disp ||
      cartId;
    results.set(cartId, {
      cartId,
      os,
      courseName: String(courseName).trim() || cartId
    });
  }
  return Array.from(results.values());
}

function parseAllCoursesFromJsp(jspBody) {
  const raw = String(jspBody || "");
  if (!raw.trim()) {
    return [];
  }
  return parseAllCoursesFromXmlLike(raw);
}

module.exports = {
  parseCourseFromJsp,
  parseAllCoursesFromJsp
};
