import test from "node:test";
import assert from "node:assert/strict";
import { mergeParleHooks, removeParleHooks } from "../scripts/settings.mjs";

const command = "/home/test/.local/share/parle/command-code/parle-hook.mjs";

test("managed Parle hooks preserve unrelated Command Code settings and are idempotent", () => {
  const original = {
    theme: "dark",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/quality-gate", timeout: 30 }] }],
    },
  };
  const once = mergeParleHooks(original, command);
  const twice = mergeParleHooks(once, command);
  assert.deepEqual(twice, once);
  assert.equal(once.theme, "dark");
  assert.equal(once.hooks.Stop.length, 2);
  assert.equal(once.hooks.SessionStart.length, 1);
  assert.equal(once.hooks.PreToolUse.length, 1);
  assert.equal(once.hooks.PostToolUse.length, 1);
  assert.deepEqual(original.hooks.Stop, [{ hooks: [{ type: "command", command: "/usr/local/bin/quality-gate", timeout: 30 }] }]);

  assert.deepEqual(removeParleHooks(once, command), original);
});
