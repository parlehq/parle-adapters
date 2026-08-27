import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CODEX_QUEUE_WAKE_TRIGGER,
  CodexQueueWake,
  MIN_CODEX_QUEUE_VERSION,
  classifyQueueFailure,
  compareSemver,
  defaultExecFile,
  hostSubprocessEnv,
  parseCodexVersion,
  resolveCodexHostExecutable,
} from "../dist/codex-host.js";

const PARENT = 4242;
const CODEX = "/opt/codex/bin/codex";
const THREAD = "019f2946-aef5-77ad-a41d-747ce0fd6a1e";
const UID = typeof process.getuid === "function" ? process.getuid() : 501;

const ok = (stdout = "") => ({ stdout, stderr: "", code: 0, signal: null, ambiguous: false });
const failed = (code, stderr) => ({ stdout: "", stderr, code, signal: null, ambiguous: false });
const versionBanner = (version) => [(_file, args) => args[0] === "--version", ok(`codex-cli ${version}\n`)];

function fakeStat({ path = CODEX, uid = UID, mode = 0o755, file = true } = {}) {
  return (candidate) => {
    if (candidate !== path) throw Object.assign(new Error(`ENOENT: ${candidate}`), { code: "ENOENT" });
    return { uid, mode, isFile: () => file };
  };
}

function fakeExec(handlers, calls = []) {
  return async (file, args, options) => {
    calls.push({ file, args, options });
    for (const [matches, outcome] of handlers) {
      if (matches(file, args)) return typeof outcome === "function" ? outcome(file, args, options) : outcome;
    }
    throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
  };
}

function linuxDeps(overrides = {}) {
  return {
    platform: "linux",
    getuid: () => UID,
    readParentPid: () => PARENT,
    readlink: (path) => {
      assert.equal(path, `/proc/${PARENT}/exe`);
      return CODEX;
    },
    readFile: (path) => {
      assert.equal(path, `/proc/${PARENT}/cmdline`);
      return "codex\0";
    },
    stat: fakeStat(),
    execFile: fakeExec([versionBanner("0.150.1")]),
    env: { HOME: "/home/u", PATH: "/usr/bin", CODEX_HOME: "/home/u/.codex", PARLE_PROFILE: "leak", PARLE_ROOM_AGENT_TOKEN: "parle_agt_leak" },
    log: () => {},
    ...overrides,
  };
}

const psComm = (value) => [(file, args) => file === "/bin/ps" && args[1] === "comm=", ok(`${value}\n`)];
const psArgs = (value) => [(file, args) => file === "/bin/ps" && args[1] === "args=", ok(`${value}\n`)];
const lsofText = (path) => [(file) => file === "/usr/sbin/lsof", ok(`p${PARENT}\nftxt\nn${path}\nftxt\nn/usr/lib/dyld\n`)];

function darwinDeps(handlers, overrides = {}) {
  return linuxDeps({
    platform: "darwin",
    readlink: () => { throw new Error("no /proc on darwin"); },
    readFile: () => { throw new Error("no /proc on darwin"); },
    execFile: fakeExec([...handlers, versionBanner("0.150.1")]),
    ...overrides,
  });
}

async function flush() {
  for (let round = 0; round < 12; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

function wakeHarness({ queue = ok(), deps = {}, random = () => 0.5 } = {}) {
  const calls = [];
  const timers = [];
  const cleared = [];
  const logs = [];
  let now = 1_000_000;
  const queueOutcomes = Array.isArray(queue) ? [...queue] : [queue];
  const handlers = [
    versionBanner("0.150.1"),
    [(_file, args) => args[0] === "queue", () => (queueOutcomes.length > 1 ? queueOutcomes.shift() : queueOutcomes[0])],
  ];
  const wake = new CodexQueueWake(PARENT, {
    ...linuxDeps({ execFile: fakeExec(handlers, calls), log: (event) => logs.push(event) }),
    now: () => now,
    random,
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, id: timers.length + 1 };
      timers.push(timer);
      return timer.id;
    },
    clearTimer: (timer) => cleared.push(timer),
    ...deps,
  });
  return {
    wake,
    calls,
    timers,
    cleared,
    logs,
    queueCalls: () => calls.filter((call) => call.args[0] === "queue"),
    advance: (ms) => { now += ms; },
  };
}

