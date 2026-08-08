import test from "node:test";
import assert from "node:assert/strict";
import {
  disableOwnAliasOfflineDelivery,
  disableOwnAliasRoomOfflineDelivery,
  getOwnAliasOfflineDelivery,
  getOwnAliasRoomOfflineDelivery,
} from "../dist/index.js";

const ROOM_ID = "019f7c00-0000-7000-8000-000000000001";

test("agent alias delivery controls use exact closed operations without peer context", async () => {
  const calls = [];
  const transport = {
    async request(path, options) {
      calls.push({ path, options });
      const room = path.includes("/v/rooms/");
      const mutation = path.endsWith("/disable");
      return {
        alias: "durable",
        alias_generation: 3,
        offline_delivery: !mutation,
        ...(room ? { room_id: ROOM_ID, room_offline_delivery: !mutation, effective_offline_delivery: !mutation } : {}),
        ...(mutation ? { changed: true } : {}),
      };
    },
  };
  assert.equal((await getOwnAliasOfflineDelivery(transport, "durable")).offlineDelivery, true);
  assert.equal((await disableOwnAliasOfflineDelivery(transport, "durable")).changed, true);
  assert.equal((await getOwnAliasRoomOfflineDelivery(transport, ROOM_ID, "durable")).roomOfflineDelivery, true);
  assert.equal((await disableOwnAliasRoomOfflineDelivery(transport, ROOM_ID, "durable")).effectiveOfflineDelivery, false);
  assert.deepEqual(calls.map(({ path }) => path), [
    "/v/agent/session-aliases/durable/offline-delivery",
    "/v/agent/session-aliases/durable/offline-delivery/disable",
    `/v/rooms/${ROOM_ID}/my-session-aliases/durable/offline-delivery`,
    `/v/rooms/${ROOM_ID}/my-session-aliases/durable/offline-delivery/disable`,
  ]);
  assert.equal(calls[0].options.session, true);
  assert.deepEqual(calls[1].options.body, {});
  assert.equal(calls[2].options.roomId, ROOM_ID);
});

test("alias delivery controls reject widened or malformed server responses", async () => {
  await assert.rejects(
    getOwnAliasOfflineDelivery({ request: async () => ({ alias: "durable", alias_generation: 3, offline_delivery: "yes", route_id: "leak" }) }, "durable"),
    /response was invalid/,
  );
  await assert.rejects(
    getOwnAliasRoomOfflineDelivery({ request: async () => ({ alias: "durable", alias_generation: 3, offline_delivery: true, room_id: ROOM_ID, room_offline_delivery: true }) }, ROOM_ID, "durable"),
    /response was invalid/,
  );
});
