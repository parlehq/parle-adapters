import assert from "node:assert/strict";
import test from "node:test";
import { assertClientInstanceId } from "../dist/process-instance.js";

test("reported client instances accept only canonical UUIDv4 and UUIDv7", () => {
  assert.equal(assertClientInstanceId("11111111-1111-4111-8111-111111111111"), "11111111-1111-4111-8111-111111111111");
  assert.equal(assertClientInstanceId("11111111-1111-7111-8111-111111111111"), "11111111-1111-7111-8111-111111111111");
  assert.throws(() => assertClientInstanceId("11111111-1111-1111-8111-111111111111"), /UUIDv4 or UUIDv7/);
});