test("codex host discovery verifies the direct parent on Linux and hands it a host-only environment", async () => {
  const calls = [];
  const deps = linuxDeps({ execFile: fakeExec([versionBanner("0.150.1")], calls) });
  const resolution = await resolveCodexHostExecutable(PARENT, deps);
  assert.deepEqual(resolution, { ok: true, executable: { path: CODEX, version: "0.150.1", parentPid: PARENT } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, CODEX);
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.deepEqual(calls[0].options.env, { HOME: "/home/u", PATH: "/usr/bin", CODEX_HOME: "/home/u/.codex" });
  assert.deepEqual(Object.keys(hostSubprocessEnv({ PARLE_API_BASE: "x", HOME: "/h", TERM: "xterm" })), ["HOME", "TERM"]);
});

test("codex host discovery on macOS accepts an absolute ps comm and falls back to lsof for a PATH-launched host", async () => {
  const absolute = await resolveCodexHostExecutable(PARENT, darwinDeps([psComm(CODEX), psArgs("codex")]));
  assert.deepEqual(absolute, { ok: true, executable: { path: CODEX, version: "0.150.1", parentPid: PARENT } });

  const calls = [];
  const viaLsof = await resolveCodexHostExecutable(PARENT, darwinDeps([psComm("codex"), lsofText(CODEX), psArgs("codex")], { execFile: fakeExec([psComm("codex"), lsofText(CODEX), psArgs("codex"), versionBanner("0.150.1")], calls) }));
  assert.deepEqual(viaLsof, { ok: true, executable: { path: CODEX, version: "0.150.1", parentPid: PARENT } });
  assert.deepEqual(calls.map((call) => call.file), ["/bin/ps", "/usr/sbin/lsof", "/bin/ps", CODEX]);
  assert.deepEqual(calls[1].args, ["-a", "-p", String(PARENT), "-d", "txt", "-Fn"]);

  const noText = await resolveCodexHostExecutable(PARENT, darwinDeps([psComm("codex"), [(file) => file === "/usr/sbin/lsof", ok(`p${PARENT}\n`)], psArgs("codex")]));
  assert.equal(noText.ok, false);
  assert.equal(noText.reason, "parent-not-codex");
});

test("codex host discovery refuses a relative path, remote topology, wrong uid, non-executable, and a changed parent", async () => {
  const relative = await resolveCodexHostExecutable(PARENT, linuxDeps({ readlink: () => "codex" }));
  assert.equal(relative.ok, false);
  assert.equal(relative.reason, "parent-not-codex");

  const remoteLinux = await resolveCodexHostExecutable(PARENT, linuxDeps({ readFile: () => "codex\0--remote\0ws://10.0.0.5:4500\0" }));
  assert.deepEqual(remoteLinux, { ok: false, reason: "remote-topology" });
  const remoteDarwin = await resolveCodexHostExecutable(PARENT, darwinDeps([psComm(CODEX), psArgs("codex --remote=ws://10.0.0.5:4500")]));
  assert.deepEqual(remoteDarwin, { ok: false, reason: "remote-topology" });

  assert.deepEqual(await resolveCodexHostExecutable(PARENT, linuxDeps({ stat: fakeStat({ uid: UID + 1 }) })), { ok: false, reason: "wrong-uid" });
  assert.deepEqual(await resolveCodexHostExecutable(PARENT, linuxDeps({ stat: fakeStat({ mode: 0o644 }) })), { ok: false, reason: "not-executable" });
  assert.deepEqual(await resolveCodexHostExecutable(PARENT, linuxDeps({ stat: fakeStat({ file: false }) })), { ok: false, reason: "not-executable" });
  const missing = await resolveCodexHostExecutable(PARENT, linuxDeps({ stat: fakeStat({ path: "/elsewhere" }) }));
  assert.equal(missing.reason, "not-executable");

  assert.deepEqual(await resolveCodexHostExecutable(PARENT, linuxDeps({ readParentPid: () => PARENT + 1 })), { ok: false, reason: "parent-changed" });
  // PID reuse between the executable check and the version probe.
  let reads = 0;
  const changedMidway = await resolveCodexHostExecutable(PARENT, linuxDeps({ readParentPid: () => (reads++ === 0 ? PARENT : 1) }));
  assert.deepEqual(changedMidway, { ok: false, reason: "parent-changed" });

  const crashed = await resolveCodexHostExecutable(PARENT, linuxDeps({ execFile: fakeExec([[() => true, failed(1, "boom")]]) }));
  assert.equal(crashed.ok, false);
  assert.equal(crashed.reason, "parent-not-codex");
});

test("codex version gate rejects 0.147.0, accepts 0.149.0 and 0.150.1, and rejects a non-codex banner", async () => {
  assert.equal(MIN_CODEX_QUEUE_VERSION, "0.149.0");
  assert.equal(parseCodexVersion("codex-cli 0.150.1\n"), "0.150.1");
  assert.equal(parseCodexVersion("v25.9.0\n"), undefined);
  assert.equal(compareSemver("0.149.0", "0.149.0"), 0);
  assert.equal(compareSemver("0.147.0", "0.149.0"), -1);
  assert.equal(compareSemver("0.150.1", "0.149.0"), 1);
  assert.equal(compareSemver("1.0.0", "0.999.999"), 1);
  for (const [version, expected] of [
    ["0.147.0", { ok: false, reason: "version-too-old", detail: "0.147.0" }],
    ["0.148.9", { ok: false, reason: "version-too-old", detail: "0.148.9" }],
    ["0.149.0", { ok: true, executable: { path: CODEX, version: "0.149.0", parentPid: PARENT } }],
    ["0.150.1", { ok: true, executable: { path: CODEX, version: "0.150.1", parentPid: PARENT } }],
  ]) {
    assert.deepEqual(await resolveCodexHostExecutable(PARENT, linuxDeps({ execFile: fakeExec([versionBanner(version)]) })), expected, version);
  }
  const node = await resolveCodexHostExecutable(PARENT, linuxDeps({ execFile: fakeExec([[() => true, ok("v25.9.0\n")]]) }));
  assert.deepEqual(node, { ok: false, reason: "parent-not-codex", detail: "no codex-cli version banner" });
});

test("an installed codex binary passes the real discovery path (smoke; skipped when absent)", async (context) => {
  const candidate = join(homedir(), ".local", "bin", "codex");
  if (!existsSync(candidate)) {
    context.skip("no ~/.local/bin/codex on this machine");
    return;
  }
  // Only the parent-process lookup is simulated; stat, uid, and the
  // `--version` subprocess are real.
  const resolution = await resolveCodexHostExecutable(PARENT, {
    platform: "linux",
    readParentPid: () => PARENT,
    readlink: () => candidate,
    readFile: () => "codex\0",
    log: () => {},
  });
  assert.equal(resolution.ok, true, JSON.stringify(resolution));
  assert.match(resolution.executable.version, /^\d+\.\d+\.\d+$/);
  assert.ok(compareSemver(resolution.executable.version, MIN_CODEX_QUEUE_VERSION) >= 0);
  assert.equal(statSync(candidate).isFile(), true);
});

test("defaultExecFile distinguishes a clean exit, a reported failure, a timeout, and a spawn failure", async () => {
  const env = { PATH: process.env.PATH || "" };
  assert.deepEqual(await defaultExecFile(process.execPath, ["-e", "process.stdout.write('codex-cli 0.150.1\\n')"], { timeout: 10_000, env }), { stdout: "codex-cli 0.150.1\n", stderr: "", code: 0, signal: null, ambiguous: false });
  const reported = await defaultExecFile(process.execPath, ["-e", "process.stderr.write('Error: no rollout found for thread id x'); process.exit(1)"], { timeout: 10_000, env });
  assert.equal(reported.code, 1);
  assert.equal(reported.ambiguous, false);
  assert.equal(reported.spawnError, undefined);
  assert.match(reported.stderr, /no rollout found/);
  const timedOut = await defaultExecFile(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { timeout: 200, env });
  assert.equal(timedOut.code, null);
  assert.equal(timedOut.ambiguous, true);
  assert.equal(timedOut.spawnError, undefined);
  const missing = await defaultExecFile("/nonexistent/parle-codex-host-test", ["--version"], { timeout: 1_000, env });
  assert.equal(missing.ambiguous, false);
  assert.match(missing.spawnError, /^ENOENT/);
});

test("classifyQueueFailure maps Codex's reported failures and leaves the rest retryable", () => {
  assert.equal(classifyQueueFailure("Error: failed to queue session message: thread/queue/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id 0000 (code -32603)"), "invalid-thread");
  assert.equal(classifyQueueFailure("Error: queue is full for thread"), "queue-full");
  assert.equal(classifyQueueFailure("Error: permission denied: app-server-control.sock"), "permission");
  assert.equal(classifyQueueFailure("Error: connection reset"), undefined);
});

test("queue wake execs the exact argv with the fixed trigger and no Parle environment", async () => {
  const harness = wakeHarness();
  harness.wake.start();
  await flush();
  assert.equal(harness.wake.status().state, "queue-only");
  assert.equal(harness.wake.status().host.version, "0.150.1");
  harness.wake.requestWake(THREAD, () => true);
  await flush();
  const queue = harness.queueCalls();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].file, CODEX);
  assert.deepEqual(queue[0].args, ["queue", "--thread", THREAD, "--message", CODEX_QUEUE_WAKE_TRIGGER]);
  assert.equal(queue[0].options.timeout, 20_000);
  assert.deepEqual(queue[0].options.env, { HOME: "/home/u", PATH: "/usr/bin", CODEX_HOME: "/home/u/.codex" });
  assert.match(CODEX_QUEUE_WAKE_TRIGGER, /^Parle wake trigger\. /);
  assert.match(CODEX_QUEUE_WAKE_TRIGGER, /this trigger contains no peer content/);
  const status = harness.wake.status();
  assert.equal(status.state, "queue-only");
  assert.equal(status.outstanding, true);
  assert.equal(status.triggers, 1);
  assert.equal(typeof status.lastTriggerAt, "string");
  assert.deepEqual(harness.logs.map((entry) => entry.stage), ["host_verified", "trigger_queued"]);
  assert.ok(harness.logs.every((entry) => !JSON.stringify(entry).includes(THREAD)), "the log never names the thread");
});

