import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParleAgentClient, readKnownAddressRegistry } from "../dist/index.js";

const ROOM = "019f2946-aef5-77ad-a41d-747ce0fd6a1e";
const NOW = new Date("2026-08-09T00:00:00.000Z");

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "parle-known-address-send-"));
  const catalog = join(home, ".parle", "profiles");
  const replies = [];
  const client = new ParleAgentClient({
    env: { HOME: home, PARLE_ROOM_ID: ROOM, PARLE_ROOM_AGENT_TOKEN: "parle_agt_test" },
    now: () => NOW,
    randomUUID: () => "idem-test",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions") return json({ agent_session_id: "as-1", session_credential: "parle_ses_test", session_handle: "session", expires_at: "2099-01-01T00:00:00Z" }, 201);
      if (path.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (path.includes("/projection")) return json({ watermark: 0, messages: [] });
      if (path.endsWith("/messages")) return replies.shift();
      if (path.endsWith("/replies")) return json({ event_id: "reply-1", seq: 9 }, 201);
      throw new Error(`unexpected request ${path}`);
    },
  });
  return { home, catalog, client, replies, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function receipt(mode = "direct", continuity = "ephemeral", attention = "none", targetLevel = mode === "direct" ? "session" : "none") {
  return json({
    event_id: "event-1",
    seq: 1,
    routing: { mode, target_level: targetLevel, continuity },
    attention: { inbound_scope: attention, responsive_scope: attention },
  }, 201);
}

test("only successful direct send receipts enroll the submitted canonical selector", async () => {
  const f = fixture();
  try {
    f.replies.push(receipt("direct", "ephemeral", "none"));
    const sent = await f.client.send({ body: "hello", to: "@principal.agent.submitted" });
    assert.equal(sent.routing.mode, "direct");
    assert.deepEqual(readKnownAddressRegistry(f.catalog, NOW, { prune: false }).entries.map((entry) => entry.address), ["@principal.agent.submitted"]);

    f.replies.push(receipt("direct", "none", "target", "none"));
    await f.client.send({ body: "direct shape without a resolved target", to: "@principal.agent.notenrolled" });
    f.replies.push(receipt("unaddressed", "none", "target"));
    await f.client.send({ body: "server did not route direct", to: "@principal.agent.also-not-enrolled" });
    f.replies.push(receipt("unaddressed", "none", "target"));
    await f.client.send({ body: "unaddressed" });
    await f.client.submitReply({ body: "reply", replyRouteId: "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e61" });

    const entries = readKnownAddressRegistry(f.catalog, NOW, { prune: false }).entries;
    assert.deepEqual(entries.map((entry) => entry.address), ["@principal.agent.submitted"]);
  } finally { f.cleanup(); }
});

test("registry custody failures never block or alter the direct send receipt", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, ".parle"), { recursive: true, mode: 0o700 });
    writeFileSync(join(f.home, ".parle", "registry"), "hostile", { mode: 0o600 });
    chmodSync(join(f.home, ".parle", "registry"), 0o644);
    chmodSync(join(f.home, ".parle"), 0o755);
    f.replies.push(receipt("direct", "ephemeral", "target"));
    const sent = await f.client.send({ body: "still sends", to: "@principal.agent.submitted" });
    assert.equal(sent.routing.mode, "direct");
    assert.equal(sent.addressedTo, undefined);
    assert.equal(readKnownAddressRegistry(f.catalog, NOW).available, false);

    f.replies.push(json({ error: { code: "address_not_deliverable", message: "address not deliverable", action: "fix_client", scope: "request", retryable: false } }, 422));
    const failed = await f.client.send({ body: "still returns structured failure", to: "@principal.agent.submitted" });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, "address_not_deliverable");
  } finally { f.cleanup(); }
});

test("failed submits never enroll and privacy-flat 422 only shortens an existing entry", async () => {
  const f = fixture();
  try {
    f.replies.push(receipt("direct", "durable", "target"));
    await f.client.send({ body: "seed", to: "@principal.agent.existing" });

    f.replies.push(json({ error: { code: "validation_failed", message: "invalid payload", action: "fix_client", scope: "request", retryable: false } }, 422));
    await f.client.send({ body: "invalid", to: "@principal.agent.existing" });
    assert.equal(readKnownAddressRegistry(f.catalog, NOW, { prune: false }).entries[0].expiresAt, "2026-08-16T00:00:00.000Z");

    f.replies.push(json({ error: { code: "address_not_deliverable", message: "address not deliverable", action: "fix_client", scope: "request", retryable: false } }, 422));
    const failed = await f.client.send({ body: "retry", to: "@principal.agent.existing" });
    assert.equal(failed.ok, false);

    f.replies.push(json({ error: { code: "address_not_deliverable", message: "address not deliverable", action: "fix_client", scope: "request", retryable: false } }, 422));
    await f.client.send({ body: "missing", to: "@principal.agent.missing" });

    const entries = readKnownAddressRegistry(f.catalog, NOW, { prune: false }).entries;
    assert.deepEqual(entries.map((entry) => entry.address), ["@principal.agent.existing"]);
    assert.equal(entries[0].expiresAt, "2026-08-09T01:00:00.000Z");
  } finally { f.cleanup(); }
});
