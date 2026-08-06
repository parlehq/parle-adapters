import assert from "node:assert/strict";
import test from "node:test";

import {
  TWO_REPLIES_REMAINING_WARNING,
  normalizeOpaqueReplyRoute,
  responsiveReplyPresentation,
} from "../dist/index.js";

const route = {
  reply_route_id: "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e61",
  interaction_id: "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e62",
  reply_hop: 14,
  remaining_reply_hops: 2,
  expires_at: "2026-08-13T12:00:00Z",
};

test("normalizes the exact complete opaque reply route", () => {
  assert.deepEqual(normalizeOpaqueReplyRoute(route), {
    replyRouteId: route.reply_route_id,
    interactionId: route.interaction_id,
    replyHop: 14,
    remainingReplyHops: 2,
    expiresAt: route.expires_at,
  });
  for (const malformed of [
    { ...route, reply_route_id: "not-a-uuid" },
    { ...route, interaction_id: undefined },
    { ...route, reply_hop: -1 },
    { ...route, remaining_reply_hops: 0 },
    { ...route, expires_at: "not-a-time" },
  ]) assert.equal(normalizeOpaqueReplyRoute(malformed), undefined);
});

test("route presentation prefers the opaque route and warns once at two remaining", () => {
  const presentation = responsiveReplyPresentation({
    reply_route: route,
    author: { address: "@principal.agent.session" },
  });
  assert.equal(presentation.routeState, "available");
  assert.equal(presentation.authorAddress, "@principal.agent.session");
  assert.deepEqual(presentation.clientWarnings, [TWO_REPLIES_REMAINING_WARNING]);
  assert.equal(presentation.lines.filter((line) => line.startsWith("clientWarnings:")).length, 1);
  assert.match(presentation.lines.join("\n"), /call parle_reply/);
  assert.match(presentation.lines.join("\n"), /Prefer this opaque route/);
  assert.doesNotMatch(presentation.lines.join("\n"), /call parle_send/);
});

test("same-principal and withheld-identity deliveries expose the same route shape", () => {
  const samePrincipal = responsiveReplyPresentation({ reply_route: route, author: { address: "@principal.agent.session" } });
  const withheldIdentity = responsiveReplyPresentation({ reply_route: route, author: { address: null, principal_handle: null } });
  assert.deepEqual(samePrincipal.replyRoute, withheldIdentity.replyRoute);
  assert.equal(samePrincipal.routeState, "available");
  assert.equal(withheldIdentity.routeState, "available");
  assert.equal(withheldIdentity.authorAddress, undefined);
  assert.match(withheldIdentity.lines.join("\n"), /reply_to_author: withheld/);
  assert.match(withheldIdentity.lines.join("\n"), /call parle_reply/);
});

test("malformed and unavailable routes fail closed without inferred identity", () => {
  const malformed = responsiveReplyPresentation({
    reply_route: { ...route, remaining_reply_hops: "2" },
    author: { address: "@principal.agent.session" },
  });
  assert.equal(malformed.routeState, "malformed");
  assert.match(malformed.lines.join("\n"), /Fail closed/);
  assert.doesNotMatch(malformed.lines.join("\n"), /call parle_send/);

  const unavailable = responsiveReplyPresentation({
    reply_route: null,
    author: { principal_handle: "principal", agent_handle: "agent", session_handle: "session" },
  });
  assert.equal(unavailable.routeState, "unavailable");
  assert.equal(unavailable.authorAddress, undefined);
  assert.match(unavailable.lines.join("\n"), /reply_to_author: withheld/);
  assert.match(unavailable.lines.join("\n"), /Do not infer exhaustion/);
});
