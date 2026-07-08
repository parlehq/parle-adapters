import test from "node:test";
import assert from "node:assert/strict";
import { compactConnectionCardFromSummary, formatCompactConnectionCard, nextTextFor, parseSessionAddress } from "../dist/index.js";

test("compact connection card renders approved connected shape", () => {
  assert.equal(formatCompactConnectionCard({
    sessionAddress: "@gilman.galexc.2avkwos36qa4kd5t",
    roomHandle: "galexc-intercom",
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

test("compact connection card falls back to room id and omits unknown watcher", () => {
  assert.equal(formatCompactConnectionCard({
    sessionAddress: "@p.a.s1",
    roomId: "room-1",
    watcher: "unknown",
  }), `========================================
Connected to Parle

You are       @p
Acting as     @p.a
In room       #room-1

Session Address:
@p.a.s1

Next: open another session and send a message to this Session Address.
========================================`);
});

test("compact connection card keeps session address when identity parse fails", () => {
  assert.equal(formatCompactConnectionCard({
    sessionAddress: "not-an-address",
    roomHandle: "room-one",
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
  assert.equal(formatCompactConnectionCard({ roomHandle: "room-one", next: "arm-watcher" }), `========================================
Connected to Parle

In room       #room-one

Next: arm the watcher, then stand by for messages to this Session Address.
========================================`);
});

test("compact card helper derives reused next text from summary", () => {
  assert.equal(compactConnectionCardFromSummary({
    reusedExistingSession: true,
    sessionAddress: "@p.a.s1",
    roomHandle: "room-one",
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
  assert.match(formatCompactConnectionCard({ sessionAddress: "@p.a.s1" }), /Session Address:\n@p\.a\.s1/);
});