test("queue wake holds one outstanding trigger until a hook take consumes it", async () => {
  const harness = wakeHarness();
  harness.wake.requestWake(THREAD, () => true);
  harness.wake.requestWake(THREAD, () => true);
  await flush();
  assert.equal(harness.queueCalls().length, 1, "a request while verification or the exec is in flight coalesces");
  harness.wake.requestWake(THREAD, () => true);
  await flush();
  assert.equal(harness.queueCalls().length, 1, "an outstanding trigger blocks another");
  harness.wake.consumeWake();
  assert.equal(harness.wake.status().outstanding, false);
  harness.wake.requestWake(THREAD, () => true);
  await flush();
  assert.equal(harness.queueCalls().length, 2);
  assert.equal(harness.wake.status().triggers, 2);
});

// Captured from codex-cli 0.150.1 with a thread id that has no rollout.
const CODEX_0150_INVALID_THREAD_STDERR = "Error: failed to queue session message: thread/queue/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id 00000000-0000-0000-0000-000000000000 (code -32603)\n";

test("queue wake never retries a process that ran: reported and generic failures degrade until a take", async () => {
  for (const [stderr, reason] of [
    [CODEX_0150_INVALID_THREAD_STDERR, "invalid-thread"],
    ["Error: queue is full", "queue-full"],
    ["Error: permission denied", "permission"],
    ["Error: connection reset by peer", "trigger-outcome-unknown"],
    ["", "trigger-outcome-unknown"],
  ]) {
    const harness = wakeHarness({ queue: failed(1, stderr) });
    harness.wake.requestWake(THREAD, () => true);
    await flush();
    const status = harness.wake.status();
    assert.equal(status.state, "degraded", reason);
    assert.equal(status.reason, reason);
    assert.equal(status.exitCode, 1);
    assert.equal(status.outstanding, true, "the row may already exist");
    assert.match(status.lastError, /codex queue exited 1/);
    assert.equal(harness.timers.length, 0, "a process that ran schedules no retry");
    harness.wake.requestWake(THREAD, () => true);
    await flush();
    assert.equal(harness.queueCalls().length, 1, "no second trigger while degraded");
    assert.deepEqual(harness.logs.at(-1).stage, "trigger_rejected");
    harness.wake.consumeWake();
    assert.equal(harness.wake.status().state, "queue-only");
    assert.equal(harness.wake.status().exitCode, undefined);
    harness.wake.requestWake(THREAD, () => true);
    await flush();
    assert.equal(harness.queueCalls().length, 2, "a take resets the hold");
  }
});

