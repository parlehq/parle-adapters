import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { CLAUDE_MONITOR_WAKE_FRAME, ClaudeMonitorWake } from "../dist/claude-monitor-wake.js";

const URL_PATTERN = /^ws:\/\/127\.0\.0\.1:(\d+)\/([A-Za-z0-9_-]{43})$/;

async function startWake() {
  const logs = [];
  const attachments = [];
  const wake = new ClaudeMonitorWake({ log: (event) => logs.push(event) });
  wake.onAttachment((attached) => attachments.push(attached));
  wake.start();
  await wake.ready(2_000);
  const url = wake.wakeUrl();
  const match = url.match(URL_PATTERN);
  assert.ok(match, `wake url has the loopback shape: ${url}`);
  return { wake, logs, attachments, url, port: Number(match[1]), token: match[2] };
}

// Node's built-in WebSocket client, which is what the Claude host uses too.
function openPeer(url) {
  return new Promise((resolve, reject) => {
    const peer = new WebSocket(url);
    const frames = [];
    const closed = new Promise((done) => peer.addEventListener("close", (event) => done({ code: event.code, reason: event.reason })));
    peer.addEventListener("message", (event) => frames.push(String(event.data)));
    peer.addEventListener("open", () => resolve({ peer, frames, closed }));
    peer.addEventListener("error", () => reject(new Error("websocket handshake failed")));
  });
}

function rawRequest({ port, path, method = "GET", host = `127.0.0.1:${port}`, upgrade = true }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        Host: host,
        ...(upgrade ? { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64") } : {}),
      },
    });
    req.on("response", (response) => { response.resume(); resolve(response.statusCode); });
    req.on("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    req.on("error", reject);
    req.end();
  });
}

async function eventually(check, label = "condition") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not become true`);
}

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

test("claude monitor wake accepts only a GET upgrade for the exact token and Host", async () => {
  const { wake, port, token, url, attachments } = await startWake();
  try {
    assert.deepEqual(wake.status(), { state: "unavailable", reason: "monitor-not-attached", outstanding: false, frames: 0, attachments: 0 });

    assert.equal(await rawRequest({ port, path: `/${token}`, upgrade: false }), 426, "a plain request is told to upgrade");
    assert.equal(await rawRequest({ port, path: `/${token}`, method: "POST" }), 405);
    assert.equal(await rawRequest({ port, path: `/${token}`, host: `localhost:${port}` }), 400, "Host must be the loopback literal");
    assert.equal(await rawRequest({ port, path: `/${token}`, host: `127.0.0.1:${port + 1}` }), 400);
    assert.equal(await rawRequest({ port, path: `/${token.slice(0, -1)}x` }), 404, "a near-miss token is refused");
    assert.equal(await rawRequest({ port, path: `/${token}/` }), 404);
    assert.equal(await rawRequest({ port, path: "/" }), 404);
    await assert.rejects(openPeer(`ws://127.0.0.1:${port}/${randomBytes(32).toString("base64url")}`));
    assert.deepEqual(attachments, [], "refused upgrades never attach");

    const { peer, closed } = await openPeer(url);
    await eventually(() => attachments.length === 1);
    assert.deepEqual(attachments, [true]);
    assert.equal(wake.status().state, "daemon-attached");
    assert.equal(wake.status().attachments, 1);
    peer.close(1000, "done");
    assert.equal((await closed).code, 1000);
    await eventually(() => attachments.length === 2);
    assert.deepEqual(attachments, [true, false], "a peer that closes on its own is a detach");
    assert.equal(wake.status().state, "unavailable");
    assert.equal(wake.status().reason, "monitor-not-attached");
  } finally {
    wake.stop();
  }
});

test("claude monitor wake survives an oversized peer frame and keeps serving", async () => {
  const { wake, url, attachments } = await startWake();
  try {
    const first = await openPeer(url);
    await eventually(() => attachments.length === 1);
    first.peer.send("x".repeat(2048));
    const closed = await first.closed;
    assert.equal(closed.code, 1009, "the oversized frame closes that peer");
    await eventually(() => attachments.length === 2);
    assert.deepEqual(attachments, [true, false]);
    assert.match(String(wake.status().lastError), /payload/i);

    const second = await openPeer(url);
    await eventually(() => attachments.length === 3);
    assert.equal(wake.status().state, "daemon-attached");
    second.peer.send("ignored");
    await settle();
    assert.equal(second.peer.readyState, WebSocket.OPEN, "small peer frames are ignored, not fatal");
    second.peer.close();
    await second.closed;
  } finally {
    wake.stop();
  }
});

