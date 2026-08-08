import { ParleApiError, redactString } from "./protocol.js";

// Durable session-alias authority, shared by every adapter (issue #63 S5).
//
// Claiming an alias is the only authority-transferring call in the session
// lifecycle, and its recovery rules are subtle: a lost response may hide a
// committed claim, an exact replay may double-claim, and a 409 is terminal for
// that candidate. Keeping one implementation means those rules cannot drift
// between the shared client and a host adapter.

export const SESSION_INVENTORY_MAX_PAGES = 100;
export const CLAIM_RECOVERY_ATTEMPTS = 3;

export type AliasFacts = { alias: string; generation: number; currentAgentSessionId?: string };

// Injected transport so this module stays free of any client's request layer,
// credential handling, or runtime state.
export type AliasTransport = {
  request(path: string, options?: { method?: string; body?: unknown; session?: boolean; roomId?: string; sessionCredential?: string; signal?: AbortSignal; rawResponse?: boolean; retry?: boolean }): Promise<any>;
  signal?: AbortSignal;
};

export type AliasOfflineDelivery = {
  alias: string;
  aliasGeneration: number;
  offlineDelivery: boolean;
  changed?: boolean;
};

export type AliasRoomOfflineDelivery = AliasOfflineDelivery & {
  roomId: string;
  roomOfflineDelivery: boolean;
  effectiveOfflineDelivery: boolean;
};

function validAlias(alias: string): string {
  const value = alias.trim().toLowerCase();
  if (value.length < 2 || value.length > 40 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new ParleApiError("Parle durable session alias is invalid", { code: "validation_failed", action: "fix_client", scope: "request" });
  }
  return value;
}

function aliasOfflineDelivery(value: any, alias: string, mutation: boolean): AliasOfflineDelivery {
  if (value?.alias !== alias || !Number.isInteger(value?.alias_generation) || value.alias_generation < 1
    || typeof value?.offline_delivery !== "boolean" || (mutation && typeof value?.changed !== "boolean")) {
    throw new ParleApiError("Parle alias offline-delivery response was invalid", { code: "invalid_response", action: "fix_client", scope: "server" });
  }
  return {
    alias,
    aliasGeneration: value.alias_generation,
    offlineDelivery: value.offline_delivery,
    ...(mutation ? { changed: value.changed } : {}),
  };
}

function aliasRoomOfflineDelivery(value: any, alias: string, roomId: string, mutation: boolean): AliasRoomOfflineDelivery {
  const global = aliasOfflineDelivery(value, alias, mutation);
  if (value?.room_id !== roomId || typeof value?.room_offline_delivery !== "boolean" || typeof value?.effective_offline_delivery !== "boolean") {
    throw new ParleApiError("Parle alias room offline-delivery response was invalid", { code: "invalid_response", action: "fix_client", scope: "server" });
  }
  return { ...global, roomId, roomOfflineDelivery: value.room_offline_delivery, effectiveOfflineDelivery: value.effective_offline_delivery };
}

export async function getOwnAliasOfflineDelivery(transport: AliasTransport, alias: string, signal?: AbortSignal): Promise<AliasOfflineDelivery> {
  alias = validAlias(alias);
  const value = await transport.request(`/v/agent/session-aliases/${encodeURIComponent(alias)}/offline-delivery`, { session: true, signal, retry: true });
  return aliasOfflineDelivery(value, alias, false);
}

export async function disableOwnAliasOfflineDelivery(transport: AliasTransport, alias: string, signal?: AbortSignal): Promise<AliasOfflineDelivery> {
  alias = validAlias(alias);
  const value = await transport.request(`/v/agent/session-aliases/${encodeURIComponent(alias)}/offline-delivery/disable`, { method: "POST", body: {}, session: true, signal, retry: false });
  return aliasOfflineDelivery(value, alias, true);
}

export async function getOwnAliasRoomOfflineDelivery(transport: AliasTransport, roomId: string, alias: string, signal?: AbortSignal): Promise<AliasRoomOfflineDelivery> {
  alias = validAlias(alias);
  const value = await transport.request(`/v/rooms/${encodeURIComponent(roomId)}/my-session-aliases/${encodeURIComponent(alias)}/offline-delivery`, { session: true, roomId, signal, retry: true });
  return aliasRoomOfflineDelivery(value, alias, roomId, false);
}

export async function disableOwnAliasRoomOfflineDelivery(transport: AliasTransport, roomId: string, alias: string, signal?: AbortSignal): Promise<AliasRoomOfflineDelivery> {
  alias = validAlias(alias);
  const value = await transport.request(`/v/rooms/${encodeURIComponent(roomId)}/my-session-aliases/${encodeURIComponent(alias)}/offline-delivery/disable`, { method: "POST", body: {}, session: true, roomId, signal, retry: false });
  return aliasRoomOfflineDelivery(value, alias, roomId, true);
}