test("ready() settles with host verification inside the bound and on the bound otherwise", async () => {
  const deferred = () => {
    let resolveIt;
    const promise = new Promise((resolve) => { resolveIt = resolve; });
    return { promise, resolve: resolveIt };
  };
  const versionProbe = deferred();
  const harness = wakeHarness({ deps: { execFile: fakeExec([[(_file, args) => args[0] === "--version", () => versionProbe.promise]]) } });
  let settled = false;
  const ready = harness.wake.ready(2_000).then(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delayMs, 2_000);
  assert.equal(harness.wake.status().reason, "host-verification-pending");
  versionProbe.resolve(ok("codex-cli 0.150.1\n"));
  await ready;
  assert.equal(harness.wake.status().state, "queue-only");
  assert.deepEqual(harness.cleared, [1], "a settled verification cancels the bound");
  let immediate = false;
  await harness.wake.ready(2_000).then(() => { immediate = true; });
  assert.equal(immediate, true);
  assert.equal(harness.timers.length, 1, "a verified host waits on nothing");

  const slow = deferred();
  const late = wakeHarness({ deps: { execFile: fakeExec([[(_file, args) => args[0] === "--version", () => slow.promise]]) } });
  let boundHit = false;
  const bounded = late.wake.ready(2_000).then(() => { boundHit = true; });
  await flush();
  late.timers[0].callback();
  await bounded;
  assert.equal(boundHit, true);
  assert.equal(late.wake.status().state, "unavailable");
  assert.equal(late.wake.status().reason, "host-verification-pending");
  slow.resolve(ok("codex-cli 0.150.1\n"));
  await flush();
  assert.equal(late.wake.status().state, "queue-only", "a late verification still lands");
});