test("claude monitor wake keeps one peer, newest wins, and a replacement is not a detach", async () => {
  const { wake, url, attachments } = await startWake();
  try {
    const first = await openPeer(url);
    await eventually(() => attachments.length === 1);
    const second = await openPeer(url);
    const replaced = await first.closed;
    assert.deepEqual(replaced, { code: 1000, reason: "replaced" });
    await eventually(() => attachments.length === 2);
    assert.deepEqual(attachments, [true, true], "the replaced peer's close is never reported as a detach");
    assert.equal(wake.status().state, "daemon-attached");
    assert.equal(wake.status().attachments, 2);

    wake.requestWake("thread-1", () => true);
    await eventually(() => second.frames.length === 1);
    assert.deepEqual(second.frames, [CLAUDE_MONITOR_WAKE_FRAME], "frames go to the current peer only");
    assert.deepEqual(first.frames, []);

    second.peer.close(1000, "monitor stopped");
    await second.closed;
    await eventually(() => attachments.length === 3);
    assert.deepEqual(attachments, [true, true, false], "the user stopping the monitor is a detach");
  } finally {
    wake.stop();
  }
});

test("claude monitor wake frames once per outstanding wake and only while work is pending", async () => {
  const { wake, url, attachments } = await startWake();
  try {
    wake.requestWake("thread-1", () => true);
    assert.equal(wake.status().outstanding, false, "no peer, no frame, nothing outstanding");

    const { peer, frames, closed } = await openPeer(url);
    await eventually(() => attachments.length === 1);
    wake.requestWake("thread-1", () => false);
    await settle();
    assert.deepEqual(frames, [], "a predicate that says nothing is pending sends nothing");
    assert.equal(wake.status().outstanding, false);

    wake.requestWake("thread-1", () => true);
    await eventually(() => frames.length === 1);
    assert.equal(wake.status().outstanding, true);
    wake.requestWake("thread-1", () => true);
    wake.requestWake("thread-1", () => true);
    await settle();
    assert.equal(frames.length, 1, "no second frame while one is outstanding");

    wake.consumeWake();
    assert.equal(wake.status().outstanding, false);
    wake.requestWake("thread-1", () => true);
    await eventually(() => frames.length === 2);
    assert.equal(wake.status().frames, 2);
    assert.match(String(wake.status().lastFrameAt), /^\d{4}-\d{2}-\d{2}T/);

    // A frame the peer that received it never consumed dies with that peer.
    peer.close();
    await closed;
    await eventually(() => attachments.length === 2);
    assert.equal(wake.status().outstanding, false);
    const next = await openPeer(url);
    await eventually(() => attachments.length === 3);
    wake.requestWake("thread-1", () => true);
    await eventually(() => next.frames.length === 1, "the replacement peer hears about still-pending work");
    next.peer.close();
    await next.closed;
  } finally {
    wake.stop();
  }
});

test("claude monitor wake keeps the url out of status and logs and stops cleanly", async () => {
  const { wake, url, port, token, logs, attachments } = await startWake();
  const { peer, closed } = await openPeer(url);
  await eventually(() => attachments.length === 1);
  wake.requestWake("thread-1", () => true);
  await settle();
  const rendered = JSON.stringify(wake.status());
  assert.equal(rendered.includes(token), false, "status carries no token");
  assert.equal(rendered.includes(String(port)), false, "status carries no port");
  assert.equal(rendered.includes("ws://"), false);
  const logged = JSON.stringify(logs);
  assert.equal(logged.includes(token), false, "logs carry no token");
  assert.equal(logged.includes(`:${port}`), false, "logs carry no port");
  assert.deepEqual(logs.map((entry) => entry.stage), ["monitor_listening", "monitor_attached", "frame_sent"]);
  assert.ok(logs.every((entry) => entry.event === "parle_idle_wake"));

  wake.stop();
  assert.equal((await closed).code, 1001, "stop closes the peer as going away");
  await settle();
  assert.deepEqual(attachments, [true], "a stop-initiated close is not a detach");
  assert.equal(wake.wakeUrl(), undefined);
  assert.equal(wake.status().state, "unavailable");
  assert.equal(wake.status().reason, "stopped");
  assert.equal(peer.readyState, WebSocket.CLOSED);
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", reject);
  }), /ECONNREFUSED/, "the listener is gone");
  wake.requestWake("thread-1", () => true);
  assert.equal(wake.status().outstanding, false);
});

