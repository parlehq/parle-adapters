import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const source = await jiti.import(pathToFileURL(resolve("src/index.ts")).href);

function isolatedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PARLE_")) delete env[key];
  return { ...env, ...overrides };
}

test("one native mod registers Parle tools, guidance, lifecycle hooks, and status command", async () => {
  const tools = [];
  const commands = [];
  let hooks;
  let activeTools = [];
  const cmd = {
    cwd: "/tmp/parle-command-code-native",
    session: { appendCustomMessageEntry() {} },
    ui: { setStatus() {}, notify() {} },
    addTool(tool) { tools.push(tool); activeTools.push(tool.schema.name); return { dispose() {} }; },
    addCommand(command) { commands.push(command); return { dispose() {} }; },
    hooks(value) { hooks = value; return { dispose() {} }; },
    getActiveTools() { return activeTools; },
    setActiveTools(names) { activeTools = [...names]; },
  };

  await source.registerCommandCodeMod(cmd, isolatedEnv({ HOME: "/tmp/parle-command-code-empty-home", PARLE_PROFILE: "missing-profile" }));

  const names = tools.map((tool) => tool.schema.name);
  assert.equal(names.includes("parle_status"), true);
  assert.equal(names.includes("parle_connect"), true);
  assert.equal(names.includes("parle_send"), true);
  assert.equal(names.includes("parle_reply"), true);
  assert.equal(names.includes("parle_saved_start"), true);
  assert.equal(names.includes("parle_session_alias"), true);
  assert.equal(names.includes("parle_switch_profile"), false);
  assert.equal(names.length >= 20, true);
  assert.equal(tools.every((tool) => Array.isArray(tool.schema.input_schema.required)), true);
  assert.deepEqual(commands.map((command) => command.name), ["parle-status"]);
  assert.match(hooks.appendSystemPrompt(), /native Command Code tools/);
  assert.match(hooks.appendSystemPrompt(), /untrusted text/);
  assert.match(hooks.appendSystemPrompt(), /host_instruction\.next/);
  assert.equal(typeof hooks.onSessionStart, "function");
  assert.equal(typeof hooks.onTurnStart, "function");
  assert.equal(typeof hooks.onStop, "function");
  assert.equal(typeof hooks.onRunEnd, "function");
  assert.equal(typeof hooks.onSessionEnd, "function");
  hooks.onSessionStart();
  assert.deepEqual(activeTools.sort(), ["parle_delete_profile", "parle_setup", "parle_status"]);
});

