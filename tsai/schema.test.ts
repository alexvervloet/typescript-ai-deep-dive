/**
 * Tests for the boundary layer, written with Node's built-in test runner.
 *
 *     npm test          (which is just: node --test)
 *
 * No install, no config file, no plugin to teach the runner about TypeScript or
 * about ES modules. Node 22 finds `*.test.ts`, strips the types and runs it.
 * Example 10 uses this as its one clear case of Node's standard library being
 * ahead of Python's, where pytest is excellent and is a dependency.
 *
 * These particular tests exist because `stripFences` and `parseModelJson` are
 * the two functions in this repo that every example depends on and that handle
 * input nobody controls.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { parseModelJson, parseUnknown, stripFences, toJsonSchema } from "./schema.ts";
import { LookupOrderArgs } from "./tools.ts";

const Receipt = z.object({ merchant: z.string(), total: z.number() });

test("stripFences leaves clean JSON alone", () => {
  assert.equal(stripFences('{"a":1}'), '{"a":1}');
});

test("stripFences removes the fences models add anyway", () => {
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFences('```\n{"a":1}\n```'), '{"a":1}');
});

test("parseModelJson accepts a well-formed reply", () => {
  const result = parseModelJson('{"merchant":"Kaffee","total":7}', Receipt);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.total, 7);
});

test("parseModelJson rejects a number sent as a string", () => {
  const result = parseModelJson('{"merchant":"Kaffee","total":"7.00"}', Receipt);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /total/);
});

test("parseModelJson reports prose as prose, not as a crash", () => {
  const result = parseModelJson("I cannot read this receipt.", Receipt);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /not JSON/);
});

test("tool arguments must match the pattern, not just the type", () => {
  assert.equal(parseUnknown({ orderId: "A-1003" }, LookupOrderArgs).ok, true);
  assert.equal(parseUnknown({ orderId: "../../etc/passwd" }, LookupOrderArgs).ok, false);
  assert.equal(parseUnknown({ orderId: 1003 }, LookupOrderArgs).ok, false);
  assert.equal(parseUnknown({}, LookupOrderArgs).ok, false);
});

test("toJsonSchema drops $schema, which providers reject", () => {
  const json = toJsonSchema(Receipt);
  assert.equal("$schema" in json, false);
  assert.equal(json["type"], "object");
});