test("queue wake backs off with jitter after a definite pre-exec failure and gives up after the bound", async () => {
  const spawnFailure = { stdout: "", stderr: "", code: null, signal: null, spawnError: "EAGAIN: spawn", ambiguous: false };
  const randoms = [0.5, 1, 0, 0.5];
  const harness = wakeHarness({ queue: spawnFailure, random: () => randoms.shift() ?? 0.5 });
  let pending = true;
  harness.wake.requestWake(THREAD, () => pending);
  await flush();
  assert.equal(harness.queueCalls().length, 1);
  assert.equal(harness.wake.status().state, "queue-only", "a pre-exec failure keeps the host verified");
  assert.equal(harness.wake.status().outstanding, false);
  assert.equal(typeof harness.wake.status().nextRetryAt, "string");
  // base 1s, 2s, 4s, 8s with jitter of ±25% from the injected random.
  const expectedDelays = [1_000, 2_500, 3_000, 8_000];
  for (let attempt = 0; attempt < expectedDelays.length; attempt += 1) {
    assert.equal(harness.timers.length, attempt + 1);
    assert.equal(harness.timers[attempt].delayMs, expectedDelays[attempt]);
    harness.wake.requestWake(THREAD, () => pending);
    await flush();
    assert.equal(harness.queueCalls().length, attempt + 1, "no trigger while a retry is scheduled");
    harness.advance(expectedDelays[attempt]);
    harness.timers[attempt].callback();
    await flush();
  }
  assert.equal(harness.queueCalls().length, 5);
  const status = harness.wake.status();
  assert.equal(status.state, "unavailable");
  assert.equal(status.reason, "spawn-failed");
  assert.match(status.lastError, /EAGAIN/);
  assert.equal(harness.timers.length, 4, "the bound stops the schedule");
  // Work drained before a retry fires: the retry does nothing.
  harness.wake.consumeWake();
  harness.wake.requestWake(THREAD, () => pending);
  await flush();
  assert.equal(harness.queueCalls().length, 6);
  pending = false;
  harness.timers[4].callback();
  await flush();
  assert.equal(harness.queueCalls().length, 6, "a retry never fires for drained work");
});