test("claude monitor wake rebind closes the peer deliberately and retires the old address", async () => {
  const { wake, url, attachments } = await startWake();
  try {
    const before = await openPeer(url);
    await eventually(() => attachments.length === 1);
    wake.requestWake("thread-1", () => true);
    await eventually(() => before.frames.length === 1);
    assert.equal(wake.status().outstanding, true);

    wake.rebind();
    assert.deepEqual(await before.closed, { code: 1000, reason: "rebound" });
    await settle();
    assert.deepEqual(attachments, [true], "a rebind close is not a detach");
    assert.equal(wake.status().outstanding, false);
    assert.equal(wake.status().reason, "monitor-not-attached");
    const after = wake.wakeUrl();
    assert.match(after, URL_PATTERN);
    assert.notEqual(after, url, "the token rotates");
    assert.equal(new URL(after).port, new URL(url).port, "the listener is unchanged");
    await assert.rejects(openPeer(url), "the old address is dead");

    const next = await openPeer(after);
    await eventually(() => attachments.length === 2);
    wake.requestWake("thread-2", () => true);
    await eventually(() => next.frames.length === 1);
    assert.deepEqual(before.frames, [CLAUDE_MONITOR_WAKE_FRAME], "the replaced peer heard nothing more");
    next.peer.close();
    await next.closed;

    wake.rebind();
    assert.notEqual(wake.wakeUrl(), after, "rebind without a peer still rotates");
  } finally {
    wake.stop();
  }
});

// A send callback can fail late, after the peer that was sending has been
// replaced; that failure must not release the frame the current peer holds.
function fakePeer() {
  return {
    readyState: WebSocket.OPEN,
    sent: [],
    callbacks: [],
    closes: [],
    handlers: {},
    on(event, handler) { this.handlers[event] = handler; },
    send(data, callback) { this.sent.push(data); this.callbacks.push(callback); },
    close(code, reason) { this.closes.push({ code, reason }); },
  };
}

test("claude monitor wake ignores a late send failure from a replaced peer", () => {
  const wake = new ClaudeMonitorWake({ log: () => {} });
  const first = fakePeer();
  wake.attach(first);
  wake.requestWake("thread-1", () => true);
  assert.deepEqual(first.sent, [CLAUDE_MONITOR_WAKE_FRAME]);
  assert.equal(wake.status().outstanding, true);

  const second = fakePeer();
  wake.attach(second);
  assert.deepEqual(first.closes, [{ code: 1000, reason: "replaced" }]);
  assert.equal(wake.status().outstanding, false, "the replaced peer's frame is not outstanding for the new peer");
  wake.requestWake("thread-1", () => true);
  assert.deepEqual(second.sent, [CLAUDE_MONITOR_WAKE_FRAME]);
  assert.equal(wake.status().outstanding, true);

  first.callbacks[0](new Error("EPIPE: broken pipe"));
  assert.equal(wake.status().outstanding, true, "the stale failure does not clear the current peer's frame");
  assert.match(wake.status().lastError, /EPIPE/);
  wake.requestWake("thread-1", () => true);
  assert.equal(second.sent.length, 1, "no duplicate frame");

  second.callbacks[0](new Error("ECONNRESET"));
  assert.equal(wake.status().outstanding, false, "the current peer's own failure releases the frame");
  wake.requestWake("thread-1", () => true);
  assert.equal(second.sent.length, 2);
  wake.stop();
  assert.deepEqual(second.closes, [{ code: 1001, reason: "stopped" }]);
});
