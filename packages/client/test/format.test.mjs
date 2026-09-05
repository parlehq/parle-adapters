import test from "node:test";
import assert from "node:assert/strict";
import { compactConnectionCardFromSummary, compactStatusCardFromStatus, formatCompactConnectionCard, nextTextFor, parseSessionAddress } from "../dist/index.js";

test("compact connection card renders approved connected shape", () => {
  assert.equal(formatCompactConnectionCard({
    sessionAddress: "@gilman.galexc.2avkwos36qa4kd5t",
    rooms: [{ roomHandle: "galexc-intercom" }],
    responsiveDelivery: "watching",
  }), `========================================
Connected to Parle

You are       @gilman
Acting as     @gilman.galexc
In room       #galexc-intercom
Delivery      watching

Session Address:
@gilman.galexc.2avkwos36qa4kd5t

Next: open another session and send a message to this Session Address.
========================================`);
});

test("compact connection card falls back to room id and renders unknown watcher honestly", () => {
  assert.equal(formatCompactConnectionCard({
    sessionAddress: "@p.a.s1",
    rooms: [{ roomId: "room-1" }],
    responsiveDelivery: "unknown",
  }), `========================================
Connected to Parle

You are       @p
Acting as     @p.a
In room       #room-1
Delivery      unknown

Session Address:
@p.a.s1

Next: open another session and send a message to this Session Address.
========================================`);
});

test("compact connection card keeps session address when identity parse fails", () => {
  assert.equal(formatCompactConnectionCard({
    sessionAddress: "not-an-address",
    rooms: [{ roomHandle: "room-one" }],
    responsiveDelivery: "stopped",
    next: "read-inbox",
  }), `========================================
Connected to Parle

In room       #room-one
Delivery      stopped

Session Address:
not-an-address

Next: read your inbox for messages addressed to this session.
========================================`);
});