test("root and package manifests expose only the native mod", () => {
  const root = JSON.parse(readFileSync(resolve("../../package.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  assert.deepEqual(root.commandcode.mods, ["./packages/command-code/mods/parle.ts"]);
  assert.deepEqual(pkg.commandcode.mods, ["./mods/parle.ts"]);
  assert.equal(pkg.version, "0.7.24");
  assert.match(readFileSync(resolve("src/index.ts"), "utf8"), new RegExp(`ADAPTER_VERSION = "${pkg.version}"`));

  const artifact = readFileSync(resolve("mods/parle.ts"), "utf8");
  assert.match(artifact, /appendCustomMessageEntry/);
  assert.match(artifact, /addTool/);
  assert.doesNotMatch(artifact, /cmd mcp add/);
  assert.doesNotMatch(artifact, /cmd skills add/);
  assert.doesNotMatch(artifact, /hook-bridge/);
});

test("responsive delivery persists before it is folded into the next turn", async () => {
  const writes = [];
  const projected = { role: "user", content: [{ type: "text", text: "server framed" }] };
  const cmd = {
    cwd: "/tmp/parle-command-code-delivery",
    session: {
      appendCustomMessageEntry(value) {
        writes.push(value);
        ordering.push("append");
        return { entryId: "entry-1", message: projected };
      },
    },
  };
  const fakeClient = { runtime: {}, clientInstanceId: "test-client" };
  const delivery = new source.NativeResponsiveDelivery(cmd, fakeClient, () => {});
  const ordering = [];
  let ackSucceeds = false;
  delivery.controller.completeDeferred = async () => {
    ordering.push("ack");
    return ackSucceeds;
  };

  const outcome = await delivery.handleDelivery({
    roomId: "room-1",
    message: {
      seq: 7,
      event_id: "event-7",
      content: "trusted framing\nFENCED BODY",
      clientReplyPresentation: { lines: ["reply_route_id: route-1"] },
    },
  });

  assert.equal(outcome, "deferred");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].customType, "parle/responsive-delivery");
  assert.equal(writes[0].display, true);
  assert.match(writes[0].content, /trusted framing/);
  assert.equal(delivery.status().pending, 1);

  const state = { messages: [{ role: "user", content: [] }] };
  const next = delivery.foldPending(state);
  assert.deepEqual(next.messages, [...state.messages, projected]);
  assert.equal(delivery.status().pending, 1);
  assert.deepEqual(ordering, ["append"]);
  await delivery.completeFolded();
  assert.deepEqual(ordering, ["append", "ack"]);
  assert.equal(delivery.status().pending, 1, "failed acknowledgement retains deferred work without re-appending");
  ackSucceeds = true;
  await delivery.completeFolded();
  assert.deepEqual(ordering, ["append", "ack", "ack"]);
  assert.equal(delivery.status().pending, 0);
});

test("baseline skips replaced exact-session backlog but preserves alias delivery", async () => {
  const writes = [];
  const cmd = {
    cwd: "/tmp/parle-command-code-baseline",
    session: { appendCustomMessageEntry(value) { writes.push(value); return { entryId: "alias-1", message: { role: "user", content: [] } }; } },
  };
  const delivery = new source.NativeResponsiveDelivery(cmd, { runtime: {}, clientInstanceId: "test-client" }, () => {});
  delivery.baselineActive = true;
  const sessionOutcome = await delivery.handleDelivery({ roomId: "room-1", cursorScope: "session", message: { seq: 1, event_id: "session-1", content: "old" } });
  const aliasOutcome = await delivery.handleDelivery({ roomId: "room-1", cursorScope: "alias", message: { seq: 2, event_id: "alias-1", content: "durable" } });
  assert.equal(sessionOutcome, "intentionally_skipped");
  assert.equal(aliasOutcome, "deferred");
  assert.equal(writes.length, 1);
  assert.equal(delivery.status().baselineSkipped, 1);
});

test("delivery retry does not reopen the completed baseline window", async () => {
  const writes = [];
  const cmd = {
    cwd: "/tmp/parle-command-code-baseline-retry",
    session: { appendCustomMessageEntry(value) { writes.push(value); return { entryId: `entry-${writes.length}`, message: { role: "user", content: [] } }; } },
  };
  const client = { runtime: {}, clientInstanceId: "test-client", async ensureReadySafe() {} };
  const delivery = new source.NativeResponsiveDelivery(cmd, client, () => {});
  let starts = 0;
  delivery.controller.start = async () => {
    starts += 1;
    return delivery.handleDelivery({ roomId: "room-1", cursorScope: "session", message: { seq: starts, event_id: `event-${starts}`, content: "message" } });
  };

  await delivery.start();
  await delivery.start();

  assert.equal(delivery.status().baselineSkipped, 1);
  assert.equal(writes.length, 1, "rows found after the successful baseline are queued rather than skipped");
  assert.equal(delivery.status().pending, 1);
});

test("session replacement retains deferred work for the replacement turn", async () => {
  const projected = { role: "user", content: [{ type: "text", text: "retained" }] };
  const cmd = {
    cwd: "/tmp/parle-command-code-replaced",
    session: { appendCustomMessageEntry() { return { entryId: "entry-1", message: projected }; } },
  };
  const delivery = new source.NativeResponsiveDelivery(cmd, { runtime: {}, clientInstanceId: "test-client" }, () => {});
  await delivery.handleDelivery({ roomId: "room-1", message: { seq: 1, event_id: "event-1", content: "retained" } });
  delivery.foldPending({ messages: [] });
  delivery.retainForReplacement();
  const replacement = delivery.foldPending({ messages: [] });
  assert.deepEqual(replacement.messages, [projected]);
  assert.equal(delivery.status().pending, 1);
});

test("repeated start preserves persisted success and backoff evidence", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-command-code-evidence-"));
  try {
    const client = { runtime: { agentSessionId: "agent-1" }, clientInstanceId: "test-client", async ensureReadySafe() {} };
    const delivery = new source.NativeResponsiveDelivery({ cwd, session: { appendCustomMessageEntry() {} } }, client, () => {});
    let running = false;
    delivery.controller.status = () => ({ running });
    delivery.controller.start = async () => { running = true; };

    await delivery.start();
    const evidencePath = join(cwd, ".parle", "runtime", "responsive", `${process.pid}.json`);
    const watching = readFileSync(evidencePath, "utf8");
    const watchingSnapshot = JSON.parse(watching);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await delivery.start();
    const watchingAfterStatus = readFileSync(evidencePath, "utf8");
    assert.equal(watchingAfterStatus, watching, "plain status startup preserves persisted watching evidence byte-for-byte");
    assert.equal(JSON.parse(watchingAfterStatus).updatedAt, watchingSnapshot.updatedAt);
    assert.equal(JSON.parse(watchingAfterStatus).lastSuccessAt, watchingSnapshot.lastSuccessAt);

    delivery.handleWakeError(new Error("stream ended unexpectedly"));
    const backoff = readFileSync(evidencePath, "utf8");
    const backoffSnapshot = JSON.parse(backoff);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await delivery.start();
    const backoffAfterStatus = readFileSync(evidencePath, "utf8");
    assert.equal(backoffAfterStatus, backoff, "plain status startup preserves persisted backoff evidence byte-for-byte");
    assert.equal(JSON.parse(backoffAfterStatus).updatedAt, backoffSnapshot.updatedAt);
    assert.equal(JSON.parse(backoffAfterStatus).lastSuccessAt, backoffSnapshot.lastSuccessAt);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a successful wake reopen clears stale error state and reports watching evidence", () => {
  const cmd = {
    cwd: "/tmp/parle-command-code-reopen",
    session: { appendCustomMessageEntry() {} },
    ui: { setStatus() {}, notify() {} },
  };
  let refreshes = 0;
  const delivery = new source.NativeResponsiveDelivery(cmd, { runtime: {}, clientInstanceId: "test-client" }, () => { refreshes += 1; });
  assert.equal(typeof delivery.controller.onWakeOpen, "function", "controller registers the wake-open policy");
  assert.equal(typeof delivery.controller.onWakeError, "function", "controller registers the wake-error policy");

  delivery.handleWakeError(new Error("stream ended unexpectedly"));
  assert.equal(delivery.status().lastError, "stream ended unexpectedly");
  assert.equal(delivery.status().terminalAction, undefined, "an ordinary wake failure never latches terminal state");

  delivery.handleWakeOpen();
  assert.equal(delivery.status().lastError, undefined, "a live stream supersedes the most recent failure");
  assert.equal(refreshes >= 2, true);
});

test("terminal wake errors latch once, name the recovery action, and clear on restart", async () => {
  const notices = [];
  const cmd = {
    cwd: "/tmp/parle-command-code-terminal",
    session: { appendCustomMessageEntry() {} },
    ui: { setStatus() {}, notify(message) { notices.push(message); } },
  };
  const client = { runtime: {}, clientInstanceId: "test-client", async ensureReadySafe() {} };
  const delivery = new source.NativeResponsiveDelivery(cmd, client, () => {});
  const terminal = Object.assign(new Error("agent token rejected"), { action: "reauthorize" });

  delivery.handleWakeError(terminal);
  delivery.handleWakeError(terminal);
  assert.equal(delivery.status().terminalAction, "reauthorize");
  assert.equal(delivery.status().lastError, "agent token rejected");
  assert.equal(notices.length, 1, "a repeated terminal error notifies once, not per retry");
  assert.match(notices[0], /parle_setup/);
  assert.match(notices[0], /parle_connect/);

  delivery.controller.start = async () => {};
  await delivery.start();
  assert.equal(delivery.status().terminalAction, undefined, "a successful start clears the terminal latch");
  assert.equal(delivery.status().lastError, undefined, "a successful start clears the stale error");
});

test("start after stop recreates the settled controller instead of reusing a dead loop", async () => {
  const cmd = {
    cwd: "/tmp/parle-command-code-restart",
    session: { appendCustomMessageEntry() {} },
    ui: { setStatus() {}, notify() {} },
  };
  const client = { runtime: {}, clientInstanceId: "test-client", async ensureReadySafe() {} };
  const delivery = new source.NativeResponsiveDelivery(cmd, client, () => {});
  const first = delivery.controller;
  first.start = async () => {};
  first.stop = async () => {};

  await delivery.start();
  assert.equal(delivery.controller, first, "an ordinary start keeps the controller and its dedupe memory");

  await delivery.stop();
  let restarted = 0;
  delivery.createController = () => ({ start: async () => { restarted += 1; }, stop: async () => {} });
  await delivery.start();
  assert.notEqual(delivery.controller, first, "a stopped controller is permanently aborted and must be replaced");
  assert.equal(restarted, 1, "the replacement controller starts exactly one wake loop");
});

test("degraded setup recovery restores native tools through the active-tool API", async () => {
  const home = mkdtempSync(join(tmpdir(), "parle-command-code-recovery-"));
  const tools = [];
  let hooks;
  let activeTools = [];
  const cmd = {
    cwd: home,
    session: { appendCustomMessageEntry() {} },
    ui: { setStatus() {}, notify() {} },
    addTool(tool) { tools.push(tool); activeTools.push(tool.schema.name); return { dispose() {} }; },
    addCommand() { return { dispose() {} }; },
    hooks(value) { hooks = value; return { dispose() {} }; },
    getActiveTools() { return activeTools; },
    setActiveTools(names) { activeTools = [...names]; },
  };
  try {
    await source.registerCommandCodeMod(cmd, isolatedEnv({ HOME: home, PARLE_PROFILE: "default" }));
    hooks.onSessionStart();
    assert.deepEqual(activeTools.sort(), ["parle_delete_profile", "parle_setup", "parle_status"]);
    mkdirSync(join(home, ".parle"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".parle", "profiles"), "[default]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_test\n", { mode: 0o600 });
    const setup = tools.find((tool) => tool.schema.name === "parle_setup");
    const result = await setup.run({ input: {} });
    assert.equal(result.ok, true);
    assert.equal(activeTools.includes("parle_connect"), true);
    assert.equal(activeTools.includes("parle_switch_profile"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("missing ModApi capabilities refuse registration visibly", async () => {
  const notices = [];
  await source.registerCommandCodeMod({ ui: { notify(message) { notices.push(message); } } }, isolatedEnv());
  assert.equal(notices.length, 1);
  assert.match(notices[0], /cmd\.addTool/);
});

test("footer reports an honest pending count and never claims idle wake", () => {
  const text = source.renderStatus({
    runtime: {
      sessionAddress: "@gilman.galexc.abcdefgh",
      rooms: [{ roomHandle: "workshop" }],
    },
  }, 2);
  assert.equal(text, "#workshop ✓ @gilman.galexc.abcdefgh · 2 pending");
});
