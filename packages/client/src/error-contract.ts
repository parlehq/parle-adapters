export const ERROR_ACTIONS = [
  "retry",
  "retry_with_backoff",
  "backoff",
  "rebootstrap",
  "reauthorize",
  "fix_client",
  "stop",
] as const;

export const ERROR_SCOPES = [
  "request",
  "agent_token",
  "agent_session",
  "room_access",
  "moderation",
  "rate_limit",
  "server",
] as const;

export type ErrorAction = (typeof ERROR_ACTIONS)[number];
export type ErrorScope = (typeof ERROR_SCOPES)[number];

export type ErrorRegistryEntry = {
  status: number;
  action: ErrorAction;
  scope: ErrorScope;
  retryable: boolean;
};

function retryable(action: ErrorAction): boolean {
  return action === "retry" || action === "retry_with_backoff" || action === "backoff";
}

const entries = {
  malformed_request: { status: 400, action: "fix_client", scope: "request" },
  unsupported_parle_version: { status: 400, action: "fix_client", scope: "request" },
  payload_too_large: { status: 413, action: "fix_client", scope: "request" },
  invalid_agent_token: { status: 401, action: "reauthorize", scope: "agent_token" },
  invalid_agent_session: { status: 401, action: "rebootstrap", scope: "agent_session" },
  agent_session_expired: { status: 401, action: "rebootstrap", scope: "agent_session" },
  agent_session_ended: { status: 401, action: "rebootstrap", scope: "agent_session" },
  agent_session_superseded: { status: 401, action: "rebootstrap", scope: "agent_session" },
  participant_revoked: { status: 403, action: "stop", scope: "room_access" },
  room_not_found: { status: 404, action: "stop", scope: "room_access" },
  agent_session_mismatch: { status: 404, action: "stop", scope: "agent_session" },
  moderation_pending: { status: 409, action: "retry_with_backoff", scope: "moderation" },
  address_not_deliverable: { status: 422, action: "stop", scope: "room_access" },
  delivery_ack_rejected: { status: 409, action: "stop", scope: "request" },
  rate_limited: { status: 429, action: "backoff", scope: "rate_limit" },
  server_error: { status: 500, action: "retry_with_backoff", scope: "server" },
  service_unavailable: { status: 503, action: "retry_with_backoff", scope: "server" },
  moderation_saturated: { status: 503, action: "backoff", scope: "rate_limit" },
  participant_held_cap: { status: 503, action: "backoff", scope: "rate_limit" },
  idempotency_conflict: { status: 409, action: "stop", scope: "request" },
  validation_failed: { status: 422, action: "fix_client", scope: "request" },
  csrf_rejected: { status: 403, action: "fix_client", scope: "request" },
  already_member: { status: 409, action: "stop", scope: "room_access" },
  forbidden: { status: 403, action: "stop", scope: "room_access" },
  token_quota_exceeded: { status: 403, action: "stop", scope: "agent_token" },
  step_up_required: { status: 403, action: "stop", scope: "request" },
  link_conflict: { status: 409, action: "stop", scope: "request" },
  too_many_steps: { status: 422, action: "fix_client", scope: "request" },
  moderation_config_too_large: { status: 422, action: "fix_client", scope: "request" },
  cursor_gap: { status: 409, action: "retry", scope: "request" },
  stream_reset: { status: 409, action: "retry_with_backoff", scope: "server" },
} satisfies Record<string, Omit<ErrorRegistryEntry, "retryable">>;

export const ERROR_REGISTRY: Record<string, ErrorRegistryEntry> = Object.fromEntries(
  Object.entries(entries).map(([code, entry]) => [code, { ...entry, retryable: retryable(entry.action) }]),
);
