const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCourseFromJsp } = require("../src/jspParser");

test("parseCourseFromJsp parses direct JSON payload", () => {
  const payload = JSON.stringify([
    {
      cartid: "ABC123",
      os: 4,
      code: "MATH 1010"
    }
  ]);

  const parsed = parseCourseFromJsp(payload, "ABC123");
  assert.equal(parsed.os, 4);
  assert.equal(parsed.courseName, "MATH 1010");
});

test("parseCourseFromJsp parses embedded JSON array inside wrapper text", () => {
  const payload = `callback(\n[{\"cartid\":\"XYZ789\",\"os\":1,\"courseName\":\"EECS 1001\"}]\n)`;

  const parsed = parseCourseFromJsp(payload, "XYZ789");
  assert.equal(parsed.os, 1);
  assert.equal(parsed.courseName, "EECS 1001");
});

test("parseCourseFromJsp parses xml-like tags", () => {
  const payload = `
    <course code="BIOL 2020">
      <section cartid="QWE111" os="2"/>
    </course>
  `;

  const parsed = parseCourseFromJsp(payload, "QWE111");
  assert.equal(parsed.os, 2);
  assert.equal(parsed.courseName, "BIOL 2020");
});

test("parseCourseFromJsp falls back to regex parser", () => {
  const payload = `
    <course code="HIST 3000" title="History">
      <item cartid="LMN555"></item>
      os="0"
    </course>
  `;

  const parsed = parseCourseFromJsp(payload, "LMN555");
  assert.equal(parsed.os, 0);
  assert.equal(parsed.courseName, "HIST 3000");
});

test("parseCourseFromJsp throws when cart id cannot be found", () => {
  const payload = JSON.stringify([{ cartid: "NOT_THIS_ONE", os: 1, code: "CHEM" }]);

  assert.throws(
    () => parseCourseFromJsp(payload, "MISSING123"),
    /Could not locate cartid MISSING123/
  );
});

test("parseCourseFromJsp throws on empty payload", () => {
  assert.throws(() => parseCourseFromJsp("   ", "ABC"), /JSP payload is empty/);
});