test("compact connection card supports missing session address", () => {
  assert.equal(formatCompactConnectionCard({ rooms: [{ roomHandle: "room-one" }], next: "arm-watcher" }), `========================================
Connected to Parle

In room       #room-one

Next: arm or verify responsive delivery.
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
  assert.equal(nextTextFor("arm-watcher"), "arm or verify responsive delivery.");
  assert.equal(nextTextFor("arm-or-verify-watcher"), "arm or verify responsive delivery.");
  assert.equal(nextTextFor("wait-for-watcher"), "wait for responsive delivery startup.");
  assert.equal(nextTextFor("repair-delivery-host"), "restart the host after correcting the local delivery socket error.");
  assert.match(formatCompactConnectionCard({ sessionAddress: "@p.a.s1" }), /Session Address:\n@p\.a\.s1/);
});

test("status card renders unknown watcher guidance plus unread for a live session", () => {
  assert.equal(compactStatusCardFromStatus({
    responsiveDelivery: { state: "unknown", nextActionKey: "arm-or-verify-watcher", nextAction: "arm or verify responsive delivery" },
    config: { roomHandle: { value: "room-one" }, roomId: { value: "room-1", configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "ready", sessionAddress: "@p.a.s1", rooms: [{ roomId: "room-1", roomHandle: "room-one", unreadCount: 2 }] },
  }), `========================================
Connected to Parle

You are       @p
Acting as     @p.a
In room       #room-one
Delivery      unknown
Unread        2

Session Address:
@p.a.s1

Next: arm or verify responsive delivery.
========================================`);
});

test("status card omits zero unread and retains unknown watcher guidance", () => {
  const card = compactStatusCardFromStatus({
    responsiveDelivery: { state: "unknown", nextActionKey: "arm-or-verify-watcher", nextAction: "arm or verify responsive delivery" },
    config: { roomHandle: { value: "room-one" }, roomId: { configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "ready", sessionAddress: "@p.a.s1", rooms: [{ roomId: "room-1", roomHandle: "room-one", unreadCount: 0 }] },
  });
  assert.doesNotMatch(card, /Unread/);
  assert.match(card, /Delivery      unknown/);
  assert.match(card, /Next: arm or verify responsive delivery\./);
});

test("status and connection cards make unarmed idle wake visible without changing controller state", () => {
  const responsiveDelivery = { state: "watching", reason: "idle_wake_unarmed", nextActionKey: "arm-or-verify-watcher" };
  const connection = compactConnectionCardFromSummary({ sessionAddress: "@p.a.s1", rooms: [{ roomHandle: "room-one" }] }, { responsiveDelivery, next: responsiveDelivery.nextActionKey });
  assert.match(connection, /Delivery      watching \(idle wake unarmed\)/);
  assert.match(connection, /Next: arm or verify responsive delivery\./);

  const status = compactStatusCardFromStatus({
    responsiveDelivery,
    config: { roomHandle: { value: "room-one" }, roomId: { configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "ready", sessionAddress: "@p.a.s1", rooms: [{ roomId: "room-1", roomHandle: "room-one" }] },
  });
  assert.match(status, /Delivery      watching \(idle wake unarmed\)/);
  assert.match(status, /Next: arm or verify responsive delivery\./);
});

test("status and connection cards render a suspended idle wake truthfully with prompt-bound guidance", () => {
  const responsiveDelivery = { state: "watching", reason: "idle_wake_suspended", nextActionKey: "wait-for-prompt" };
  const connection = compactConnectionCardFromSummary({ sessionAddress: "@p.a.s1", rooms: [{ roomHandle: "room-one" }] }, { responsiveDelivery, next: responsiveDelivery.nextActionKey });
  assert.match(connection, /Delivery      watching \(idle wake suspended: the wake attachment keeps closing\)/);
  assert.doesNotMatch(connection, /memory pressure/, "the shared card states the observation, not a host-specific diagnosis");
  assert.match(connection, /Next: idle wake resumes at the next prompt; do not re-attach until then\./);

  const status = compactStatusCardFromStatus({
    responsiveDelivery,
    config: { roomHandle: { value: "room-one" }, roomId: { configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "ready", sessionAddress: "@p.a.s1", rooms: [{ roomId: "room-1", roomHandle: "room-one" }] },
  });
  assert.match(status, /Delivery      watching \(idle wake suspended: the wake attachment keeps closing\)/);
  assert.doesNotMatch(status, /memory pressure/);
  assert.match(status, /Next: idle wake resumes at the next prompt/);
});

test("status card renders idle wake unavailable without asking to arm anything (#171)", () => {
  const responsiveDelivery = { state: "watching", idleWake: "unavailable", nextActionKey: "idle-wake-unavailable" };
  const status = compactStatusCardFromStatus({
    responsiveDelivery,
    config: { roomHandle: { value: "room-one" }, roomId: { configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "ready", sessionAddress: "@p.a.s1", rooms: [{ roomId: "room-1", roomHandle: "room-one" }] },
  });
  assert.equal(status, `========================================
Connected to Parle

You are       @p
Acting as     @p.a
In room       #room-one
Delivery      watching (idle wake unavailable)

Session Address:
@p.a.s1

Next: Messages arriving while idle will be delivered at the next prompt. If you need to stay available now, explicitly authorize one capped attended wait.
========================================`);
  assert.doesNotMatch(status, /\barm\b/i);
  assert.doesNotMatch(status, /idle wake unarmed/);

  const connection = compactConnectionCardFromSummary({ sessionAddress: "@p.a.s1", rooms: [{ roomHandle: "room-one" }] }, { responsiveDelivery, next: responsiveDelivery.nextActionKey });
  assert.match(connection, /Delivery      watching \(idle wake unavailable\)/);
  assert.match(connection, /Next: Messages arriving while idle will be delivered at the next prompt\. If you need to stay available now, explicitly authorize one capped attended wait\./);
  assert.doesNotMatch(connection, /\barm\b/i);
});

test("idle wake unavailable wins over the unarmed reason and the unknown-watcher fallback", () => {
  // The unavailable parenthetical replaces the unarmed one whatever reason the
  // adapter left in place, and a missing next key never falls back to arming.
  const base = {
    config: { roomHandle: { value: "room-one" }, roomId: { configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "ready", sessionAddress: "@p.a.s1", rooms: [{ roomId: "room-1", roomHandle: "room-one" }] },
  };
  const both = compactStatusCardFromStatus({ ...base, responsiveDelivery: { state: "watching", reason: "idle_wake_unarmed", idleWake: "unavailable" } });
  assert.match(both, /Delivery      watching \(idle wake unavailable\)/);
  assert.doesNotMatch(both, /idle wake unarmed/);
  const unknown = compactStatusCardFromStatus({ ...base, responsiveDelivery: { state: "unknown", idleWake: "unavailable" } });
  assert.match(unknown, /Delivery      unknown \(idle wake unavailable\)/);
  assert.match(unknown, /Next: Messages arriving while idle will be delivered at the next prompt\./);
  assert.doesNotMatch(unknown, /arm or verify/);
});

test("armed and unarmed idle wake keep the existing card text", () => {
  const base = {
    config: { roomHandle: { value: "room-one" }, roomId: { configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "ready", sessionAddress: "@p.a.s1", rooms: [{ roomId: "room-1", roomHandle: "room-one" }] },
  };
  const armed = compactStatusCardFromStatus({ ...base, responsiveDelivery: { state: "watching", idleWake: "armed", nextActionKey: "already-connected" } });
  assert.match(armed, /Delivery      watching\n/);
  assert.match(armed, /Next: read your inbox when you are ready\./);
  // The unarmed parenthetical still keys on the adapter's reason, so a host
  // that is watching but not yet session-bound renders exactly as before.
  const unarmedUnbound = compactStatusCardFromStatus({ ...base, responsiveDelivery: { state: "watching", idleWake: "unarmed", nextActionKey: "arm-or-verify-watcher" } });
  assert.match(unarmedUnbound, /Delivery      watching\n/);
  assert.match(unarmedUnbound, /Next: arm or verify responsive delivery\./);
  const unarmed = compactStatusCardFromStatus({ ...base, responsiveDelivery: { state: "watching", reason: "idle_wake_unarmed", idleWake: "unarmed", nextActionKey: "arm-or-verify-watcher" } });
  assert.match(unarmed, /Delivery      watching \(idle wake unarmed\)/);
  assert.match(unarmed, /Next: arm or verify responsive delivery\./);
  assert.equal(nextTextFor("idle-wake-unavailable"), "Messages arriving while idle will be delivered at the next prompt. If you need to stay available now, explicitly authorize one capped attended wait.");
});

test("status card surfaces degraded responsive delivery", () => {
  const card = compactStatusCardFromStatus({
    responsiveDelivery: { state: "backoff", nextActionKey: "recover-watcher", nextAction: "inspect the responsive delivery error" },
    config: { roomHandle: { value: "room-one" }, roomId: { configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "ready", sessionAddress: "@p.a.s1", rooms: [{ roomId: "room-1", roomHandle: "room-one", unreadCount: 0 }] },
  });
  assert.match(card, /Delivery      backoff/);
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

test("absent responsive evidence omits the delivery line", () => {
  const card = compactStatusCardFromStatus({
    config: { roomHandle: { value: "room-one" }, roomId: { configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "ready", sessionAddress: "@p.a.s1", rooms: [{ roomId: "room-1", roomHandle: "room-one", unreadCount: 0 }] },
  });
  assert.doesNotMatch(card, /Delivery/);
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

test("status and connection cards render host-owned idle wake states and their guidance (#174)", () => {
  const card = (responsiveDelivery) => compactStatusCardFromStatus({
    responsiveDelivery,
    config: { roomHandle: { value: "room-one" }, roomId: { configured: true }, agentToken: { configured: true } },
    runtime: { bootstrapState: "ready", sessionAddress: "@p.a.s1", rooms: [{ roomId: "room-1", roomHandle: "room-one" }] },
  });
  assert.equal(card({ state: "watching", idleWake: "queue-only", nextActionKey: "idle-wake-queue-only" }), `========================================
Connected to Parle

You are       @p
Acting as     @p.a
In room       #room-one
Delivery      watching (idle wake queue-only)

Session Address:
@p.a.s1

Next: idle wake is armed through the host queue; messages arriving while idle start a turn within about 10 seconds.
========================================`);
  assert.equal(card({ state: "watching", idleWake: "degraded", nextActionKey: "idle-wake-degraded" }), `========================================
Connected to Parle

You are       @p
Acting as     @p.a
In room       #room-one
Delivery      watching (idle wake degraded)

Session Address:
@p.a.s1

Next: a wake trigger may be queued but its delivery is unproven; check Parle or prompt once.
========================================`);
  const daemon = card({ state: "watching", idleWake: "daemon-attached", nextActionKey: "idle-wake-daemon-attached" });
  assert.match(daemon, /Delivery      watching \(idle wake daemon-attached\)/);
  assert.match(daemon, /Next: idle wake is armed through the host daemon; messages arriving while idle start a turn immediately\./);
  // The host state wins over the waiter reason, and the unknown-watcher
  // fallback follows the host state instead of asking to arm.
  assert.match(card({ state: "watching", idleWake: "queue-only", reason: "idle_wake_unarmed", nextActionKey: "idle-wake-queue-only" }), /Delivery      watching \(idle wake queue-only\)/);
  assert.match(card({ state: "unknown", idleWake: "queue-only" }), /Next: idle wake is armed through the host queue/);
  assert.match(card({ state: "unknown", idleWake: "degraded" }), /Next: a wake trigger may be queued/);
  for (const text of [daemon, card({ state: "watching", idleWake: "queue-only", nextActionKey: "idle-wake-queue-only" })]) {
    assert.doesNotMatch(text, /\barm\b/i);
    assert.doesNotMatch(text, /Codex/);
  }
  const connection = compactConnectionCardFromSummary({ sessionAddress: "@p.a.s1", rooms: [{ roomHandle: "room-one" }] }, { responsiveDelivery: { state: "watching", idleWake: "queue-only" }, next: "idle-wake-queue-only" });
  assert.match(connection, /Delivery      watching \(idle wake queue-only\)/);
  assert.match(connection, /Next: idle wake is armed through the host queue; messages arriving while idle start a turn within about 10 seconds\./);
});