test("queue wake degrades on an ambiguous outcome and never retries on its own", async () => {
  const harness = wakeHarness({ queue: { stdout: "", stderr: "", code: null, signal: "SIGTERM", ambiguous: true } });
  harness.wake.requestWake(THREAD, () => true);
  await flush();
  const status = harness.wake.status();
  assert.equal(status.state, "degraded");
  assert.equal(status.reason, "trigger-outcome-unknown");
  assert.equal(status.outstanding, true, "the trigger may have been queued");
  assert.equal(status.exitCode, undefined);
  assert.match(status.lastError, /outcome unknown \(SIGTERM\)/);
  assert.equal(harness.timers.length, 0);
  harness.wake.requestWake(THREAD, () => true);
  await flush();
  assert.equal(harness.queueCalls().length, 1, "a duplicate trigger is never risked");
  harness.wake.consumeWake();
  assert.equal(harness.wake.status().state, "queue-only");
  harness.wake.requestWake(THREAD, () => true);
  await flush();
  assert.equal(harness.queueCalls().length, 2);
});

test("queue wake re-checks the parent before every trigger and reports unverified hosts", async () => {
  let parent = PARENT;
  const harness = wakeHarness({ deps: { readParentPid: () => parent } });
  harness.wake.start();
  await flush();
  assert.equal(harness.wake.status().state, "queue-only");
  parent = PARENT + 1;
  harness.wake.requestWake(THREAD, () => true);
  await flush();
  assert.equal(harness.queueCalls().length, 0);
  assert.deepEqual({ state: harness.wake.status().state, reason: harness.wake.status().reason }, { state: "unavailable", reason: "parent-changed" });

  const tooOld = new CodexQueueWake(PARENT, { ...linuxDeps({ execFile: fakeExec([versionBanner("0.147.0")]) }) });
  assert.deepEqual({ state: tooOld.status().state, reason: tooOld.status().reason }, { state: "unavailable", reason: "host-verification-pending" });
  tooOld.start();
  await flush();
  assert.deepEqual({ state: tooOld.status().state, reason: tooOld.status().reason, detail: tooOld.status().detail }, { state: "unavailable", reason: "version-too-old", detail: "0.147.0" });
  tooOld.requestWake(THREAD, () => true);
  await flush();
  assert.equal(tooOld.status().triggers, 0);
  assert.throws(() => new CodexQueueWake(1), /greater than 1/);
});

test("a restarted queue wake starts fresh and stop() cancels a pending retry", async () => {
  const spawnFailure = { stdout: "", stderr: "", code: null, signal: null, spawnError: "ENOENT: spawn", ambiguous: false };
  const first = wakeHarness({ queue: spawnFailure });
  first.wake.requestWake(THREAD, () => true);
  await flush();
  assert.equal(first.timers.length, 1);
  first.wake.stop();
  assert.deepEqual(first.cleared, [1]);
  first.timers[0].callback();
  await flush();
  assert.equal(first.queueCalls().length, 1, "a stopped wake never fires its retry");
  first.wake.requestWake(THREAD, () => true);
  await flush();
  assert.equal(first.queueCalls().length, 1);

  // A new process knows nothing about an earlier trigger; it queues once more
  // and the trigger text tells the model what an empty wake means.
  const second = wakeHarness();
  second.wake.requestWake(THREAD, () => true);
  await flush();
  assert.equal(second.queueCalls().length, 1);
  assert.equal(second.wake.status().state, "queue-only");
});