export class AliasClaimOutcomeUnknownError extends ParleApiError {
  // Hosts that predate the typed error still branch on this flag.
  readonly aliasClaimOutcomeUnknown = true;
}

export async function ownAliasFacts(transport: AliasTransport, alias: string, signal?: AbortSignal): Promise<AliasFacts> {
  const facts = await transport.request(`/v/agent/session-aliases/${encodeURIComponent(alias)}`, { signal, retry: true });
  const current = facts?.current_agent_session_id;
  if (facts?.alias !== alias || !Number.isInteger(facts?.generation) || facts.generation < 0 || (current !== null && current !== undefined && typeof current !== "string")) {
    throw new ParleApiError("Parle session alias lookup returned invalid facts", { code: "invalid_response", action: "fix_client", scope: "server" });
  }
  return { alias, generation: facts.generation, ...(typeof current === "string" ? { currentAgentSessionId: current } : {}) };
}

export async function findInventorySession(transport: AliasTransport, predicate: (item: any) => boolean, signal?: AbortSignal): Promise<any | undefined> {
  let after: string | undefined;
  for (let page = 0; page < SESSION_INVENTORY_MAX_PAGES; page += 1) {
    const path = after ? `/v/agent/sessions?after=${encodeURIComponent(after)}` : "/v/agent/sessions";
    const inventory = await transport.request(path, { signal, retry: true });
    const sessions = Array.isArray(inventory.sessions) ? inventory.sessions : [];
    const match = sessions.find(predicate);
    if (match) return match;
    if (inventory.next === null || inventory.next === undefined) return undefined;
    if (typeof inventory.next !== "string" || inventory.next.length === 0) {
      throw new ParleApiError("Parle session inventory returned an invalid continuation cursor", { code: "invalid_response", action: "fix_client", scope: "server" });
    }
    after = inventory.next;
  }
  throw new ParleApiError(`Parle session inventory exceeded ${SESSION_INVENTORY_MAX_PAGES} pages`, { code: "inventory_limit", action: "stop", scope: "agent_session" });
}

// One exact, generation-fenced claim. A conflict is terminal for this
// candidate. A lost response is resolved against the durable alias fence
// rather than replayed blindly, because a replay could supersede a claim this
// process already won.
export async function claimAliasWithRecovery(
  transport: AliasTransport,
  candidate: { agentSessionId: string; sessionHandle: string },
  alias: string,
  expectedGeneration: number,
  signal?: AbortSignal,
): Promise<any> {
  const path = `/v/agent/sessions/${encodeURIComponent(candidate.agentSessionId)}/claim-alias`;
  const body = { alias, expected_generation: expectedGeneration };
  let lastError: unknown;
  for (let attempt = 1; attempt <= CLAIM_RECOVERY_ATTEMPTS; attempt += 1) {
    try {
      return await transport.request(path, { method: "POST", body, sessionCredential: candidate.sessionHandle, signal, rawResponse: true, retry: false });
    } catch (error: any) {
      // Status-based, not instanceof-based: every adapter transport carries a
      // status, and a claim conflict must stay terminal no matter which error
      // shape a host constructs.
      const status: number | undefined = typeof error?.status === "number" ? error.status : undefined;
      if (status === 409) throw error;
      const responseLost = status === undefined || status >= 500;
      if (!responseLost) throw error;
      lastError = error;
      let facts: AliasFacts | undefined;
      try {
        facts = await ownAliasFacts(transport, alias, signal);
      } catch {
        // Alias lookup failure does not broaden the exact replay budget.
      }
      if (facts?.currentAgentSessionId === candidate.agentSessionId && facts.generation === expectedGeneration + 1) {
        const confirmedGeneration = facts.generation;
        let committed: any;
        try {
          committed = await findInventorySession(transport, (item) => item?.agent_session_id === candidate.agentSessionId
            && item?.alias === alias
            && item?.generation === confirmedGeneration, signal);
        } catch (error) {
          throw new ParleApiError(`Parle alias claim committed but live candidate confirmation failed: ${redactString(error instanceof Error ? error.message : String(error))}`, {
            code: "alias_claim_committed_confirmation_unavailable", action: "retry_with_backoff", scope: "agent_session", retryable: true,
          });
        }
        if (committed) return committed;
        throw new ParleApiError("Parle alias claim committed but the candidate session is no longer live; start a fresh preparation cycle", {
          code: "alias_claim_committed_session_unavailable", action: "rebootstrap", scope: "agent_session", retryable: false,
        });
      }
      if (signal?.aborted) break;
    }
  }
  const detail = lastError instanceof Error ? redactString(lastError.message) : "claim response unavailable";
  throw new AliasClaimOutcomeUnknownError(`Parle alias claim outcome remains unknown after bounded exact replay and alias confirmation: ${detail}`, {
    code: "alias_claim_outcome_unknown", action: "retry_with_backoff", scope: "agent_session", retryable: true,
  });
}
