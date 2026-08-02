import test from "node:test";
import assert from "node:assert/strict";
import { compactConnectionCardFromSummary, compactStatusCardFromStatus, formatCompactConnectionCard, nextTextFor, parseSessionAddress } from "../dist/index.js";

test("compact connection card renders approved connected shape", () => {
  assert.equal(formatCompactConnectionCard({
    sessionAddress: "@gilman.galexc.2avkwos36qa4kd5t",
    rooms: [{ roomHandle: "galexc-intercom" }],
    watcher: "on",
  }), `========================================
Connected to Parle

You are       @gilman
Acting as     @gilman.galexc
In room       #galexc-intercom
Watcher       on

Session Address:
@gilman.galexc.2avkwos36qa4kd5t

Next: open another session and send a message to this Session Address.
========================================`);
});

test("compact connection card falls back to room id and renders unknown watcher honestly", () => {
  assert.equal(formatCompactConnectionCard({
    sessionAddress: "@p.a.s1",
    rooms: [{ roomId: "room-1" }],
    watcher: "unknown",
  }), `========================================
Connected to Parle

You are       @p
Acting as     @p.a
In room       #room-1
Watcher       unknown

Session Address:
@p.a.s1

Next: open another session and send a message to this Session Address.
========================================`);
});

test("compact connection card keeps session address when identity parse fails", () => {
  assert.equal(formatCompactConnectionCard({
    sessionAddress: "not-an-address",
    rooms: [{ roomHandle: "room-one" }],
    watcher: "off",
    next: "read-inbox",
  }), `========================================
Connected to Parle

In room       #room-one
Watcher       off

Session Address:
not-an-address

Next: read your inbox for messages addressed to this session.
========================================`);
});

test("compact connection card supports missing session address", () => {
  assert.equal(formatCompactConnectionCard({ rooms: [{ roomHandle: "room-one" }], next: "arm-watcher" }), `========================================
Connected to Parle

In room       #room-one

Next: arm or verify the watcher.
========================================`);
});

test("compact card helper derives reused next text from summary", () => {
  assert.equal(compactConnectionCardFromSummary({
    reusedExistingSession: true,
    sessionAddress: "@p.a.s1",
    rooms: [{ roomHandle: "room-one" }],
  }), `========================================
Connected to Parle

You are       @p
Acting as     @p.a
In room       #room-one

Session Address:
@p.a.s1

Next: read your inbox when you are ready.
========================================`);
});

test("compact formatter guards address parsing and next text", () => {
  assert.deepEqual(parseSessionAddress("@p.a.s1"), { principal: "p", agent: "a" });
  assert.equal(parseSessionAddress("@p.a"), undefined);
  assert.equal(nextTextFor("custom hint."), "custom hint.");
  assert.equal(nextTextFor("arm-watcher"), "arm or verify the watcher.");
  assert.equal(nextTextFor("arm-or-verify-watcher"), "arm or verify the watcher.");
  assert.match(formatCompactConnectionCard({ sessionAddress: "@p.a.s1" }), /Session Address:\n@p\.a\.s1/);
});

test("status card renders unknown watcher guidance plus unread for a live session", () => {
  assert.equal(compactStatusCardFromStatus({
    watcher: { state: "unknown", nextActionKey: "arm-or-verify-watcher", nextAction: "arm or verify the watcher" },
    config: { roomHandle: { value: "room-one" }, roomId: { value: "room-1", configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "ready", sessionAddress: "@p.a.s1", rooms: [{ roomId: "room-1", roomHandle: "room-one", unreadCount: 2 }] },
  }), `========================================
Connected to Parle

You are       @p
Acting as     @p.a
In room       #room-one
Watcher       unknown
Unread        2

Session Address:
@p.a.s1

Next: arm or verify the watcher.
========================================`);
});

test("status card omits zero unread and retains unknown watcher guidance", () => {
  const card = compactStatusCardFromStatus({
    watcher: { state: "unknown", nextActionKey: "arm-or-verify-watcher", nextAction: "arm or verify the watcher" },
    config: { roomHandle: { value: "room-one" }, roomId: { configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "ready", sessionAddress: "@p.a.s1", rooms: [{ roomId: "room-1", roomHandle: "room-one", unreadCount: 0 }] },
  });
  assert.doesNotMatch(card, /Unread/);
  assert.match(card, /Watcher       unknown/);
  assert.match(card, /Next: arm or verify the watcher\./);
});

test("status card surfaces degraded responsive delivery", () => {
  const card = compactStatusCardFromStatus({
    watcher: { state: "degraded", nextActionKey: "recover-watcher", nextAction: "inspect the responsive delivery error" },
    config: { roomHandle: { value: "room-one" }, roomId: { configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "ready", sessionAddress: "@p.a.s1", rooms: [{ roomId: "room-1", roomHandle: "room-one", unreadCount: 0 }] },
  });
  assert.match(card, /Watcher       degraded/);
  assert.match(card, /Next: inspect the responsive delivery error and restart the host if it does not recover\./);
});

test("failed status shows a short not-connected card without watcher claims", () => {
  assert.equal(compactStatusCardFromStatus({
    config: { roomId: { configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "failed", sessionAddress: null },
  }), `========================================
Parle configured, not connected

Next: run parle_connect to establish the session.
========================================`);
});

test("absent watcher evidence omits the watcher line", () => {
  const card = compactStatusCardFromStatus({
    config: { roomHandle: { value: "room-one" }, roomId: { configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "ready", sessionAddress: "@p.a.s1", rooms: [{ roomId: "room-1", roomHandle: "room-one", unreadCount: 0 }] },
  });
  assert.doesNotMatch(card, /Watcher/);
  assert.match(card, /Next: read your inbox when you are ready\./);
});

test("status card points unconfigured hosts at parle_setup", () => {
  assert.equal(compactStatusCardFromStatus({
    config: { roomId: { configured: false }, agentToken: { configured: false } },
    runtime: { bootstrapState: "unstarted", sessionAddress: null },
  }), `========================================
Parle not configured

Next: run parle_setup to diagnose configuration.
========================================`);
});
