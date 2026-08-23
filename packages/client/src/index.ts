import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RUNTIME_SCHEMA_VERSION, processStartedAtIso, pruneRuntimeFiles, removeRuntimeFile, writeRuntimeFile } from "./runtime-file.js";
import { assertClientInstanceId, assertClientName, assertClientVersion, processClientInstanceId } from "./process-instance.js";
import { parseErrorEnvelope, type ErrorAction, type ErrorScope } from "./error-envelope.js";
import { DEFAULT_VERSION, ParleApiError, isParleCredential, isValidSessionAlias, parleApiErrorFields, redactString } from "./protocol.js";
import { AliasClaimOutcomeUnknownError, claimAliasWithRecovery as claimAliasShared, disableOwnAliasOfflineDelivery as disableOwnAliasOfflineDeliveryShared, disableOwnAliasRoomOfflineDelivery as disableOwnAliasRoomOfflineDeliveryShared, getOwnAliasOfflineDelivery as getOwnAliasOfflineDeliveryShared, getOwnAliasRoomOfflineDelivery as getOwnAliasRoomOfflineDeliveryShared, ownAliasFacts as ownAliasFactsShared, type AliasFacts, type AliasTransport } from "./alias.js";
import { ProfileConfigError, ProfileDeletionError, catalogGitExposureWarning, deleteProfile as deleteProfileFromCatalog, loadProfile, profileCatalogHasProfile, resolveProfileCatalogPath, type CredentialProfile, type DeleteProfileParams } from "./profiles.js";
import { FENCE_SUFFIX, assertSafeBase, compactServerWrappedContent, truncateText } from "./helpers.js";
import { isOpaqueReplyRouteId } from "./reply.js";
import { enrollKnownAddress, shortenKnownAddressAfterUnprocessable } from "./known-address-registry.js";
import { inspectResponsiveDeliveryPid, pruneResponsiveDeliverySnapshots } from "./responsive-delivery.js";

export * from "./protocol.js";
export * from "./account.js";
export * from "./hardening.js";
export * from "./format.js";
export * from "./room-inventory.js";
export * from "./runtime-file.js";
export * from "./safe-file.js";
export * from "./responsive-delivery.js";
export * from "./process-instance.js";
export * from "./delivery.js";
export * from "./known-address-registry.js";
export * from "./alias.js";
export * from "./helpers.js";
export * from "./reply.js";
export * from "./launches.js";
export { parseErrorEnvelope, type ErrorAction, type ErrorScope, type ParsedErrorEnvelope } from "./error-envelope.js";
export { PROFILE_CATALOG_PATH, PROFILE_LABEL_RE, ProfileConfigError, ProfileDeletionError, ProfileNotFoundError, catalogGitExposureWarning, deleteProfile, loadProfile, parseProfiles, profileCatalogExists, profileCatalogHasProfile, profileCatalogPath, profileSectionRange, readProfiles, resolveProfileCatalogPath, type CredentialProfile, type DeleteProfileOptions, type DeleteProfileParams } from "./profiles.js";

export const DEFAULT_API_BASE = "https://api.parle.sh";
export const DEFAULT_WAKE_BASE = "https://wake.parle.sh";
export const DEFAULT_READ_MESSAGE_LIMIT = 50;
export const READ_LIMIT_BYTES = 256 * 1024;
// Floor for a caller-supplied byte budget. capProjectionMessages truncates a
// row's content to at least 512 bytes before giving up on it, so a budget under
// that cannot express "fit fewer bytes" — it only decides whether the row is
// surfaced whole. Clamping keeps a tiny or accidental limitBytes from turning
// every read into a single oversized row.
export const MIN_READ_LIMIT_BYTES = 1024;
// ADR-0106: a room read returns one server-owned candidate page, so deep
// catch-up needs several round trips. Draining is always EXPLICIT and always
// bounded: no read path loops on has_more on its own, and the explicit drain
// stops at this many pages rather than pulling an unbounded transcript into
// process or model context. Exhausting the cap is an error, never a silently
// truncated prefix.
export const DEFAULT_MAX_DRAIN_PAGES = 10;

export function cleanupLocalAdapterState(cwd: string, now = new Date()): void {
  for (const cleanup of [
    () => pruneRuntimeFiles(cwd, now),
    () => pruneResponsiveDeliverySnapshots(cwd, { now, inspectPid: inspectResponsiveDeliveryPid }),
  ]) {
    try { cleanup(); } catch { /* Local state hygiene must never block client construction. */ }
  }
}
export const INBOX_REPLY_GUIDANCE = "For each returned message you answer, call parle_send with to set exactly to that message's author.address. Omitting to creates an unaddressed durable room row but no target-responsive work for that peer. If author.address is absent, do not guess from participant_id or provenance fields.";
export const INBOX_COMPLETENESS_GUIDANCE = "Manual inbox reads and responsive delivery are distinct observation paths. An empty messages array means no inbox rows were disclosed in this page. If held_backlog.held_count is positive, the result is non-exhaustive: a held row parks the shared watermark in order, so held_count does not bound how many later rows remain undisclosed. Do not conclude that no inbound or responsive messages exist; the room-level marker does not prove any held row is inbound or responsive-eligible.";
export const SEND_ATTENTION_GUIDANCE = "An explicitly known exact address may be attempted directly; the server is the sole deliverability authority. Successful sends return server-authored routing and attention. attention.inbound_scope describes inbound eligibility; attention.responsive_scope describes autonomous responsive eligibility, not wake, injection, acknowledgement, or action. Omitting to creates an unaddressed durable room row with no target-responsive work. Broadcast is likewise not a substitute for direct addressing when acknowledgement or action is required. Treat any reported responsive_scope other than target conservatively and do not infer attention from addressing or moderation. Room wake SSE hints are broad and advisory.";

const RESERVED_PROTOCOL_HEADERS = new Set([
  "authorization",
  "parle-agent-session",
  "parle-client-instance",
  "parle-client-name",
  "parle-client-version",
  "parle-integration-name",
  "parle-integration-version",
  "parle-version",
]);

export function assertNoReservedProtocolHeaders(headers?: Record<string, string>): void {
  const overridden = Object.keys(headers || {}).find((name) => RESERVED_PROTOCOL_HEADERS.has(name.toLowerCase()));
  if (overridden) throw new ParleApiError(`Caller header ${overridden} is reserved by the Parle client`, { code: "validation_failed", action: "fix_client", scope: "request" });
}

// Canonical connect guidance pending server-authored text in discovery surfaces.
// The connect result carries compactText (added by hosts that render cards, e.g.
// the MCP server); lazily established session blocks do not, so they keep the
// address-and-expiry wording.
export const CONNECT_NEXT_GUIDANCE = "Render compactText verbatim to the user as the connection card, then arm responsive delivery before going idle: host watcher if available, otherwise /v/agent/wake SSE followed by responsive-delivery?wait=0 drain and ack. Agent-session expiry ends only this session incarnation: parle_connect uses the still-valid agent token to create a replacement session. Reauthorize only when the agent token is invalid or revoked. Hosts with the parle skill arm the watcher first and add its status line to the card. Do not poll with waitSeconds.";
export const SESSION_ESTABLISHED_NEXT_GUIDANCE = "Report the session address and expiry, then arm responsive delivery before going idle: host watcher if available, otherwise /v/agent/wake SSE followed by responsive-delivery?wait=0 drain and ack. Expiry ends only this session incarnation; parle_connect creates a replacement with the still-valid agent token. Do not poll with waitSeconds.";

export type FetchLike = typeof fetch;

export type ConfigValue = {
  value?: string;
  source: string;
  warning?: string;
};

export type ParleConfig = {
  enabledInput: ConfigValue;
  apiBase: ConfigValue;
  wakeBase: ConfigValue;
  version: ConfigValue;
  roomId?: ConfigValue;
  roomHandle?: ConfigValue;
  agentToken?: ConfigValue;
  agentTokenId?: ConfigValue;
  sessionAlias?: ConfigValue;
  watchEnabled: ConfigValue;
  unreadPollIntervalSeconds: ConfigValue;
  profile?: ConfigValue;
  warnings: string[];
};

export type BootstrapState = "unstarted" | "starting" | "ready" | "failed";

export type TerminalCause = {
  status?: number;
  code?: string;
  action?: ErrorAction;
  scope?: ErrorScope;
  retryable: false;
  message: string;
  occurredAt: string;
  streak: number;
};

export type ResponsiveCursorScope = "session" | "alias";

export type RuntimeState = {
  bootstrapped: boolean;
  bootstrapState: BootstrapState;
  sessionHandle: string;
  sessionAddress: string | null;
  sessionAlias?: string;
  sessionGeneration: number;
  sessionRevision: number;
  createdAt: string;
  agentSessionId: string;
  expiresAt: string;
  // Room state lives only here. The session is roomless, so it never owns a
  // cursor, participant, handle, or unread count, and never implies a primary
  // room. Single-room callers read the sole entry through the same API.
  rooms: RoomRuntime[];
  lastHeartbeatAt?: string;
  lastHttpStatus?: number;
  lastError?: string;
  lastBootstrapError?: string;
  // The terminal cause is durable operational state. lastError-like fields may
  // be replaced by later transient failures without reopening this latch.
  terminalCause?: TerminalCause;
  nextRetryAt?: string;
  responsiveCursorScope?: ResponsiveCursorScope;
  responsiveContinuity?: "alias" | "exact_session_not_transferred";
  rolloverFailures?: number;
  rolloverLatched?: boolean;
};

export type ClientOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  randomUUID?: () => string;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  clientName?: string;
  clientVersion?: string;
  integrationName?: string;
  integrationVersion?: string;
  // Defaults to the package process singleton. Adapter-owned scratch clients
  // must pass their owner's value so rebootstrap and profile switches retain it.
  clientInstanceId?: string;
  // When set, the client publishes a display-safe per-pid runtime snapshot to
  // .parle/runtime/<pid>.json on every bootstrap state change (see runtime-file.ts)
  // and prunes provably stale sibling files at construction.
  publishRuntime?: { adapterName: string; adapterVersion?: string };
  // Hosts whose configuration knows the principal and agent handles can
  // synthesize a session address when the server response omits one. The
  // callback receives the route (alias or public session handle) and the
  // server-provided address; returning null leaves the address unset.
  synthesizeSessionAddress?: (route: { alias?: string; sessionHandle?: string }, serverAddress: string | null) => string | null;
};

export type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  authMode?: "none" | "agent_token" | "human_session";
  session?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  // Parse the raw body instead of the redacted text. Only for responses whose
  // secret fields the client must keep (session bootstrap: session_credential
  // is a parle_ses_ token that redactString would destroy). Never surface a
  // rawResponse payload; error paths stay redacted regardless.
  rawResponse?: boolean;
  retry?: boolean;
  // Internal lifecycle preparation may authenticate a candidate before it is
  // published as current. Callers should normally use session: true.
  sessionCredential?: string;
  // Explicit room authentication context. A room request always uses that
  // room's own bearer; a room never borrows another room's token. Omitted for
  // session-level operations, which use the selected session bearer.
  roomId?: string;
};

export type ReadParams = {
  sinceSeq?: number;
  waitSeconds?: number;
  limitMessages?: number;
  // Local byte budget for the rows this call surfaces, clamped to
  // [MIN_READ_LIMIT_BYTES, READ_LIMIT_BYTES]. A drain passes its REMAINING
  // aggregate budget so the caps bound the whole drain, not each page
  // separately.
  limitBytes?: number;
  advanceCursor?: boolean;
  roomId?: string;
};

// A drain reads pages from the cursor while the server reports has_more. Both
// bounds are the client's: maxPages caps the round trips (hard, and exhausting
// it is an error) and limitMessages caps what reaches model context.
export type DrainParams = ReadParams & {
  maxPages?: number;
};

export type SendParams = {
  body: string;
  to?: string;
  idempotencyKey?: string;
  roomId?: string;
};

export type SubmitReplyParams = {
  body: string;
  replyRouteId: string;
  idempotencyKey?: string;
  roomId?: string;
};

// Room-scoped runtime. Cursors, participant identity, acknowledgement state,
// and health belong to one room and never migrate to another. Room-wire and
// token failures gate only this room; session failures gate the session.
export type RoomRuntime = {
  profile?: string;
  roomId: string;
  roomHandle?: string;
  participantId: string;
  cursor: number;
  // The stream generation the cursor belongs to (#766), learned at room entry
  // and re-checked on every read. A different generation retires the cursor.
  streamGeneration?: string;
  // True once this room's cursor came from a server position (the entry
  // baseline) rather than from the uninitialized zero. An established cursor
  // is preserved across rebootstrap and recovery; a cursor that was never
  // established is the only one an entry baseline may replace, which is what
  // keeps recovery from replaying a room from zero.
  cursorEstablished?: boolean;
  // Set when a stream reset retired this room's cursor at ROOM ENTRY, where
  // there is no read result to carry the fact. The next read reports it and
  // clears it, so the caller learns its position moved for a reason.
  pendingStreamReset?: boolean;
  // Generations this room HELD and then retired, newest last and bounded. Reads
  // overlap, so a response minted before a reset can land after it: without this
  // fence its generation looks like just another change and would drag the
  // cursor and the stored generation back to retired coordinates.
  retiredGenerations?: string[];
  // How many responses this room discarded as stale. Diagnostic only.
  staleGenerationReads?: number;
  state: "ready" | "degraded";
  lastError?: string;
  unreadCount?: number;
  unreadAsOf?: string;
  heldBacklogCount?: number;
  lastAckedSeq?: number;
  lastAckEventId?: string;
  terminalCause?: TerminalCause;
  nextRetryAt?: string;
};

export type ConnectionSummary = {
  connected: boolean;
  reusedExistingSession: boolean;
  sessionAddress: string | null;
  agentSessionId: string;
  expiresAt: string;
  // One entry per configured room. A single-room session simply has one.
  rooms: RoomRuntime[];
  note: string;
  next: string;
};

export type ProfileSwitchTarget = {
  profile: string;
  roomId: string;
  changed: boolean;
};

export type ProfileSwitchPlan<Prepared> = {
  resolve(): ProfileSwitchTarget;
  prepare(target: ProfileSwitchTarget): Promise<Prepared>;
  // Commit must synchronously stop use of the old binding, adopt Prepared,
  // reset room-scoped cursor and dedup state, and publish one coherent state.
  commit(prepared: Prepared, target: ProfileSwitchTarget): void;
  discardPrepared?(prepared: Prepared, target: ProfileSwitchTarget): Promise<void> | void;
  retireOldSession(): Promise<void> | void;
  restartWatcher?(prepared: Prepared, target: ProfileSwitchTarget): Promise<void> | void;
};

export type ProfileSwitchResult = {
  switched: boolean;
  profile: string;
  roomId: string;
  reason?: "already_active";
  watcherRestarted: boolean;
  warnings: string[];
};

export type ClientProfileSwitchResult = ProfileSwitchResult & {
  previousProfile?: string;
  sessionAddress: string | null;
  agentSessionId: string;
  expiresAt: string;
  rooms: RoomRuntime[];
  watcherRestartRequired: boolean;
};

// Room entry can fail two ways with very different blast radius. A room-wire
// or token denial degrades one room; a rejection of the session credential
// itself means no room in the set can be entered with this session.
function isSessionScopeEntryFailure(error: unknown): boolean {
  return error instanceof ParleApiError && (error.scope === "agent_session" || error.action === "rebootstrap");
}

// The server intentionally returns an opaque denial here, so the hint names the
// likeliest cause without claiming the adapter proved it.
function sessionScopeEntryHint(error: unknown, roomCount: number): unknown {
  if (roomCount < 2 || !isSessionScopeEntryFailure(error) || !(error instanceof ParleApiError)) return error;
  return new ParleApiError(`${error.message} This aborted the whole configured room set. Profiles referencing different durable agents are the most common cause, but the server denial does not identify one.`, {
    status: error.status, code: error.code, action: error.action, scope: error.scope, retryable: error.retryable, retryAfterMs: error.retryAfterMs, details: error.details,
  });
}

function sameRoomSet(a: RoomRuntime[], b: RoomRuntime[]): boolean {
  const left = a.map((room) => room.roomId).sort().join(",");
  return left === b.map((room) => room.roomId).sort().join(",") && left.length > 0;
}

function terminalCauseFor(api: ParleApiError, occurredAt = new Date().toISOString()): TerminalCause | undefined {
  if (!["fix_client", "reauthorize", "stop"].includes(api.action || "")) return undefined;
  return {
    status: api.status,
    code: api.code,
    action: api.action,
    scope: api.scope,
    retryable: false,
    message: redactString(api.message),
    occurredAt,
    streak: 1,
  };
}

function projectRuntimeStatus(runtime: RuntimeState): RuntimeState {
  const projected = { ...runtime };
  if (projected.lastError === projected.lastBootstrapError) delete projected.lastError;
  return projected;
}

// A claim conflict means another session won the alias first. The live profile
// is untouched, but alias authority may already have moved elsewhere, so the
// caller is told rather than left to infer it from a bare 409.
function aliasClaimConflictHint(error: unknown, alias?: string): unknown {
  if (!alias || !(error instanceof ParleApiError) || error.status !== 409) return error;
  return new ParleApiError(`Parle profile switch left the live profile unchanged: the alias ${alias} was claimed by another session first, so an external winner may already hold alias authority.`, {
    status: 409,
    code: error.code || "alias_claim_conflict",
    action: "retry_with_backoff",
    scope: "agent_session",
    retryable: true,
  });
}

// Profile switching is local adapter lifecycle, not Parle wire meaning. L1 owns
// only the prepare-then-commit ordering and failure boundary; bridges keep their
// credential-bearing bootstrap, runtime state, and watcher mechanics.
export async function performProfileSwitch<Prepared>(plan: ProfileSwitchPlan<Prepared>): Promise<ProfileSwitchResult> {
  const target = plan.resolve();
  if (!target.changed) {
    return { switched: false, profile: target.profile, roomId: target.roomId, reason: "already_active", watcherRestarted: false, warnings: [] };
  }
  const prepared = await plan.prepare(target);
  try {
    plan.commit(prepared, target);
  } catch (error) {
    await plan.discardPrepared?.(prepared, target);
    throw error;
  }

  const warnings: string[] = [];
  try {
    await plan.retireOldSession();
  } catch (error) {
    warnings.push(`Profile switched, but the prior agent session could not be ended: ${redactString(error instanceof Error ? error.message : String(error))}`);
  }
  let watcherRestarted = false;
  if (plan.restartWatcher) {
    try {
      await plan.restartWatcher(prepared, target);
      watcherRestarted = true;
    } catch (error) {
      warnings.push(`Profile switched, but watcher restart failed: ${redactString(error instanceof Error ? error.message : String(error))}`);
    }
  }
  return { switched: true, profile: target.profile, roomId: target.roomId, watcherRestarted, warnings };
}

export type SessionEstablishedBlock = {
  established: "this_call";
  sessionAddress: string | null;
  agentSessionId: string;
  expiresAt: string;
  next: string;
};

export type SendDeliveryStatus = {
  state: "accepted_scan_skipped" | "held_for_moderation" | "delivered" | "blocked" | "accepted_unknown";
  message: string;
  nextStep?: string;
};

export type ResponsiveDeliveryMessage = {
  seq: number;
  event_id: string;
  [key: string]: unknown;
};

export type ResponsiveDeliveryAckFence = {
  sessionRevision: number;
  agentSessionId: string;
};

export type SessionRevisionEvent = {
  revision: number;
  agentSessionId: string;
  generation: number;
  alias?: string;
  reason: "bootstrap" | "rebootstrap" | "rollover" | "profile_switch" | "alias_switch";
};

export type SessionCommitPlan = {
  reason: SessionRevisionEvent["reason"];
  previous: Readonly<RuntimeState>;
  candidate: Readonly<RuntimeState>;
};

export type ResponsiveDeliveryReadFence = {
  sessionRevision: number;
  cursorScope?: ResponsiveCursorScope;
  roomId: string;
  sessionAlias?: string;
  agentSessionId: string;
};

type CandidateWakeSlot = {
  sessionCredential: string;
  response: Response;
  controller: AbortController;
};

type PreparedCandidate = {
  state: RuntimeState;
  wake?: CandidateWakeSlot;
  rooms?: Map<string, RoomRuntime>;
  // Authoritative alias facts read immediately before the claim. The prior
  // owner session id is the only sound same-agent supersession signal; token
  // strings must never be compared because rotation preserves the durable
  // agent identity.
  priorAliasOwnerSessionId?: string;
  aliasClaimed?: boolean;
};

const ROLLOVER_LEAD_MS = 5 * 60_000;
const ROLLOVER_JITTER_RANGE_MS = 60_000;
const ROLLOVER_MAX_FAILURES = 3;
const ROLLOVER_RETRY_MS = 5_000;
const ROLLOVER_COOLDOWN_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export function deterministicSessionJitterMs(agentSessionId: string): number {
  const digest = createHash("sha256").update(agentSessionId).digest();
  return digest.readUInt32BE(0) % ROLLOVER_JITTER_RANGE_MS;
}

export function sessionRolloverAtMs(session: { agent_session_id?: string; agentSessionId?: string; created_at?: string; createdAt?: string; expires_at?: string; expiresAt?: string }): number | undefined {
  const id = session.agent_session_id || session.agentSessionId || "";
  const created = Date.parse(session.created_at || session.createdAt || "");
  const expires = Date.parse(session.expires_at || session.expiresAt || "");
  if (!id || !Number.isFinite(created) || !Number.isFinite(expires)) return undefined;
  return Math.max(created, expires - ROLLOVER_LEAD_MS - deterministicSessionJitterMs(id));
}

export function responsiveCursorScope(delivery: unknown): ResponsiveCursorScope | undefined {
  const scope = (delivery as any)?.delivery?.cursor_scope;
  return scope === "session" || scope === "alias" ? scope : undefined;
}

export function responsiveDeliveryKey(message: unknown): string | undefined {
  const seq = (message as any)?.seq;
  const eventId = (message as any)?.event_id;
  if (!Number.isInteger(seq) || seq < 0 || typeof eventId !== "string" || eventId.length === 0) return undefined;
  return `${seq}:${eventId}`;
}

export function parseKeyValueFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function readKeyValueFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseKeyValueFile(readFileSync(path, "utf8"));
}

function firstConfigValue(name: string, sources: Array<{ name: string; values: Record<string, string | undefined> }>, fallback?: string): ConfigValue {
  for (const source of sources) {
    const value = source.values[name];
    if (value !== undefined && value !== "") return { value, source: source.name };
  }
  return { value: fallback, source: fallback === undefined ? "missing" : "default" };
}

// A durable alias in persistent configuration is an alias-theft footgun
// (issue #44): every future process started in that project silently
// supersedes the named route. Process environment is the deliberate,
// per-launch way to claim one.
function aliasConfig(sources: Array<{ name: string; values: Record<string, string | undefined> }>, warnings: string[]): ConfigValue {
  const alias = firstConfigValue("PARLE_SESSION_ALIAS", sources);
  if (alias.value && alias.source !== "env") {
    warnings.push(`PARLE_SESSION_ALIAS is set to ${alias.value} in ${alias.source}, so every process started here takes over that named route and supersedes the previous session. Set it in the process environment for a deliberate singleton role instead.`);
  }
  return alias;
}

function versionConfig(env: Record<string, string | undefined>, dotEnv: Record<string, string>, warnings: string[]): ConfigValue {
  if (env.PARLE_VERSION) {
    // An env value equal to the default is not an override; env-snapshotting
    // hosts (mise .env injection) make that the normal state, and a permanent
    // warning there trains readers to ignore warnings.
    if (env.PARLE_VERSION !== DEFAULT_VERSION) {
      warnings.push(`PARLE_VERSION is explicitly set in the process environment to ${env.PARLE_VERSION}, overriding the adapter default ${DEFAULT_VERSION}. Use this only for staging or rollback.`);
    }
    return { value: env.PARLE_VERSION, source: "env" };
  }
  if (dotEnv.PARLE_VERSION) warnings.push(`Ignoring PARLE_VERSION from .env (${dotEnv.PARLE_VERSION}); the adapter default is ${DEFAULT_VERSION}. Use process env only for advanced version overrides.`);
  return { value: DEFAULT_VERSION, source: "default" };
}

export function resolveProfileCatalogPathForProcess(cwd = process.cwd(), env: Record<string, string | undefined> = process.env): string {
  const dotEnv = readKeyValueFile(join(cwd, ".env"));
  return resolveProfileCatalogPath(env.PARLE_PROFILES_PATH || dotEnv.PARLE_PROFILES_PATH, cwd, env);
}

export function resolveConfig(cwd = process.cwd(), env: Record<string, string | undefined> = process.env): ParleConfig {
  const dotEnv = readKeyValueFile(join(cwd, ".env"));
  const sources = [
    { name: "env", values: env },
    { name: ".env", values: dotEnv },
  ];
  const warnings: string[] = [];
  const directBindingKeys = ["PARLE_ROOM_ID", "PARLE_ROOM_AGENT_TOKEN", "PARLE_AGENT_TOKEN_ID", "PARLE_ROOM_HANDLE", "PARLE_API_BASE", "PARLE_WAKE_BASE"];
  const directValues = directBindingKeys.map((key) => firstConfigValue(key, sources)).filter((value) => value.value);
  const explicitProfile = firstConfigValue("PARLE_PROFILE", sources);
  // PARLE_PROFILES_PATH is a non-secret setting like PARLE_PROFILE: it names
  // the catalog FILE and replaces the default path entirely (one catalog per
  // process, no layering). It is not a direct-binding variable.
  const catalogOverride = firstConfigValue("PARLE_PROFILES_PATH", sources);
  const catalogPath = resolveProfileCatalogPath(catalogOverride.value, cwd, env);
  const gitExposure = catalogGitExposureWarning(catalogPath);
  if (gitExposure) warnings.push(gitExposure);
  const profileSelector = explicitProfile.value
    ? explicitProfile
    : directValues.length === 0 && profileCatalogHasProfile("default", catalogPath)
      ? { value: "default", source: "profile_catalog" }
      : explicitProfile;
  let profile: CredentialProfile | undefined;
  if (profileSelector.value) {
    if (directValues.length) {
      const conflicts = directValues.map((value) => `${value.source}`);
      throw new ProfileConfigError(`PARLE_PROFILE from ${profileSelector.source} conflicts with direct configuration (${conflicts.join(", ")}). Remove the direct variables or unset PARLE_PROFILE.`);
    }
    profile = loadProfile(profileSelector.value, catalogPath);
  }
  const profileValue = (name: string, value: string | undefined): ConfigValue | undefined => value === undefined ? undefined : { value, source: `profile:${profile!.name}` };
  const wakeBaseExplicit = profile
    ? profile.wakeBase !== undefined
    : Boolean(firstConfigValue("PARLE_WAKE_BASE", sources).value);
  const cfg: ParleConfig = {
    enabledInput: firstConfigValue("PARLE_ENABLED", sources, "1"),
    apiBase: profile ? profileValue("PARLE_API_BASE", profile.apiBase ?? DEFAULT_API_BASE)! : firstConfigValue("PARLE_API_BASE", sources, DEFAULT_API_BASE),
    wakeBase: profile ? profileValue("PARLE_WAKE_BASE", profile.wakeBase ?? DEFAULT_WAKE_BASE)! : firstConfigValue("PARLE_WAKE_BASE", sources, DEFAULT_WAKE_BASE),
    version: versionConfig(env, dotEnv, warnings),
    roomId: profile ? profileValue("PARLE_ROOM_ID", profile.roomId) : firstConfigValue("PARLE_ROOM_ID", sources),
    roomHandle: profile ? undefined : firstConfigValue("PARLE_ROOM_HANDLE", sources),
    agentToken: profile ? profileValue("PARLE_ROOM_AGENT_TOKEN", profile.agentToken) : firstConfigValue("PARLE_ROOM_AGENT_TOKEN", sources),
    agentTokenId: profile ? profileValue("PARLE_AGENT_TOKEN_ID", profile.agentTokenId) : firstConfigValue("PARLE_AGENT_TOKEN_ID", sources),
    sessionAlias: aliasConfig(sources, warnings),
    watchEnabled: firstConfigValue("PARLE_WATCH_ENABLED", sources, "1"),
    unreadPollIntervalSeconds: firstConfigValue("PARLE_UNREAD_POLL_INTERVAL_SECONDS", sources, "60"),
    profile: profileSelector.value ? profileSelector : undefined,
    warnings,
  };
  for (const value of [cfg.apiBase, cfg.wakeBase, cfg.version, cfg.roomId, cfg.roomHandle, cfg.agentToken, cfg.agentTokenId, cfg.sessionAlias, cfg.watchEnabled]) {
    if (value?.warning) cfg.warnings.push(value.warning);
  }
  if (wakeBaseExplicit && cfg.wakeBase.value === cfg.apiBase.value) {
    cfg.warnings.push(`PARLE_WAKE_BASE explicitly matches PARLE_API_BASE (${cfg.apiBase.value}). Responsive delivery normally uses ${DEFAULT_WAKE_BASE}.`);
  }
  return cfg;
}

// One configured room binding. Profile catalog entries stay atomic: each names
// exactly one room-bound credential, and PARLE_PROFILES only selects which of
// them this process operates. There is no default room and no ordering
// promise beyond deterministic session-auth bearer selection.
export type ParleRoomSet = {
  mode: "single" | "multi";
  rooms: ParleConfig[];
  warnings: string[];
};

function requestOrigin(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

// Every rejection here happens before any network activity and before a
// session credential is minted, because a mixed-origin or cross-agent set
// cannot be repaired after the session exists.
export function resolveRoomSet(cwd = process.cwd(), env: Record<string, string | undefined> = process.env): ParleRoomSet {
  const dotEnv = readKeyValueFile(join(cwd, ".env"));
  const sources = [
    { name: "env", values: env },
    { name: ".env", values: dotEnv },
  ];
  // An empty PARLE_PROFILES is indistinguishable from unset by design: config
  // resolution treats "" as absent everywhere, so an exported-but-empty
  // variable falls back to single-room selection instead of failing a shell
  // that merely exported the name. A present-but-separator-only value is a
  // real selector with no profiles in it and is rejected below.
  const selector = firstConfigValue("PARLE_PROFILES", sources);
  if (!selector.value) return { mode: "single", rooms: [resolveConfig(cwd, env)], warnings: [] };

  const explicitProfile = firstConfigValue("PARLE_PROFILE", sources);
  if (explicitProfile.value) {
    throw new ProfileConfigError(`PARLE_PROFILES from ${selector.source} conflicts with PARLE_PROFILE from ${explicitProfile.source}. Multi-room mode is an explicit startup selector; choose one.`);
  }
  const directBindingKeys = ["PARLE_ROOM_ID", "PARLE_ROOM_AGENT_TOKEN", "PARLE_AGENT_TOKEN_ID", "PARLE_ROOM_HANDLE"];
  const direct = directBindingKeys.map((key) => ({ key, value: firstConfigValue(key, sources) })).filter((item) => item.value.value);
  if (direct.length) {
    throw new ProfileConfigError(`PARLE_PROFILES from ${selector.source} conflicts with direct room configuration (${direct.map((item) => `${item.key} from ${item.value.source}`).join(", ")}). Remove the direct variables or unset PARLE_PROFILES.`);
  }

  const names = selector.value.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length === 0) throw new ProfileConfigError(`PARLE_PROFILES from ${selector.source} names no profiles. Name each profile explicitly; the catalog is never selected implicitly.`);
  const duplicateName = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicateName) throw new ProfileConfigError(`PARLE_PROFILES lists ${duplicateName} more than once. Each profile may appear only once.`);

  // Order is preserved only so bearer selection is deterministic.
  const rooms = names.map((name) => resolveConfig(cwd, { ...env, PARLE_PROFILE: name, PARLE_PROFILES: undefined }));
  const warnings: string[] = [];
  const seenRooms = new Map<string, string>();
  for (const [index, room] of rooms.entries()) {
    const roomId = room.roomId?.value;
    if (!roomId || !room.agentToken?.value) throw new ProfileConfigError(`Parle profile ${names[index]} does not provide a complete room binding.`);
    const previous = seenRooms.get(roomId);
    if (previous) throw new ProfileConfigError(`PARLE_PROFILES maps ${previous} and ${names[index]} to the same room. Each room may be configured once.`);
    seenRooms.set(roomId, names[index]);
    warnings.push(...room.warnings);
  }
  const apiOrigins = new Set(rooms.map((room) => requestOrigin(room.apiBase.value)));
  const wakeOrigins = new Set(rooms.map((room) => requestOrigin(room.wakeBase.value)));
  if (apiOrigins.size > 1 || wakeOrigins.size > 1) {
    throw new ProfileConfigError(`PARLE_PROFILES mixes Parle origins (api: ${[...apiOrigins].join(", ")}; wake: ${[...wakeOrigins].join(", ")}). One session cannot span deployments.`);
  }
  return { mode: "multi", rooms, warnings: [...new Set(warnings)] };
}

function parseJsonMaybe(text: string): any {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export function formatVersionErrorHint(cfg: { version: { value?: string; source: string } }, errorObj: any): string {
  const sent = cfg.version.value || DEFAULT_VERSION;
  const supported = Array.isArray(errorObj?.supported) ? errorObj.supported.join(", ") : typeof errorObj?.supported === "string" ? errorObj.supported : undefined;
  const current = typeof errorObj?.current === "string" ? errorObj.current : undefined;
  const server = supported ? ` Server supports ${supported}.` : current ? ` Server current version is ${current}.` : "";
  const action = cfg.version.source === "default" ? "Upgrade the adapter." : "Unset the stale PARLE_VERSION override or upgrade the adapter.";
  return ` Sent Parle-Version ${sent} from ${cfg.version.source}; adapter default is ${DEFAULT_VERSION}.${server} ${action}`;
}

const REQUEST_RETRY_ATTEMPTS = 5;
const REQUEST_RETRY_WINDOW_MS = 60_000;

// Edge and gateway failures can lack the server-authored error envelope.
function retryableFromEnvelopeOrStatus(retryable: boolean | undefined, status: number): boolean {
  return retryable ?? (status === 429 || status >= 500);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function retryDelayMs(error: ParleApiError, attempt: number): number {
  if (typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) return Math.trunc(error.retryAfterMs);
  if (error.action === "retry") return 250;
  const base = Math.min(10_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.trunc(base * (0.8 + Math.random() * 0.4));
}

export function terminalStatusFor(error: ParleApiError): string {
  switch (error.action) {
    case "fix_client":
      return "Parle stopped: client request is invalid; upgrade or repair the adapter.";
    case "reauthorize":
      return "Parle stopped: agent token is invalid or revoked; reauthorize the agent.";
    case "rebootstrap":
      return "Parle stopped: this agent session ended; parle_connect can create a replacement with the still-valid agent token, then re-arm.";
    case "backoff":
      return `Parle paused: retry scheduled after ${formatDuration(error.retryAfterMs ?? 0)} (${error.code || "backoff"}).`;
    case "stop":
      return error.scope === "agent_session"
        ? "Parle stopped: agent session could not be rebootstrapped; reauthorize or restart."
        : "Parle stopped: client request is invalid; upgrade or repair the adapter.";
    default:
      return error.retryable ? `Parle paused: retry scheduled after ${formatDuration(error.retryAfterMs ?? 0)}.` : "Parle stopped: client request is invalid; upgrade or repair the adapter.";
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "the server-provided delay";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.ceil(ms / 1000);
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

// Structural header rules run first. The one conservative Parle credential
// shape then catches known and future lowercase families without a registry.
export function redactedValue(value?: ConfigValue): { source: string; configured: boolean; value?: string } {
  if (!value?.value) return { source: value?.source || "missing", configured: false };
  const sensitiveShape = isParleCredential(value.value) || value.value.includes("__Host-parle_session");
  return { source: value.source, configured: true, value: sensitiveShape ? redactString(value.value) : value.value };
}

export function redactedSecretValue(value?: ConfigValue): { source: string; configured: boolean; value?: string } {
  return { source: value?.source || "missing", configured: Boolean(value?.value), value: value?.value ? "<redacted>" : undefined };
}


export function clampWaitSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(30, Math.trunc(value))) : 0;
}

export function requestUrl(cfg: ParleConfig, pathOrUrl: string): URL {
  const base = cfg.apiBase.value || DEFAULT_API_BASE;
  return pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://") ? new URL(pathOrUrl) : new URL(pathOrUrl, base);
}

export function wakeUrl(cfg: ParleConfig): URL {
  return new URL("/v/agent/wake", cfg.wakeBase.value || cfg.apiBase.value || DEFAULT_WAKE_BASE);
}

export function parseSSEBlocks(buffer: string): { events: Array<{ event: string; data: string }>; rest: string } {
  const events: Array<{ event: string; data: string }> = [];
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() || "";
  for (const block of parts) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
    }
    if (data.length > 0 || event !== "message") events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

function maxSurfacedSeq(cursor: number, messages: unknown[]): number {
  let next = cursor || 0;
  for (const message of messages) {
    const seq = typeof (message as any)?.seq === "number" ? (message as any).seq : 0;
    if (seq > next) next = seq;
  }
  return next;
}

export function pageProgress(response: unknown): number | undefined {
  const next = (response as any)?.next_since_seq;
  return Number.isSafeInteger(next) && next >= 0 ? next : undefined;
}

export function pageHasMore(response: unknown): boolean {
  return (response as any)?.has_more === true;
}

/**
 * The ADR-0106 continuation rule. A response is ONE bounded page of the delta
 * after the cursor, and `next_since_seq` is that page's own scan progress:
 * following it consumes blocked, own-authored and differently addressed rows
 * without ever passing an allowed row the page did not return.
 *
 * The returned `watermark` is never a cursor. It is participant-wide disclosure
 * authorization that a concurrent read for the same participant can push past
 * the rows this response carried, so adopting it would skip undisclosed rows.
 *
 * Two cases fall back to the returned rows themselves:
 *  - `droppedRows`: the local response cap surfaced fewer rows than the server
 *    returned, so progress must stop at the last row the caller actually saw.
 *  - no `next_since_seq` at all (ADR-0106 item 9, the permanent rollback
 *    valve): the envelope is a complete delta, and its next cursor is the
 *    response-local max(current cursor, max returned seq).
 */
export function nextCursorFromPage(cursor: number, messages: unknown[], response?: unknown, droppedRows = false): number {
  const surfaced = maxSurfacedSeq(cursor, messages);
  if (droppedRows) return surfaced;
  const progress = pageProgress(response);
  return progress !== undefined && progress > surfaced ? progress : surfaced;
}

// ADR-0106 item 7: room entry returns the held-safe starting position for this
// participant — at room head, or parked immediately before the first retained
// held row, and never below the retention floor. It is a CURSOR, never a
// watermark, and it is the only thing a fresh room read needs: replaying
// retained history to discover a starting point is what made the first read of
// a deep room cost the whole transcript.
function entryBaselineSeq(entry: any): number {
  const baseline = entry?.baseline_seq;
  return Number.isSafeInteger(baseline) && baseline >= 0 ? baseline : 0;
}

// How many retired generations a room remembers. The fence only has to outlive
// the requests that were already in flight when a reset landed, so a small
// window is enough and keeps a long-lived room from accumulating strings.
const MAX_RETIRED_GENERATIONS = 8;

/**
 * Record a response's generation as the room's current one, RETIRING the
 * generation it replaces. Every adoption goes through here, so the fence below
 * is complete by construction rather than by remembering to update it.
 */
function adoptStreamGeneration(room: RoomRuntime, source: any): void {
  const generation = source?.generation;
  if (typeof generation !== "string" || !generation || generation === room.streamGeneration) return;
  if (room.streamGeneration) {
    const retired = (room.retiredGenerations ?? []).filter((entry) => entry !== room.streamGeneration);
    retired.push(room.streamGeneration);
    room.retiredGenerations = retired.slice(-MAX_RETIRED_GENERATIONS);
  }
  room.streamGeneration = generation;
}

/**
 * Whether a response belongs to a generation this room already retired.
 *
 * Reads overlap. A request minted before a reset can land after the reset was
 * adopted, and its generation differs from the stored one exactly the way a
 * genuine change does — so without this fence a delayed response would be read
 * as another reset and would drag the cursor and the stored generation back to
 * coordinates that no longer exist. Fencing on what the room has HELD is enough
 * to tell "stale" from "new to us"; the two never look alike, because a
 * generation the room never held cannot be in this list.
 */
function isStaleGeneration(room: RoomRuntime, source: any): boolean {
  const generation = source?.generation;
  return typeof generation === "string" && Boolean(generation)
    && generation !== room.streamGeneration
    && (room.retiredGenerations ?? []).includes(generation);
}

/**
 * Whether a response's stream generation retires the cursor this room holds
 * (#766). It must be asked BEFORE the new generation is recorded: once
 * adopted, the comparison can never fail and an established cursor from the
 * retired stream would be preserved — its seq numbers name rows in a stream
 * that no longer exists, so the room would read nothing new until the fresh
 * stream's seqs happened to pass the stale number.
 */
function retiresCursor(room: RoomRuntime, source: any): boolean {
  const generation = source?.generation;
  return typeof generation === "string" && Boolean(generation) && Boolean(room.streamGeneration) && generation !== room.streamGeneration;
}

/**
 * Adopt the generation of a page whose ROWS ARE DISCARDED — the bootstrap and
 * recovery validation reads, which exist to prove the session can read the room
 * and to pick up the held-backlog marker, not to deliver messages.
 *
 * The comparison runs here too, because the stream can be replaced between room
 * entry and this read: entry hands back a generation and a baseline, and if the
 * page comes back under a different generation the baseline is already a number
 * from a stream that no longer exists. Adopting the new generation while keeping
 * that cursor strands the room AND hides every later reset, since the stored
 * generation would then match forever.
 *
 * The replacement position must not skip the rows this page is about to throw
 * away, and the request's own since_seq names the retired stream, so the safe
 * position is immediately before the earliest row the page disclosed — or, when
 * it disclosed none, its own progress over the rows it consumed.
 */
function adoptDiscardedPageGeneration(room: RoomRuntime, page: any): void {
  if (retiresCursor(room, page)) {
    room.pendingStreamReset = true;
    const rows = Array.isArray(page?.messages) ? page.messages : [];
    const seqs = rows.map((row: any) => (typeof row?.seq === "number" ? row.seq : 0)).filter((seq: number) => seq > 0);
    room.cursor = seqs.length > 0 ? Math.max(0, Math.min(...seqs) - 1) : (pageProgress(page) ?? 0);
    room.cursorEstablished = true;
  }
  adoptStreamGeneration(room, page);
}

function refreshHeldBacklogCount(room: RoomRuntime, response: any): boolean {
  const count = response?.held_backlog?.held_count;
  if (!Number.isSafeInteger(count) || count < 0 || room.heldBacklogCount === count) return false;
  room.heldBacklogCount = count;
  return true;
}

function readCompletenessNote(surface: "projection" | "inbound", response: any, rawMessages: unknown[], droppedRows = false): string {
  const held = Number.isSafeInteger(response?.held_backlog?.held_count) && response.held_backlog.held_count > 0;
  const hasMore = pageHasMore(response) || droppedRows;
  if (rawMessages.length > 0 && !held && !hasMore) return "";
  const label = surface === "inbound" ? "inbox" : "projection";
  // ADR-0106: completeness is now a property of the PAGE, not of the returned
  // watermark. has_more is the exact statement that unread candidates remain;
  // locally dropped rows remain too, whatever the server said about its page.
  const more = droppedRows
    ? " Rows the server returned were dropped by the local response cap, so the cursor stopped at the last row shown: read again from the returned cursor."
    : hasMore
      ? " has_more is true: this page does not reach the end of the delta, so read again from the returned cursor."
      : "";
  const bounded = rawMessages.length === 0
    ? `No ${label} rows were disclosed in this page. This is one bounded page, not the whole delta.`
    : `Some ${label} rows were disclosed in this page, but this result is non-exhaustive.`;
  if (held) {
    return `${bounded}${more} A held row parks the shared watermark in order, so held_count does not bound how many later rows remain undisclosed. Do not conclude that no inbound or responsive messages exist. The held marker does not prove any held row is inbound or responsive-eligible.`;
  }
  return `${bounded}${more}`;
}

export function clampReadLimitBytes(limitBytes?: number): number {
  if (!Number.isFinite(limitBytes) || (limitBytes as number) <= 0) return READ_LIMIT_BYTES;
  return Math.min(Math.max(Math.trunc(limitBytes as number), MIN_READ_LIMIT_BYTES), READ_LIMIT_BYTES);
}

export function capProjectionMessages(messages: unknown[], maxMessages = DEFAULT_READ_MESSAGE_LIMIT, maxBytes = READ_LIMIT_BYTES) {
  const capped: unknown[] = [];
  let returnedBytes = 0;
  let truncated = messages.length > maxMessages;
  for (const message of messages.slice(0, maxMessages)) {
    const copy: any = typeof message === "object" && message !== null ? { ...(message as Record<string, unknown>) } : message;
    let text = JSON.stringify(copy);
    if (returnedBytes + Buffer.byteLength(text, "utf8") > maxBytes && copy && typeof copy === "object" && typeof copy.content === "string") {
      const remaining = Math.max(512, maxBytes - returnedBytes);
      copy.content = truncateText(copy.content, remaining).text;
      text = JSON.stringify(copy);
      truncated = true;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (returnedBytes + bytes > maxBytes) {
      truncated = true;
      // A single row larger than the whole budget is still surfaced rather than
      // returning nothing — but it is ACCOUNTED, so returnedBytes always states
      // what the caller actually received and can exceed maxBytes only by this
      // one unsplittable row.
      if (capped.length === 0) {
        capped.push(copy);
        returnedBytes += bytes;
      }
      break;
    }
    capped.push(copy);
    returnedBytes += bytes;
  }
  return { messages: capped, bytes: Buffer.byteLength(JSON.stringify(messages), "utf8"), returnedBytes, truncated };
}

export function sendAttentionWarnings(details: any): string[] | undefined {
  const attention = details?.attention;
  if (!attention || typeof attention !== "object" || !Object.hasOwn(attention, "responsive_scope")) return undefined;
  if (attention.responsive_scope === "target") return undefined;
  return [
    "Message accepted, but the server did not report attention.responsive_scope as target. Do not rely on this send to start the intended peer's responsive turn. Unaddressed and broadcast sends are durable room history, not substitutes for direct addressing when acknowledgement or action is required.",
  ];
}

export function summarizeSendDelivery(details: any): SendDeliveryStatus | undefined {
  const moderation = details?.moderation;
  if (!moderation || typeof moderation !== "object") return undefined;
  if (Object.hasOwn(moderation, "delivery_state")) {
    switch (moderation.delivery_state) {
      case "accepted_scan_skipped":
        return {
          state: "accepted_scan_skipped",
          message: "Message accepted. This room/config skipped moderation scanning, so do not describe it as awaiting moderation completion.",
        };
      case "held_for_moderation":
        return {
          state: "held_for_moderation",
          message: moderation.reason || "Message accepted but held for moderation completion.",
          nextStep: typeof details?.seq === "number" ? `Poll parle_read or parle_inbox around seq ${details.seq}; if held_backlog drains and the row never appears, it was blocked.` : "Poll parle_read or parle_inbox; if held_backlog drains and the row never appears, it was blocked.",
        };
      case "delivered":
        return { state: "delivered", message: "Message accepted and delivered." };
      case "blocked":
        return { state: "blocked", message: moderation.reason || "Message accepted but blocked and not visible to peers." };
      default:
        return {
          state: "accepted_unknown",
          message: moderation.reason || "Message accepted with an unrecognized delivery state. Treat it as non-terminal and do not infer delivery from other moderation fields.",
        };
    }
  }
  const steps = Array.isArray(moderation.steps) ? moderation.steps : [];
  if (moderation.scan === "skipped" && steps.length === 0) {
    return {
      state: "accepted_scan_skipped",
      message: "Message accepted. This room/config skipped moderation scanning, so do not describe it as awaiting moderation completion.",
    };
  }
  if (moderation.held === true) {
    return {
      state: "held_for_moderation",
      message: moderation.reason || "Message accepted but held for moderation completion.",
      nextStep: typeof details?.seq === "number" ? `Poll parle_read or parle_inbox around seq ${details.seq}; if held_backlog drains and the row never appears, it was blocked.` : "Poll parle_read or parle_inbox; if held_backlog drains and the row never appears, it was blocked.",
    };
  }
  if (moderation.delivered === true) {
    return { state: "delivered", message: "Message accepted and delivered." };
  }
  return undefined;
}

export class ParleAgentClient {
  cfg: ParleConfig;
  // Configured room bindings in selector order. Exactly one entry in
  // single-room mode; order is meaningful only for session bearer selection.
  roomConfigs: ParleConfig[];
  readonly multiRoom: boolean;
  private readonly roomRuntimes = new Map<string, RoomRuntime>();
  readonly cwd: string;
  readonly fetchImpl: FetchLike;
  readonly env: Record<string, string | undefined>;
  readonly now: () => Date;
  readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly randomUUID: () => string;
  readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  readonly clientName: string;
  readonly clientVersion?: string;
  readonly clientInstanceId: string;
  readonly integrationName?: string;
  readonly integrationVersion?: string;
  readonly publishRuntime?: { adapterName: string; adapterVersion?: string };
  runtime: RuntimeState = {
    bootstrapped: false,
    bootstrapState: "unstarted",
    sessionHandle: "",
    sessionAddress: null,
    sessionGeneration: 0,
    sessionRevision: 0,
    createdAt: "",
    agentSessionId: "",
    expiresAt: "",
    rooms: [],
  };
  private bootstrapGeneration = 0;
  private bootstrapInFlight: Promise<RuntimeState> | null = null;
  private profileSwitchInFlight = false;
  private activeProfile?: string;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private lifecycleEpoch = 0;
  private ended = false;
  private prefetchedWake?: CandidateWakeSlot;
  private rebootstrapEpisode: { failedSessionHandle: string; attempted: boolean; healthySinceMs?: number; terminal?: boolean } | null = null;
  private consecutiveBootstrapFailures = 0;
  private unreadInFlight = false;
  private unreadPollTimer: ReturnType<typeof setTimeout> | null = null;
  private rolloverTimer: ReturnType<typeof setTimeout> | null = null;
  private rolloverInFlight: Promise<RuntimeState> | null = null;
  private readonly sessionRevisionListeners = new Set<(event: SessionRevisionEvent) => void>();
  private readonly sessionCommitGuards = new Set<(plan: SessionCommitPlan) => void>();
  private readonly activeResponsiveReads = new Set<ResponsiveDeliveryReadFence>();
  // Set while a lifecycle transition is between its pre-claim guard and its
  // local publication. Responsive fences are registered outside the lifecycle
  // exclusion, so without this barrier the pre-claim guard would be advisory:
  // a read could open after the guard passed and before publication.
  private publicationBarrier?: string;
  // Data-plane calls and binding changes must not interleave (issue #28). Room
  // work takes the shared side; a profile switch takes the exclusive side, so
  // no read, send, or ack can straddle a room rebinding. A scratch client is a
  // separate instance, so its own bootstrap is never blocked by this gate.
  private dataPlaneActive = 0;
  private dataPlaneIdle?: () => void;
  private bindingChangeInFlight?: Promise<unknown>;
  // Supplied by the caller that owns the transition. Invoked inside candidate
  // preparation after every non-mutating call has succeeded and immediately
  // before the alias claim, which is the only authority-transferring step.
  private preClaimGuard?: (candidate: RuntimeState) => void;
  private readonly deriveSessionAddress: (route: { alias?: string; sessionHandle?: string }, serverAddress: string | null) => string | null;
  private lastCandidateAliasFacts?: { priorAliasOwnerSessionId?: string; aliasClaimed: boolean };
  // This latch is deliberately consulted only by automatic work. Explicit
  // connect/read/send and raw requestJson calls remain recovery paths.
  private automaticTerminalBinding?: string;
  private readonly recordedTerminalErrors = new WeakSet<object>();
  private missingAliasWarning?: string;
  readonly registryCatalogPath: string;

  constructor(options: ClientOptions = {}) {
    this.env = options.env || process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.registryCatalogPath = resolveProfileCatalogPathForProcess(this.cwd, this.env);
    const roomSet = resolveRoomSet(this.cwd, this.env);
    this.roomConfigs = roomSet.rooms;
    // The first configured room supplies the session-auth bearer and, in
    // single-room mode, is simply the room.
    this.cfg = roomSet.rooms[0];
    this.multiRoom = roomSet.mode === "multi";
    // activeProfile drives single-room profile selection and switching only.
    // In multi-room mode the environment's PARLE_PROFILES selector is already
    // the whole binding; re-injecting the bearer room's profile name as
    // PARLE_PROFILE would make every re-resolution fail the selector conflict.
    this.activeProfile = this.multiRoom ? undefined : this.cfg.profile?.value;
    this.fetchImpl = options.fetch || fetch;
    this.now = options.now || (() => new Date());
    this.sleepImpl = options.sleep || defaultSleep;
    this.randomUUID = options.randomUUID || randomUUID;
    this.setTimer = options.setTimer || ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
    this.publishRuntime = options.publishRuntime;
    this.deriveSessionAddress = options.synthesizeSessionAddress || ((_route, serverAddress) => serverAddress);
    this.clientName = assertClientName(options.clientName || options.publishRuntime?.adapterName || "@parlehq/agent-client");
    const clientVersion = options.clientVersion || options.publishRuntime?.adapterVersion;
    this.clientVersion = clientVersion ? assertClientVersion(clientVersion) : undefined;
    if (options.integrationVersion && !options.integrationName) throw new Error("Parle integrationVersion requires integrationName.");
    this.integrationName = options.integrationName ? assertClientName(options.integrationName) : undefined;
    this.integrationVersion = options.integrationVersion ? assertClientVersion(options.integrationVersion) : undefined;
    this.clientInstanceId = assertClientInstanceId(options.clientInstanceId || processClientInstanceId());
    cleanupLocalAdapterState(this.cwd, this.now());
  }

  status() {
    return {
      config: {
        enabledInput: redactedValue(this.cfg.enabledInput),
        apiBase: redactedValue(this.cfg.apiBase),
        wakeBase: redactedValue(this.cfg.wakeBase),
        version: redactedValue(this.cfg.version),
        roomId: redactedValue(this.cfg.roomId),
        roomHandle: redactedValue(this.cfg.roomHandle),
        profile: redactedValue(this.cfg.profile),
        agentToken: redactedSecretValue(this.cfg.agentToken),
        agentTokenId: { ...redactedValue(this.cfg.agentTokenId), optional: true },
      },
      // agent_session_id is room-visible operational metadata (canonical classification tracked in parlehq/parle#435); session_credential is the credential and stays redacted.
      runtime: { ...projectRuntimeStatus(this.runtime), sessionHandle: this.runtime.sessionHandle ? "<redacted>" : "" },
      rooms: this.roomConfigs.map((cfg) => {
        const roomId = cfg.roomId?.value || "";
        const room = this.roomRuntimes.get(roomId);
        return {
          roomId,
          roomHandle: room?.roomHandle || cfg.roomHandle?.value,
          profile: cfg.profile?.value,
          state: room?.state || "degraded",
          participantId: room?.participantId || "",
          cursor: room?.cursor ?? 0,
          unreadCount: room?.unreadCount,
          ...(room?.lastError ? { lastError: room.lastError } : {}),
        };
      }),
      warnings: [...this.cfg.warnings, ...(this.staleTokenHint() ? [this.staleTokenHint()!] : []), ...(this.unreadIntervalHint() ? [this.unreadIntervalHint()!] : []), ...(this.missingAliasWarning ? [this.missingAliasWarning] : [])],
    };
  }

  setup() {
    const missing = [];
    if (!this.cfg.roomId?.value) missing.push("PARLE_ROOM_ID");
    if (!this.cfg.agentToken?.value) missing.push("PARLE_ROOM_AGENT_TOKEN");
    // Connection-posture wording pending the core session lifecycle contract.
    const note = missing.length
      ? "Set PARLE_PROFILE (a section of the profile catalog, ~/.parle/profiles by default, PARLE_PROFILES_PATH to relocate) or direct configuration in env or .env (checked in that order; disk token rotations can be reloaded once during bootstrap recovery)."
      : this.runtime.bootstrapped
        ? "Parle configuration is present and this process holds a session."
        : "Parle configuration is present. Not yet connected in this process; a connect, read, or send call establishes the session.";
    const staleToken = this.staleTokenHint();
    const configured = missing.length === 0;
    return { ok: configured && !staleToken, configured, missing, connected: this.runtime.bootstrapped, apiBase: this.cfg.apiBase.value, note, ...(staleToken ? { warning: staleToken } : {}) };
  }

  // Config is resolved at construction and may be refreshed once when a
  // reauthorize bootstrap failure sees a different disk token. Compare against
  // the first disk source that defines the key (mirrors firstConfigValue precedence).
  staleTokenHint(): string | undefined {
    const current = this.cfg.agentToken?.value;
    if (!current) return undefined;
    try {
      const onDisk = readKeyValueFile(join(this.cwd, ".env"))["PARLE_ROOM_AGENT_TOKEN"];
      if (onDisk === undefined || onDisk === "") return undefined;
      if (onDisk === current) return undefined;
      return `PARLE_ROOM_AGENT_TOKEN in .env differs from the value this process loaded at startup (source: ${this.cfg.agentToken?.source}). The token was likely rotated. Parle will try to reload it during the next bootstrap; restart the host process if the terminal error remains.`;
    } catch {
      return undefined;
    }
  }

  private selectedEnvironment(profile = this.activeProfile): Record<string, string | undefined> {
    return profile ? { ...this.env, PARLE_PROFILE: profile } : this.env;
  }

  private async withLifecycleExclusion<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.lifecycleTail = previous.catch(() => undefined).then(() => gate);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private assertLifecycleActive(epoch = this.lifecycleEpoch): void {
    if (this.ended || epoch !== this.lifecycleEpoch) {
      throw new ParleApiError("Parle client lifecycle has ended", { code: "client_ended", action: "stop", scope: "agent_session" });
    }
  }

  private bindingKey(cfg = this.cfg): string {
    return [cfg.roomId?.value || "", cfg.agentToken?.value || "", cfg.apiBase.value || "", cfg.wakeBase.value || "", cfg.profile?.value || ""].join("\u0000");
  }

  private clearAutomaticTerminalLatch(): void {
    this.automaticTerminalBinding = undefined;
    this.runtime.terminalCause = undefined;
    this.runtime.nextRetryAt = undefined;
  }

  private clearRolloverStormProtection(reschedule = false): void {
    const wasCooling = Boolean(this.runtime.rolloverLatched);
    this.runtime.rolloverFailures = 0;
    this.runtime.rolloverLatched = false;
    if (reschedule && wasCooling && this.runtime.bootstrapped && !this.ended) this.scheduleRollover();
  }

  private recordTerminalCause(error: unknown): void {
    const api = error instanceof ParleApiError ? error : undefined;
    if (!api || !["fix_client", "reauthorize", "stop"].includes(api.action || "")) return;
    // A request-scoped error is about that one call, not the binding. Latching
    // on it would let a caller mistake stop this session's automatic work.
    if (api.scope === "request") return;
    const sameBinding = this.automaticTerminalBinding === this.bindingKey();
    this.automaticTerminalBinding = this.bindingKey();
    this.runtime.terminalCause = {
      status: api.status,
      code: api.code,
      action: api.action,
      scope: api.scope,
      retryable: false,
      message: redactString(api.message),
      occurredAt: this.now().toISOString(),
      streak: sameBinding ? (this.runtime.terminalCause?.streak || 0) + 1 : 1,
    };
    this.recordedTerminalErrors.add(api);
  }

  private recordRoomOperationTerminalCause(error: unknown, roomId: string, requestLocal = false): void {
    const api = error instanceof ParleApiError ? error : undefined;
    // An empty room means setup or bootstrap failed before the operation ran;
    // bootstrap already owns any binding-wide terminal record for that call.
    if (!api || !roomId || requestLocal || this.recordedTerminalErrors.has(api) || api.scope === "request" || !["fix_client", "reauthorize", "stop"].includes(api.action || "")) return;
    if (api.scope === "agent_token" || api.scope === "agent_session") {
      this.recordTerminalCause(error);
      return;
    }
    const room = this.roomRuntimes.get(roomId);
    const cause = terminalCauseFor(api, this.now().toISOString());
    if (!room || !cause) return;
    room.state = "degraded";
    room.lastError = redactString(api.message);
    room.terminalCause = cause;
    this.publishRoomRuntimes();
  }

  // Disk-backed credentials are the one safe automatic recovery input. A
  // changed binding clears only the automatic gate, never suppressing an
  // explicit caller's retry.
  private refreshConfigIfAgentTokenChanged(): boolean {
    const oldBinding = this.roomConfigs.map((room) => this.bindingKey(room)).join("|");
    const nextSet = resolveRoomSet(this.cwd, this.selectedEnvironment());
    const next = nextSet.rooms[0];
    if (oldBinding === nextSet.rooms.map((room) => this.bindingKey(room)).join("|")) return false;
    // Room bearers reload with the session binding; a rotation that misses one
    // of them would authenticate rooms with a revoked token.
    this.roomConfigs = nextSet.rooms;
    this.cfg = next;
    if (oldBinding !== this.bindingKey()) {
      this.clearAutomaticTerminalLatch();
      this.clearRolloverStormProtection();
    }
    this.runtime.lastBootstrapError = undefined;
    this.publishRuntimeState();
    return true;
  }

  assertConfigured() {
    if (!this.cfg.roomId?.value) throw new ParleApiError("Parle setup needed: PARLE_ROOM_ID is missing", { code: "setup_needed" });
    if (!this.cfg.agentToken?.value) throw new ParleApiError("Parle setup needed: PARLE_ROOM_AGENT_TOKEN is missing", { code: "setup_needed" });
    assertSafeBase(this.cfg.apiBase.value || DEFAULT_API_BASE, this.env);
    assertSafeBase(this.cfg.wakeBase.value || this.cfg.apiBase.value || DEFAULT_WAKE_BASE, this.env);
  }

  async withDataPlane<T>(fn: () => Promise<T>): Promise<T> {
    while (this.bindingChangeInFlight) await this.bindingChangeInFlight.catch(() => undefined);
    this.dataPlaneActive += 1;
    try {
      return await fn();
    } finally {
      this.dataPlaneActive -= 1;
      if (this.dataPlaneActive === 0) {
        const idle = this.dataPlaneIdle;
        this.dataPlaneIdle = undefined;
        idle?.();
      }
    }
  }

  private async withBindingChange<T>(fn: () => Promise<T>): Promise<T> {
    while (this.bindingChangeInFlight) await this.bindingChangeInFlight.catch(() => undefined);
    let release!: () => void;
    this.bindingChangeInFlight = new Promise<void>((resolve) => { release = resolve; });
    try {
      if (this.dataPlaneActive > 0) {
        await new Promise<void>((resolve) => { this.dataPlaneIdle = resolve; });
      }
      return await fn();
    } finally {
      const settle = release;
      this.bindingChangeInFlight = undefined;
      settle();
    }
  }

  // Room UUID is the only routing selector; handles and profile labels are
  // display metadata. With several rooms configured, omission fails closed
  // rather than guessing a default room.
  roomTarget(roomId?: string): ParleConfig {
    if (roomId) {
      const match = this.roomConfigs.find((room) => room.roomId?.value === roomId);
      if (match) return match;
      throw new ParleApiError(`Parle room ${roomId} is not configured for this session. ${this.roomChoices()}`, {
        code: "unknown_room", action: "fix_client", scope: "request",
      });
    }
    if (this.roomConfigs.length === 1) return this.roomConfigs[0];
    throw new ParleApiError(`This Parle session is configured for ${this.roomConfigs.length} rooms, so roomId is required. ${this.roomChoices()}`, {
      code: "room_required", action: "fix_client", scope: "request",
    });
  }

  private roomChoices(): string {
    const labels = this.roomConfigs.map((room) => {
      const id = room.roomId?.value || "";
      const handle = this.roomRuntimes.get(id)?.roomHandle || room.roomHandle?.value;
      return `${id}${handle ? ` (#${handle})` : ""}${room.profile?.value ? ` [${room.profile.value}]` : ""}`;
    });
    return `Configured rooms: ${labels.join(", ")}.`;
  }

  // Room state is replaced wholesale at commit: nothing survives a session
  // replacement except the cursors the candidate deliberately carried.
  private adoptRoomRuntimes(rooms?: Map<string, RoomRuntime>): void {
    if (!rooms) return;
    this.roomRuntimes.clear();
    for (const [roomId, room] of rooms) this.roomRuntimes.set(roomId, { ...room });
    this.publishRoomRuntimes();
  }

  roomRuntime(roomId: string): RoomRuntime {
    let existing = this.roomRuntimes.get(roomId);
    if (!existing) {
      const cfg = this.roomConfigs.find((room) => room.roomId?.value === roomId);
      existing = {
        roomId,
        ...(cfg?.profile?.value ? { profile: cfg.profile.value } : {}),
        ...(cfg?.roomHandle?.value ? { roomHandle: cfg.roomHandle.value } : {}),
        participantId: "",
        cursor: 0,
        state: "degraded",
      };
      this.roomRuntimes.set(roomId, existing);
    }
    return existing;
  }

  // rooms[] is the only room surface. Catalog order is a credential-selection
  // input, not an operator-visible primary binding.
  private publishRoomRuntimes(): void {
    this.runtime.rooms = this.roomConfigs
      .map((room) => this.roomRuntimes.get(room.roomId?.value || ""))
      .filter((room): room is RoomRuntime => Boolean(room))
      .map((room) => ({ ...room }));
  }

  async requestJson(pathOrUrl: string, options: RequestOptions = {}): Promise<any> {
    const method = options.method || (options.body === undefined ? "GET" : "POST");
    const retryableRequest = options.retry !== false && (method === "GET" || method === "HEAD" || Boolean(options.headers?.["Idempotency-Key"]));
    const startedMs = this.now().getTime();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.requestJsonOnce(pathOrUrl, options, method);
      } catch (error: any) {
        if (!(error instanceof ParleApiError) || error.code === "unsupported_parle_version" || !retryableRequest || !error.retryable || attempt >= REQUEST_RETRY_ATTEMPTS) throw error;
        const elapsed = Math.max(0, this.now().getTime() - startedMs);
        const delay = retryDelayMs(error, attempt);
        if (elapsed + delay > REQUEST_RETRY_WINDOW_MS) throw error;
        await this.sleepImpl(delay, options.signal);
      }
    }
  }

  private async requestJsonOnce(pathOrUrl: string, options: RequestOptions, method: string): Promise<any> {
    const url = requestUrl(this.cfg, pathOrUrl);
    assertSafeBase(url.origin, this.env);
    assertNoReservedProtocolHeaders(options.headers);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers,
      "Parle-Version": this.cfg.version.value || DEFAULT_VERSION,
      "Parle-Client-Name": this.clientName,
      ...(this.clientVersion ? { "Parle-Client-Version": this.clientVersion } : {}),
      "Parle-Client-Instance": this.clientInstanceId,
      ...(this.integrationName ? { "Parle-Integration-Name": this.integrationName } : {}),
      ...(this.integrationVersion ? { "Parle-Integration-Version": this.integrationVersion } : {}),
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.authMode === "human_session") throw new ParleApiError("human_session auth is not implemented in @parlehq/agent-client yet", { code: "not_implemented" });
    if (options.authMode !== "none") {
      // A room request authenticates with that room's own bearer; session-level
      // work uses the selected session binding.
      const binding = options.roomId ? this.roomTarget(options.roomId) : this.cfg;
      if (!binding.agentToken?.value) throw new ParleApiError("Parle setup needed: PARLE_ROOM_AGENT_TOKEN is missing", { code: "setup_needed" });
      headers.Authorization = `Bearer ${binding.agentToken.value}`;
    }
    const sessionCredential = options.sessionCredential || (options.session ? this.runtime.sessionHandle : "");
    if (sessionCredential) headers["Parle-Agent-Session"] = sessionCredential;
    const timeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const signal = options.signal && timeout ? AbortSignal.any([options.signal, timeout]) : options.signal || timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal });
    } catch (error: any) {
      const name = typeof error?.name === "string" ? error.name : "";
      if (name === "AbortError" || name === "TimeoutError" || signal?.aborted) {
        throw new ParleApiError("Parle API request timed out or was aborted", { code: "timeout", action: "retry_with_backoff", scope: "server", retryable: true });
      }
      throw error;
    }
    this.runtime.lastHttpStatus = response.status;
    const rawText = await response.text();
    const text = redactString(rawText);
    const json = parseJsonMaybe(options.rawResponse ? rawText : text);
    if (!response.ok) {
      const redactedJson = options.rawResponse ? parseJsonMaybe(text) : json;
      const envelope = parseErrorEnvelope(redactedJson);
      const { code, action, scope, retryAfterMs } = envelope;
      const retryable = retryableFromEnvelopeOrStatus(envelope.retryable, response.status);
      const msg = redactString(envelope.message || truncateText(text, 4096).text || response.statusText || `HTTP ${response.status}`);
      const versionHint = code === "unsupported_parle_version" ? formatVersionErrorHint(this.cfg, envelope.raw) : "";
      let message = `Parle API ${response.status}: ${msg}${versionHint}`;
      if (response.status === 401 && action === "reauthorize") {
        const hint = this.staleTokenHint();
        if (hint) message += ` ${hint}`;
      }
      throw new ParleApiError(message, { status: response.status, code, action, scope, retryAfterMs, retryable, details: redactedJson });
    }
    return json;
  }

  // Lifecycle mutations share one exclusion queue. Public methods acquire it;
  // internal helpers never reacquire it, which keeps rebootstrap and profile
  // preparation from deadlocking their callers.
  async bootstrap(signal?: AbortSignal, preserveCursor = false): Promise<RuntimeState> {
    if (this.bootstrapInFlight) return this.bootstrapInFlight;
    const run = this.withLifecycleExclusion(async () => {
      this.assertLifecycleActive();
      return this.doBootstrapLocked(signal, preserveCursor);
    });
    this.bootstrapInFlight = run;
    try {
      return await run;
    } finally {
      this.bootstrapInFlight = null;
    }
  }

  private async doBootstrapLocked(signal?: AbortSignal, preserveCursor = false, allowConfigReload = true, reason: "bootstrap" | "rebootstrap" = "bootstrap"): Promise<RuntimeState> {
    const epoch = this.lifecycleEpoch;
    const previous = { ...this.runtime };
    const oldWasLive = previous.bootstrapped && Boolean(previous.sessionHandle);
    this.runtime.bootstrapState = "starting";
    this.publishRuntimeState();
    try {
      this.assertConfigured();
      const prepared = await this.prepareCandidate(this.cfg.sessionAlias?.value, signal, preserveCursor, oldWasLive);
      try {
        this.assertLifecycleActive(epoch);
        this.assertSessionCommitAllowed(previous, prepared.state, reason);
      } catch (error) {
        await this.cancelCandidateWake(prepared.wake);
        if (!prepared.state.sessionAlias) await this.retireSession(prepared.state).catch(() => undefined);
        throw error;
      }
      const unusedPreviousWake = this.commitCandidate(prepared, epoch);
      await this.completeCandidateHandoff(previous, prepared.state, reason, signal, unusedPreviousWake, oldWasLive);
      this.assertExpectedAliasRecovered();
      this.clearAutomaticTerminalLatch();
      this.clearRolloverStormProtection();
      this.consecutiveBootstrapFailures = 0;
      return { ...this.runtime };
    } catch (error: any) {
      if (allowConfigReload && error instanceof ParleApiError && error.action === "reauthorize" && this.refreshConfigIfAgentTokenChanged()) {
        return this.doBootstrapLocked(signal, preserveCursor, false, reason);
      }
      this.consecutiveBootstrapFailures += 1;
      const api = error instanceof ParleApiError ? error : undefined;
      if (!oldWasLive) this.runtime.bootstrapState = "failed";
      else this.runtime.bootstrapState = "ready";
      this.runtime.lastBootstrapError = redactString(error instanceof Error ? error.message : String(error));
      this.recordTerminalCause(error);
      const terminalLatched = this.automaticTerminalBinding === this.bindingKey() && Boolean(this.runtime.terminalCause);
      const syntheticBackoffMs = Math.min(60_000, 5_000 * 2 ** (this.consecutiveBootstrapFailures - 1));
      const backoffMs = terminalLatched ? undefined : (api?.retryAfterMs ?? syntheticBackoffMs);
      this.runtime.nextRetryAt = backoffMs === undefined ? undefined : new Date(this.now().getTime() + backoffMs).toISOString();
      this.publishRuntimeState();
      throw error;
    }
  }

  // A replacement process that comes back without its configured durable route
  // looks healthy while peers address a session that no longer exists, so the
  // gap is reported rather than left silent (issue #49).
  private assertExpectedAliasRecovered(): void {
    const expected = this.cfg.sessionAlias?.value;
    if (!expected || this.runtime.sessionAlias === expected) {
      this.missingAliasWarning = undefined;
      return;
    }
    const held = this.runtime.sessionAlias ? ` The session holds ${this.runtime.sessionAlias} instead.` : "";
    this.missingAliasWarning = `Parle session did not reclaim its configured durable alias ${expected}; peers addressing that route will not reach this session.${held} Check whether another live session holds the alias, then reconnect.`;
    this.runtime.lastError = this.missingAliasWarning;
    this.publishRuntimeState();
  }

  private async prepareCandidate(alias: string | undefined, signal: AbortSignal | undefined, preserveCursor: boolean, requireWakeReadiness: boolean): Promise<PreparedCandidate> {
    const session = await this.requestJson("/v/agent/sessions", { method: "POST", body: {}, signal, rawResponse: true, retry: false });
    const candidate: RuntimeState = {
      bootstrapped: false,
      bootstrapState: "starting",
      sessionHandle: String(session.session_credential || ""),
      sessionAddress: this.deriveSessionAddress(
        { sessionHandle: typeof session.session_handle === "string" ? session.session_handle : undefined },
        typeof session.address === "string" ? session.address : null,
      ),
      sessionGeneration: 0,
      sessionRevision: this.runtime.sessionRevision,
      createdAt: String(session.created_at || ""),
      agentSessionId: String(session.agent_session_id || ""),
      expiresAt: String(session.expires_at || ""),
      rooms: [],
    };
    let candidateWake: CandidateWakeSlot | undefined;
    let priorAliasOwnerSessionId: string | undefined;
    let aliasClaimed = false;
    const rooms = new Map<string, RoomRuntime>();
    try {
      // One session enters every configured room with that room's own token.
      // An ordinary room failure degrades only that room; a session-scope
      // rejection aborts the whole set because the session itself is unusable.
      for (const roomCfg of this.roomConfigs) {
        const roomId = roomCfg.roomId!.value!;
        const room: RoomRuntime = {
          roomId,
          ...(roomCfg.profile?.value ? { profile: roomCfg.profile.value } : {}),
          ...(roomCfg.roomHandle?.value ? { roomHandle: roomCfg.roomHandle.value } : {}),
          participantId: "",
          cursor: preserveCursor ? (this.roomRuntimes.get(roomId)?.cursor ?? 0) : 0,
          cursorEstablished: preserveCursor ? (this.roomRuntimes.get(roomId)?.cursorEstablished ?? false) : false,
          ...(preserveCursor && this.roomRuntimes.get(roomId)?.streamGeneration
            ? { streamGeneration: this.roomRuntimes.get(roomId)!.streamGeneration }
            : {}),
          ...(preserveCursor && this.roomRuntimes.get(roomId)?.pendingStreamReset ? { pendingStreamReset: true } : {}),
          // The fence outlives the rebootstrap with the generation it fences,
          // because requests in flight across a rollover are exactly the ones
          // it exists to catch.
          ...(preserveCursor && this.roomRuntimes.get(roomId)?.retiredGenerations?.length
            ? { retiredGenerations: [...this.roomRuntimes.get(roomId)!.retiredGenerations!] }
            : {}),
          // A preserved cursor skips the bootstrap page, so nothing would
          // refresh this diagnostic: carry it, or an ordinary rollover would
          // silently clear a standing held-backlog warning and read as a room
          // with nothing in flight.
          ...(preserveCursor && this.roomRuntimes.get(roomId)?.heldBacklogCount !== undefined
            ? { heldBacklogCount: this.roomRuntimes.get(roomId)!.heldBacklogCount }
            : {}),
          state: "degraded",
        };
        rooms.set(roomId, room);
        try {
          const entry = await this.requestJson(`/v/rooms/${encodeURIComponent(roomId)}/participants`, {
            method: "POST", roomId, sessionCredential: candidate.sessionHandle, signal, retry: false,
          });
          room.participantId = String(entry.participant_id || "");
          if (typeof entry.room_handle === "string" && entry.room_handle) room.roomHandle = entry.room_handle;
          // Ask BEFORE adopting: a generation change at entry retires the
          // carried cursor along with the stream it belonged to.
          const entryReset = retiresCursor(room, entry);
          if (entryReset) room.pendingStreamReset = true;
          adoptStreamGeneration(room, entry);
          // Cursor initialization is deliberately pre-claim. Once claim is
          // submitted, no later preparation failure may discard an authoritative
          // candidate whose response was lost.
          //
          // A FRESH room cursor is the entry baseline (#927/ADR-0106 item 7).
          // The cursor-zero read that used to open every room is gone: it
          // fetched and discarded the whole retained transcript just to learn
          // where to start. An ESTABLISHED cursor is preserved as-is — the entry
          // baseline never replaces one, or a rebootstrap would skip everything
          // in between. A RETIRED cursor is the one exception: a stream reset
          // makes the carried number meaningless, so the room restarts from the
          // new stream's baseline exactly like a room that never had a cursor.
          if (entryReset || !room.cursorEstablished) {
            room.cursor = entryBaselineSeq(entry);
            room.cursorEstablished = true;
            // One page FROM THE BASELINE, never from zero: it proves this
            // session can read the room and carries the room-level held-backlog
            // marker the connection card reports. Its rows are not consumed —
            // the cursor stays at the baseline and the first real read returns
            // them.
            const projection = await this.requestJson(`/v/rooms/${encodeURIComponent(roomId)}/projection?since_seq=${encodeURIComponent(String(room.cursor))}&wait=0`, {
              roomId, sessionCredential: candidate.sessionHandle, signal, retry: false,
            });
            adoptDiscardedPageGeneration(room, projection);
            refreshHeldBacklogCount(room, projection);
          }
          room.state = "ready";
        } catch (error) {
          if (!this.multiRoom || isSessionScopeEntryFailure(error)) throw sessionScopeEntryHint(error, this.roomConfigs.length);
          room.lastError = redactString(error instanceof Error ? error.message : String(error));
          if (error instanceof ParleApiError) room.terminalCause = terminalCauseFor(error);
        }
      }
      if (this.multiRoom && [...rooms.values()].every((room) => room.state === "degraded")) {
        throw new ParleApiError(`Parle could not enter any configured room. ${[...rooms.values()].map((room) => `${room.roomId}: ${room.lastError || "unavailable"}`).join("; ")}`, {
          code: "room_entry_failed", action: "fix_client", scope: "request",
        });
      }
      if (alias || requireWakeReadiness) candidateWake = await this.establishCandidateWakeReadiness(candidate.sessionHandle, signal);
      if (alias) {
        const aliasFacts = await this.ownAliasFacts(alias, signal);
        const expectedGeneration = aliasFacts.generation;
        priorAliasOwnerSessionId = aliasFacts.currentAgentSessionId;
        // Last fail-closed edge. Everything after this line either transfers
        // alias authority or is local and non-throwing.
        this.preClaimGuard?.({ ...candidate, sessionAlias: alias, responsiveContinuity: "alias" });
        const claimed = await this.claimAliasWithRecovery(candidate, alias, expectedGeneration, signal);
        aliasClaimed = true;
        candidate.sessionAlias = typeof claimed.alias === "string" && claimed.alias ? claimed.alias : alias;
        candidate.sessionGeneration = Number.isInteger(claimed.generation) ? claimed.generation : expectedGeneration + 1;
        candidate.sessionAddress = this.deriveSessionAddress(
          { alias: candidate.sessionAlias, sessionHandle: typeof session.session_handle === "string" ? session.session_handle : undefined },
          typeof claimed.address === "string" ? claimed.address : candidate.sessionAddress,
        );
        candidate.createdAt = String(claimed.created_at || candidate.createdAt);
        candidate.expiresAt = String(claimed.expires_at || candidate.expiresAt);
        candidate.responsiveContinuity = "alias";
      } else if (requireWakeReadiness) {
        candidate.responsiveContinuity = "exact_session_not_transferred";
      }
      candidate.bootstrapped = true;
      candidate.bootstrapState = "ready";
      candidate.rooms = [...rooms.values()].map((room) => ({ ...room }));
      this.lastCandidateAliasFacts = { priorAliasOwnerSessionId, aliasClaimed };
      return { state: candidate, wake: candidateWake, rooms, priorAliasOwnerSessionId, aliasClaimed };
    } catch (error) {
      await this.cancelCandidateWake(candidateWake);
      if (!(error instanceof AliasClaimOutcomeUnknownError)) await this.retireSession(candidate).catch(() => undefined);
      throw error;
    }
  }

  private aliasTransport(): AliasTransport {
    return { request: (path, options) => this.requestJson(path, options as RequestOptions) };
  }

  private async ownAliasFacts(alias: string, signal?: AbortSignal): Promise<AliasFacts> {
    return ownAliasFactsShared(this.aliasTransport(), alias, signal);
  }

  private async claimAliasWithRecovery(candidate: RuntimeState, alias: string, expectedGeneration: number, signal?: AbortSignal): Promise<any> {
    return claimAliasShared(this.aliasTransport(), candidate, alias, expectedGeneration, signal);
  }

  private async establishCandidateWakeReadiness(sessionCredential: string, signal?: AbortSignal): Promise<CandidateWakeSlot> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.openWakeStreamForCredential(sessionCredential, controller.signal, false);
      return { sessionCredential, response, controller };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async cancelCandidateWake(slot?: CandidateWakeSlot): Promise<void> {
    if (!slot) return;
    slot.controller.abort();
    await slot.response.body?.cancel().catch(() => undefined);
  }

  // Same-agent supersession may be assumed only from authoritative alias
  // facts. Token strings are never compared: rotation replaces the credential
  // while the durable agent, and therefore its alias domain, stays the same.
  private aliasSupersededSource(previous: RuntimeState, candidate: ParleAgentClient): boolean {
    const facts = candidate.lastCandidateAliasFacts;
    return Boolean(facts?.aliasClaimed
      && facts.priorAliasOwnerSessionId
      && previous.agentSessionId
      && facts.priorAliasOwnerSessionId === previous.agentSessionId);
  }

  private assertResponsiveFenceAllowed(): void {
    if (!this.publicationBarrier) return;
    throw new ParleApiError(`Parle responsive delivery read is deferred while a ${this.publicationBarrier} completes`, {
      code: "lifecycle_publication_in_progress", action: "retry_with_backoff", scope: "agent_session", retryable: true,
    });
  }

  private async withPublicationBarrier<T>(reason: string, work: () => Promise<T>): Promise<T> {
    const previousBarrier = this.publicationBarrier;
    this.publicationBarrier = reason;
    try {
      return await work();
    } finally {
      this.publicationBarrier = previousBarrier;
    }
  }

  private assertSessionCommitAllowed(previous: RuntimeState, candidate: RuntimeState, reason: SessionRevisionEvent["reason"]): void {
    const plan: SessionCommitPlan = { reason, previous: Object.freeze({ ...previous }), candidate: Object.freeze({ ...candidate }) };
    if (this.activeResponsiveReads.size > 0 && !["bootstrap", "rebootstrap"].includes(reason)) {
      if (reason === "profile_switch") throw new Error("Parle profile switch is deferred while responsive delivery is being read");
      const aliasTransfers = Boolean(previous.sessionAlias
        && candidate.sessionAlias === previous.sessionAlias
        && candidate.responsiveContinuity === "alias"
        && [...this.activeResponsiveReads].every((fence) => fence.cursorScope === "alias"
          && fence.sessionAlias === previous.sessionAlias
          && previous.rooms.some((room) => room.roomId === fence.roomId)));
      if (!aliasTransfers) throw new Error("Parle exact-session lifecycle replacement is deferred while responsive delivery is being read");
    }
    for (const guard of this.sessionCommitGuards) guard(plan);
  }

  private commitCandidate(prepared: PreparedCandidate, epoch: number): CandidateWakeSlot | undefined {
    this.assertLifecycleActive(epoch);
    this.stopUnreadPolling();
    const unusedPreviousWake = this.prefetchedWake;
    this.prefetchedWake = prepared.wake;
    const revision = this.runtime.sessionRevision + 1;
    this.lifecycleEpoch += 1;
    this.runtime = { ...prepared.state, sessionRevision: revision, rolloverFailures: 0, rolloverLatched: false, lastBootstrapError: undefined };
    this.adoptRoomRuntimes(prepared.rooms);
    this.bootstrapGeneration += 1;
    this.publishRuntimeState();
    this.scheduleUnreadPoll();
    this.scheduleRollover();
    return unusedPreviousWake;
  }

  private async completeCandidateHandoff(previous: RuntimeState, candidate: RuntimeState, reason: SessionRevisionEvent["reason"], signal: AbortSignal | undefined, unusedPreviousWake: CandidateWakeSlot | undefined, drainImmediately: boolean): Promise<void> {
    const readyRooms = candidate.rooms.filter((room) => room.state === "ready");
    if (drainImmediately) {
      for (const room of readyRooms) {
        try {
          const delivery = await this.requestJson(`/v/rooms/${encodeURIComponent(room.roomId)}/responsive-delivery?wait=0`, { roomId: room.roomId, sessionCredential: candidate.sessionHandle, signal, retry: false });
          this.recordResponsiveCursorScope(delivery);
        } catch (error) {
          this.runtime.lastError = redactString(error instanceof Error ? error.message : String(error));
          this.publishRuntimeState();
        }
      }
    }
    if (candidate.sessionAlias) {
      try {
        for (const room of readyRooms) {
          await this.requestJson(`/v/rooms/${encodeURIComponent(room.roomId)}/participants`, {
            method: "POST", roomId: room.roomId, sessionCredential: candidate.sessionHandle, signal, retry: false,
          });
        }
      } catch (error) {
        this.runtime.lastError = redactString(error instanceof Error ? error.message : String(error));
        this.publishRuntimeState();
      }
    }
    // Revision publication retires an active old watcher only after drain and
    // idempotent room-entry reconciliation. The already-open candidate wake is
    // then consumed by the replacement watcher without an open-stream gap.
    this.publishSessionRevision(reason);
    await this.cancelCandidateWake(unusedPreviousWake);
    if (!previous.sessionAlias && previous.agentSessionId && previous.agentSessionId !== candidate.agentSessionId) {
      await this.retireSession(previous).catch(() => undefined);
    }
  }

  private publishSessionRevision(reason: SessionRevisionEvent["reason"]): void {
    const event: SessionRevisionEvent = {
      revision: this.runtime.sessionRevision,
      agentSessionId: this.runtime.agentSessionId,
      generation: this.runtime.sessionGeneration,
      ...(this.runtime.sessionAlias ? { alias: this.runtime.sessionAlias } : {}),
      reason,
    };
    for (const listener of this.sessionRevisionListeners) {
      try { listener(event); } catch {}
    }
  }

  onSessionRevision(listener: (event: SessionRevisionEvent) => void): () => void {
    this.sessionRevisionListeners.add(listener);
    return () => this.sessionRevisionListeners.delete(listener);
  }

  onBeforeSessionCommit(guard: (plan: SessionCommitPlan) => void): () => void {
    this.sessionCommitGuards.add(guard);
    return () => this.sessionCommitGuards.delete(guard);
  }

  async ensureBootstrapped(signal?: AbortSignal) {
    if (!this.runtime.bootstrapped || !this.runtime.sessionHandle) await this.bootstrap(signal);
  }

  // Room entry and cursor initialization are separate failures. A room can
  // hold a real participant binding while its cursor was never initialized,
  // which leaves it degraded but genuinely entered: the server will deliver to
  // it and wake on it. Recovery reconciles entry (idempotent) instead of
  // treating the room as never entered. An ESTABLISHED cursor survives
  // recovery untouched; a room that never got one, or one whose stream
  // generation changed at entry, takes the entry baseline. So recovery can
  // neither replay from zero nor skip forward over a still-valid cursor.
  async recoverRoom(roomId: string, signal?: AbortSignal): Promise<boolean> {
    const cfg = this.roomTarget(roomId);
    const room = this.roomRuntime(roomId);
    if (room.state === "ready") return true;
    if (!this.runtime.bootstrapped || !this.runtime.sessionHandle) return false;
    try {
      const entry = await this.requestJson(`/v/rooms/${encodeURIComponent(roomId)}/participants`, {
        method: "POST", roomId, session: true, signal, retry: false,
      });
      room.participantId = String(entry.participant_id || room.participantId || "");
      if (typeof entry.room_handle === "string" && entry.room_handle) room.roomHandle = entry.room_handle;
      else if (!room.roomHandle && cfg.roomHandle?.value) room.roomHandle = cfg.roomHandle.value;
      // Ask BEFORE adopting; see prepareCandidate. A reset retires the cursor.
      const entryReset = retiresCursor(room, entry);
      if (entryReset) room.pendingStreamReset = true;
      adoptStreamGeneration(room, entry);
      if (entryReset || !room.cursorEstablished) {
        room.cursor = entryBaselineSeq(entry);
        room.cursorEstablished = true;
      }
      const projection = await this.requestJson(`/v/rooms/${encodeURIComponent(roomId)}/projection?since_seq=${encodeURIComponent(String(room.cursor))}&wait=0`, {
        roomId, session: true, signal, retry: false,
      });
      adoptDiscardedPageGeneration(room, projection);
      refreshHeldBacklogCount(room, projection);
      room.state = "ready";
      room.lastError = undefined;
      this.publishRoomRuntimes();
      this.publishRuntimeState();
      return true;
    } catch (error) {
      room.lastError = redactString(error instanceof Error ? error.message : String(error));
      this.publishRoomRuntimes();
      return false;
    }
  }

  /**
   * Internal bridge for a colocated watcher process. The returned credential is
   * secret and may only be passed through a private child environment into an
   * authenticated room request. Never return, log, persist, or place it in argv.
   */
  watcherSessionAuth(): { agentSessionId: string; sessionCredential: string } {
    if (!this.runtime.bootstrapped || !this.runtime.agentSessionId || !this.runtime.sessionHandle) {
      throw new Error("Parle watcher session is not bootstrapped.");
    }
    return {
      agentSessionId: this.runtime.agentSessionId,
      sessionCredential: this.runtime.sessionHandle,
    };
  }

  async deleteProfile(params: DeleteProfileParams): Promise<{ profile: string; removed: boolean }> {
    if (this.profileSwitchInFlight) {
      throw new ProfileDeletionError("profile_delete_switch_in_flight", "Parle profile deletion is unavailable while a profile switch is in flight.");
    }
    return this.withLifecycleExclusion(async () => {
      if (this.profileSwitchInFlight) {
        throw new ProfileDeletionError("profile_delete_switch_in_flight", "Parle profile deletion is unavailable while a profile switch is in flight.");
      }
      const protectedProfiles = this.roomConfigs.flatMap((cfg) => cfg.profile?.value ? [cfg.profile.value] : []);
      if (this.activeProfile) protectedProfiles.push(this.activeProfile);
      return deleteProfileFromCatalog(params, { catalogPath: this.registryCatalogPath, protectedProfiles });
    });
  }

  async switchProfile(profile: string, signal?: AbortSignal): Promise<ClientProfileSwitchResult> {
    // Switching is the single-room primitive. In multi-room mode the room set
    // is the startup contract, and moving one binding underneath a live
    // session would leave the others pointing at a retired session.
    if (this.multiRoom) {
      throw new Error(`Live profile switching is unavailable while PARLE_PROFILES configures ${this.roomConfigs.length} rooms. Restart the host with the profile set you want.`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
      throw new Error("Parle profile must be 1 to 64 characters and contain only letters, numbers, dot, underscore, or hyphen, starting with a letter or number.");
    }
    if (this.profileSwitchInFlight) throw new Error("A Parle profile switch is already in progress.");
    this.profileSwitchInFlight = true;
    try {
      return await this.withBindingChange(() => this.withLifecycleExclusion(async () => {
        this.assertLifecycleActive();
        const epoch = this.lifecycleEpoch;
        const previousCfg = this.cfg;
        const previousRuntime = { ...this.runtime };
        const previousProfile = this.activeProfile;
        let targetCfg: ParleConfig | undefined;
        let targetAlias: string | undefined;
        let scratch: ParleAgentClient | undefined;
        let committed = false;

        try {
          const result = await this.withPublicationBarrier("profile switch", () => performProfileSwitch({
            resolve: () => {
              targetCfg = resolveConfig(this.cwd, this.selectedEnvironment(profile));
              if (!targetCfg.roomId?.value || !targetCfg.agentToken?.value) {
                throw new Error(`Parle profile ${profile} does not provide a complete room binding.`);
              }
              // A configured alias is prepared without claiming and activated
              // only at the pre-claim edge, so a failed preparation can no
              // longer supersede the live named route.
              targetAlias = targetCfg.sessionAlias?.value;
              const sameBinding = previousCfg.roomId?.value === targetCfg.roomId.value
                && previousCfg.agentToken?.value === targetCfg.agentToken.value
                && previousCfg.apiBase.value === targetCfg.apiBase.value
                && previousCfg.wakeBase.value === targetCfg.wakeBase.value;
              return { profile, roomId: targetCfg.roomId.value, changed: previousProfile !== profile || !sameBinding || !this.runtime.bootstrapped };
            },
            prepare: async () => {
              // Scratch lifecycle is independent. The live client's exclusion
              // remains held through preparation and the synchronous guard.
              scratch = new ParleAgentClient({
                cwd: this.cwd,
                env: this.selectedEnvironment(profile),
                fetch: this.fetchImpl,
                now: this.now,
                sleep: this.sleepImpl,
                randomUUID: this.randomUUID,
                setTimer: this.setTimer,
                clearTimer: this.clearTimer,
                clientName: this.clientName,
                clientVersion: this.clientVersion,
                clientInstanceId: this.clientInstanceId,
                integrationName: this.integrationName,
                integrationVersion: this.integrationVersion,
              });
              // The live client owns the guard; the scratch instance only
              // supplies the target credential and candidate I/O.
              scratch.preClaimGuard = (candidate) => {
                this.assertLifecycleActive(epoch);
                this.assertSessionCommitAllowed(previousRuntime, candidate, "profile_switch");
              };
              try {
                await scratch.bootstrap(signal, false);
              } catch (error) {
                throw aliasClaimConflictHint(error, targetAlias);
              } finally {
                scratch.preClaimGuard = undefined;
              }
              return scratch;
            },
            commit: (prepared) => {
              // Once the alias claim has committed, publication must not
              // throw: local state is the only thing left to move, and the
              // address already routes to this candidate.
              if (!prepared.lastCandidateAliasFacts?.aliasClaimed) {
                this.assertLifecycleActive(epoch);
                this.assertSessionCommitAllowed(previousRuntime, prepared.runtime, "profile_switch");
              }
              this.stopUnreadPolling();
              this.stopRolloverTimer();
              prepared.stopUnreadPolling();
              prepared.stopRolloverTimer();
              const unusedPreviousWake = this.prefetchedWake;
              this.prefetchedWake = undefined;
              void this.cancelCandidateWake(unusedPreviousWake);
              this.cfg = prepared.cfg;
              // The room binding moves with the profile, so the room set and
              // its runtimes are replaced together with the config.
              this.roomConfigs = prepared.roomConfigs;
              this.adoptRoomRuntimes(prepared.roomRuntimes);
              this.activeProfile = profile;
              this.lifecycleEpoch += 1;
              this.runtime = {
                ...prepared.runtime,
                sessionRevision: previousRuntime.sessionRevision + 1,
                // Responsive continuity survives only when this switch
                // superseded our own source session on the same alias in the
                // same room. Across durable agents the address itself changes,
                // so nothing is transferred.
                ...(prepared.lastCandidateAliasFacts?.aliasClaimed
                  ? { responsiveContinuity: (this.aliasSupersededSource(previousRuntime, prepared) && sameRoomSet(previousRuntime.rooms, prepared.runtime.rooms)) ? "alias" as const : "exact_session_not_transferred" as const }
                  : {}),
              };
              this.bootstrapGeneration += 1;
              this.rebootstrapEpisode = null;
              this.consecutiveBootstrapFailures = 0;
              this.clearAutomaticTerminalLatch();
              this.clearRolloverStormProtection();
              this.publishRuntimeState();
              this.publishSessionRevision("profile_switch");
              this.scheduleUnreadPoll();
              this.scheduleRollover();
              committed = true;
            },
            retireOldSession: async () => {
              if (!previousRuntime.agentSessionId || !previousRuntime.sessionHandle) return;
              // Alias authority is scoped by durable agent id, so a target
              // claim only supersedes the source when the authoritative
              // pre-claim lookup named the source session itself. In every
              // other case (different alias, another owner, no owner, another
              // durable agent) the source route stays live until it is ended
              // explicitly with the source profile credential.
              if (scratch && this.aliasSupersededSource(previousRuntime, scratch)) return;
              const prior = new ParleAgentClient({
                cwd: this.cwd,
                env: this.env,
                fetch: this.fetchImpl,
                now: this.now,
                sleep: this.sleepImpl,
                randomUUID: this.randomUUID,
                clientName: this.clientName,
                clientVersion: this.clientVersion,
                clientInstanceId: this.clientInstanceId,
                integrationName: this.integrationName,
                integrationVersion: this.integrationVersion,
              });
              prior.cfg = previousCfg;
              prior.runtime = previousRuntime;
              await prior.endSession(signal);
            },
          }));

          return {
            ...result,
            previousProfile,
            sessionAddress: this.runtime.sessionAddress,
            agentSessionId: this.runtime.agentSessionId,
            expiresAt: this.runtime.expiresAt,
            rooms: this.runtime.rooms.map((room) => ({ ...room })),
            watcherRestartRequired: result.switched,
          };
        } finally {
          if (scratch && !committed) await scratch.endSession().catch(() => undefined);
        }
      }));
    } finally {
      this.profileSwitchInFlight = false;
    }
  }

  private sessionExpired(): boolean {
    const expiry = this.runtime.expiresAt ? new Date(this.runtime.expiresAt) : null;
    return expiry !== null && !Number.isNaN(expiry.getTime()) && expiry <= this.now();
  }

  private sessionStillLive(): boolean {
    const expiry = Date.parse(this.runtime.expiresAt || "");
    return Number.isFinite(expiry) && expiry > this.now().getTime();
  }

  private stopRolloverTimer(): void {
    if (this.rolloverTimer) this.clearTimer(this.rolloverTimer);
    this.rolloverTimer = null;
  }

  private scheduleRollover(delayOverrideMs?: number, cooldown = false): void {
    this.stopRolloverTimer();
    if (this.ended || !this.runtime.bootstrapped || (this.runtime.rolloverLatched && !cooldown)) return;
    if (cooldown && !this.sessionStillLive()) return;
    const rolloverAt = sessionRolloverAtMs(this.runtime);
    if (rolloverAt === undefined && delayOverrideMs === undefined) return;
    const delay = delayOverrideMs ?? Math.max(0, rolloverAt! - this.now().getTime());
    this.rolloverTimer = this.setTimer(() => {
      this.rolloverTimer = null;
      if (this.ended) return;
      if (cooldown) {
        if (!this.sessionStillLive()) return;
        this.runtime.rolloverLatched = false;
      }
      if (delayOverrideMs === undefined && rolloverAt! > this.now().getTime()) {
        this.scheduleRollover();
        return;
      }
      void this.performProactiveRollover().catch(() => undefined);
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
    this.rolloverTimer.unref?.();
  }

  private recordRolloverFailure(error: unknown, forceCooldown = false): void {
    const failures = (this.runtime.rolloverFailures || 0) + 1;
    const cooldown = forceCooldown || failures >= ROLLOVER_MAX_FAILURES;
    this.runtime.rolloverFailures = failures;
    this.runtime.rolloverLatched = cooldown;
    this.runtime.lastError = redactString(error instanceof Error ? error.message : String(error));
    this.publishRuntimeState();
    if (this.sessionStillLive()) {
      this.scheduleRollover(cooldown ? ROLLOVER_COOLDOWN_MS : ROLLOVER_RETRY_MS * failures, cooldown);
    }
  }

  async performProactiveRollover(signal?: AbortSignal): Promise<RuntimeState> {
    if (this.rolloverInFlight) return this.rolloverInFlight;
    const run = this.withLifecycleExclusion(async () => {
      this.assertLifecycleActive();
      return this.doProactiveRolloverLocked(signal);
    });
    this.rolloverInFlight = run;
    try {
      return await run;
    } finally {
      this.rolloverInFlight = null;
    }
  }

  private async doProactiveRolloverLocked(signal?: AbortSignal): Promise<RuntimeState> {
    this.stopRolloverTimer();
    if (!this.runtime.bootstrapped || !this.runtime.sessionHandle) throw new ParleApiError("Parle rollover requires a live current session", { code: "session_unavailable", action: "rebootstrap", scope: "agent_session" });
    if (this.runtime.rolloverLatched) throw new ParleApiError("Parle proactive rollover is cooling down after a bounded failure storm", { code: "rollover_cooling_down", action: "backoff", scope: "agent_session", retryable: true, retryAfterMs: ROLLOVER_COOLDOWN_MS });
    const epoch = this.lifecycleEpoch;
    const old = { ...this.runtime };
    let prepared: PreparedCandidate;
    // Bridge-owned guards run synchronously after all candidate I/O. When an
    // alias is in play they must run BEFORE the claim: a guard that throws
    // after a successful claim would leave the alias superseded onto a
    // candidate this client then refuses to publish, and the aliased candidate
    // is deliberately not retired, so the address would route to an orphan.
    let guardRejected = false;
    this.preClaimGuard = (candidate) => {
      try {
        this.assertLifecycleActive(epoch);
        this.assertSessionCommitAllowed(old, candidate, "rollover");
      } catch (error) {
        guardRejected = true;
        throw error;
      }
    };
    try {
      prepared = await this.withPublicationBarrier("rollover", () =>
        this.prepareCandidate(old.sessionAlias || this.cfg.sessionAlias?.value, signal, true, true));
    } catch (error) {
      // A guard rejection is a local deferral, not a transport failure, so it
      // keeps the original cooldown behavior instead of a fast retry.
      this.recordRolloverFailure(error, guardRejected);
      throw error;
    } finally {
      this.preClaimGuard = undefined;
    }
    if (!prepared.aliasClaimed) {
      // Nothing was claimed, so the anonymous candidate is still discardable
      // and the guard keeps its original commit-edge position.
      try {
        this.assertLifecycleActive(epoch);
        this.assertSessionCommitAllowed(old, prepared.state, "rollover");
      } catch (error) {
        await this.cancelCandidateWake(prepared.wake);
        await this.retireSession(prepared.state).catch(() => undefined);
        this.recordRolloverFailure(error, true);
        throw error;
      }
    }

    // Claim success is the authority boundary. Publication is followed by an
    // immediate drain, documented room-entry reconciliation, and only then old
    // wake or credential retirement.
    const unusedPreviousWake = this.commitCandidate(prepared, epoch);
    await this.completeCandidateHandoff(old, prepared.state, "rollover", signal, unusedPreviousWake, true);
    return { ...this.runtime };
  }

  // Move the live session onto a durable alias without touching persistent
  // configuration. Uses the same candidate machinery as rollover, so the
  // pre-claim guard, publication barrier, and supersession semantics hold; a
  // later proactive rollover re-claims the switched alias because rollover
  // prefers the runtime alias over the configured one.
  async switchSessionAlias(alias: string, signal?: AbortSignal): Promise<{
    status: "alias_active";
    alias?: string;
    generation?: number;
    sessionAddress: string | null;
    expiresAt: string;
    priorAlias?: string;
    priorSessionAddress?: string | null;
    warning?: string;
    recovery?: string;
  }> {
    if (!isValidSessionAlias(alias)) {
      throw new ParleApiError("Parle session alias must be an unreserved 2-32 character durable alias using lowercase letters, digits, and single hyphens, and must not use the anonymous 16-character session shape.", { code: "validation_failed", action: "fix_client", scope: "request" });
    }
    return this.withLifecycleExclusion(async () => {
      this.assertLifecycleActive();
      const epoch = this.lifecycleEpoch;
      const old = { ...this.runtime };
      const priorAlias = old.sessionAlias;
      const priorAddress = old.sessionAddress;
      this.assertConfigured();
      // An anonymous live session claims the alias IN PLACE (parle-adapters#115,
      // parlehq/parle#797): core's claim precondition (alias-free, generation 0)
      // admits exactly this session, and replacing it would end the exact-session
      // reply-route target Parle froze at delivery and rotate every participant
      // row. No new session, no room re-entry, no wake replacement, no
      // retirement: outstanding exact-session routes stay redeemable by
      // construction. An aliased predecessor keeps the candidate machinery
      // below -- core forbids re-claim on an aliased session, and alias-scoped
      // continuity is owned by generation fencing plus reissue.
      if (!priorAlias && old.bootstrapped && old.agentSessionId && old.sessionHandle) {
        return this.claimAliasInPlace(alias, old, epoch, signal);
      }
      let prepared: PreparedCandidate;
      this.preClaimGuard = (candidate) => {
        this.assertLifecycleActive(epoch);
        this.assertSessionCommitAllowed(old, candidate, "alias_switch");
      };
      try {
        prepared = await this.withPublicationBarrier("alias switch", () =>
          this.prepareCandidate(alias, signal, true, true));
      } finally {
        this.preClaimGuard = undefined;
      }
      const unusedPreviousWake = this.commitCandidate(prepared, epoch);
      await this.completeCandidateHandoff(old, prepared.state, "alias_switch", signal, unusedPreviousWake, true);
      const replaced = Boolean(priorAlias && priorAlias !== this.runtime.sessionAlias);
      return {
        status: "alias_active" as const,
        alias: this.runtime.sessionAlias,
        generation: this.runtime.sessionGeneration,
        sessionAddress: this.runtime.sessionAddress ?? null,
        expiresAt: this.runtime.expiresAt,
        ...(priorAlias ? { priorAlias } : {}),
        ...(priorAddress ? { priorSessionAddress: priorAddress } : {}),
        ...(replaced
          ? {
              warning: `This session left the alias ${priorAlias}. Peers still addressing @...${priorAlias} reach a retired route; tell them the new address, or switch back to ${priorAlias} to reclaim it.`,
              recovery: `switchSessionAlias(${JSON.stringify(priorAlias)})`,
            }
          : {}),
      };
    });
  }

  // In-place claim for an anonymous live session. The publication barrier and
  // the pre-claim commit guard keep the candidate path's fail-closed edge: a
  // guard rejection (including the active responsive-read deferral, whose
  // cursor authority would flip from exact-session to alias mid-read) throws
  // BEFORE any claim request leaves the process, leaving the session exactly
  // as it was. A thrown claim (409 conflict, outcome-unknown) likewise leaves
  // the live session untouched -- there is no candidate to retire and the
  // session itself is never ended. Lost-response recovery stays authoritative
  // via claimAliasWithRecovery's alias-fence confirmation.
  private async claimAliasInPlace(alias: string, old: RuntimeState, epoch: number, signal?: AbortSignal): Promise<{
    status: "alias_active";
    alias?: string;
    generation?: number;
    sessionAddress: string | null;
    expiresAt: string;
  }> {
    const { claimed, expectedGeneration } = await this.withPublicationBarrier("alias switch", async () => {
      const aliasFacts = await this.ownAliasFacts(alias, signal);
      // Last fail-closed edge, identical in position to the candidate path's
      // preClaimGuard: everything after this line transfers alias authority.
      this.assertLifecycleActive(epoch);
      this.assertSessionCommitAllowed(old, { ...old, sessionAlias: alias, responsiveContinuity: "alias" }, "alias_switch");
      const result = await this.claimAliasWithRecovery(old, alias, aliasFacts.generation, signal);
      return { claimed: result, expectedGeneration: aliasFacts.generation };
    });
    this.assertLifecycleActive(epoch);
    const claimedAlias = typeof claimed.alias === "string" && claimed.alias ? claimed.alias : alias;
    this.runtime = {
      ...this.runtime,
      sessionAlias: claimedAlias,
      sessionGeneration: Number.isInteger(claimed.generation) ? claimed.generation : expectedGeneration + 1,
      sessionAddress: this.deriveSessionAddress(
        { alias: claimedAlias },
        typeof claimed.address === "string" ? claimed.address : old.sessionAddress ?? null,
      ),
      createdAt: String(claimed.created_at || this.runtime.createdAt),
      expiresAt: String(claimed.expires_at || this.runtime.expiresAt),
      responsiveContinuity: "alias",
      sessionRevision: this.runtime.sessionRevision + 1,
    };
    // Same incarnation: the lifecycle epoch, room runtimes, cursors, and the
    // open wake stream all carry forward. Publication and revision fire exactly
    // once; rollover reschedules against the possibly-extended expiry and will
    // re-claim the runtime alias on its next incarnation replacement.
    this.publishRuntimeState();
    this.scheduleRollover();
    this.publishSessionRevision("alias_switch");
    return {
      status: "alias_active" as const,
      alias: this.runtime.sessionAlias,
      generation: this.runtime.sessionGeneration,
      sessionAddress: this.runtime.sessionAddress ?? null,
      expiresAt: this.runtime.expiresAt,
    };
  }

  private async retireSession(state: RuntimeState, signal?: AbortSignal): Promise<void> {
    if (!state.agentSessionId || !state.sessionHandle) return;
    await this.requestJson(`/v/agent/sessions/${encodeURIComponent(state.agentSessionId)}/end`, {
      method: "POST", sessionCredential: state.sessionHandle, signal, timeoutMs: 2000, retry: false,
    });
  }

  private resetRebootstrapEpisodeIfHealthy(): void {
    const episode = this.rebootstrapEpisode;
    // A terminal session gets one repair attempt, then needs ten quiet minutes
    // before a future failure can start a new episode.
    if (!episode?.healthySinceMs) return;
    if (this.now().getTime() - episode.healthySinceMs >= 10 * 60_000) this.rebootstrapEpisode = null;
  }

  // Non-throwing bootstrap for eager startup and status auto-connect. Returns
  // whether a bootstrap was attempted. Skips when already live, unconfigured,
  // or inside the failure backoff window (explicit tool calls like connect/read/
  // send are user-paced and always retry; this path is the one that could hammer).
  async ensureReadySafe(signal?: AbortSignal): Promise<boolean> {
    // Never rebind a healthy live session from ambient disk changes. Binding
    // rotation is consulted only while automatic recovery is actually needed.
    if (this.runtime.bootstrapped && this.runtime.sessionHandle && !this.sessionExpired()) return false;
    // A changed disk credential is an affirmative recovery signal for a failed
    // or expired binding and may reopen automatic work before the latch check.
    this.refreshConfigIfAgentTokenChanged();
    if (!this.cfg.roomId?.value || !this.cfg.agentToken?.value) return false;
    if (this.automaticTerminalBinding === this.bindingKey()) return false;
    if (this.runtime.bootstrapState === "failed" && this.runtime.nextRetryAt && new Date(this.runtime.nextRetryAt) > this.now()) return false;
    try {
      await this.bootstrap(signal);
    } catch {
      // Failure details are recorded on runtime by doBootstrap.
    }
    return true;
  }

  private publishRuntimeState(): void {
    if (!this.publishRuntime) return;
    try {
      const projectedRuntime = projectRuntimeStatus(this.runtime);
      writeRuntimeFile(this.cwd, {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        pid: process.pid,
        processStartedAt: processStartedAtIso(this.now()),
        clientInstanceId: this.clientInstanceId,
        state: this.runtime.bootstrapState === "ready" ? "ready" : this.runtime.bootstrapState === "failed" ? "failed" : "starting",
        sessionAddress: this.runtime.sessionAddress,
        // agent_session_id is room-visible operational metadata, not a credential
        // (parlehq/parle#435); session_credential never leaves process memory.
        agentSessionId: this.runtime.agentSessionId,
        rooms: this.roomConfigs.map((cfg) => {
          const roomId = cfg.roomId?.value || "";
          const room = this.roomRuntimes.get(roomId);
          return {
            roomId,
            ...(room?.roomHandle || cfg.roomHandle?.value ? { roomHandle: room?.roomHandle || cfg.roomHandle?.value } : {}),
            ...(cfg.profile?.value ? { profile: cfg.profile.value } : {}),
            ...(room?.participantId ? { participantId: room.participantId } : {}),
            state: room?.state === "ready" ? "ready" as const : "degraded" as const,
            ...(typeof room?.unreadCount === "number" ? { unreadCount: room.unreadCount, unreadAsOf: room.unreadAsOf } : {}),
          };
        }),
        updatedAt: this.now().toISOString(),
        expiresAt: this.runtime.expiresAt,
        ...(projectedRuntime.lastError ? { lastError: projectedRuntime.lastError } : {}),
        adapter: { name: this.publishRuntime.adapterName, version: this.publishRuntime.adapterVersion },
      });
    } catch {
      // Publishing local display state must never break the host.
    }
  }

  // An unparseable interval disables polling fail-safe; surface that in status
  // warnings so the misconfiguration is not silent forever.
  unreadIntervalHint(): string | undefined {
    const raw = this.cfg.unreadPollIntervalSeconds;
    if (!raw?.value || raw.source === "default") return undefined;
    if (raw.value.trim() === "0" || this.unreadPollIntervalMs() > 0) return undefined;
    return `PARLE_UNREAD_POLL_INTERVAL_SECONDS (${raw.source}) is not a positive number; unread polling is disabled. Set a value in seconds, or 0 to disable intentionally.`;
  }

  unreadPollIntervalMs(): number {
    const parsed = Number(this.cfg.unreadPollIntervalSeconds?.value ?? "60");
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(3600, Math.max(15, Math.trunc(parsed))) * 1000;
  }

  // Bounded background unread observation: lazy (started on bootstrap success),
  // jittered so concurrent sessions do not synchronize, one request in flight,
  // unref'd so the timer never holds the host process open, and the chain dies
  // when the session leaves ready state (a successful rebootstrap revives it).
  // Only runs for runtime-publishing clients; nothing else consumes the count.
  private scheduleUnreadPoll(): void {
    if (!this.publishRuntime || this.unreadPollTimer) return;
    const base = this.unreadPollIntervalMs();
    if (base <= 0) return;
    const delay = base * (0.8 + Math.random() * 0.4);
    this.unreadPollTimer = setTimeout(() => {
      this.unreadPollTimer = null;
      void this.observeUnread().finally(() => {
        if (this.runtime.bootstrapState === "ready") this.scheduleUnreadPoll();
      });
    }, delay);
    this.unreadPollTimer.unref?.();
  }

  private stopUnreadPolling(): void {
    if (this.unreadPollTimer) clearTimeout(this.unreadPollTimer);
    this.unreadPollTimer = null;
  }

  // Count-only observation of the self-excluding inbound surface past the
  // process cursor. Never advances the cursor, never rebootstraps, and never
  // touches session state on failure (unread simply goes stale and ages out
  // of display). A drain that advances the cursor while this request is in
  // flight invalidates the result: publishing it would resurrect a count the
  // user just read.
  async observeUnread(signal?: AbortSignal): Promise<void> {
    if (this.runtime.bootstrapState !== "ready" || this.unreadInFlight) return;
    this.unreadInFlight = true;
    try {
      for (const room of this.runtime.rooms.filter((entry) => entry.state === "ready")) {
        const roomId = room.roomId;
        const sinceSeq = this.roomRuntime(roomId).cursor || 0;
        try {
          const response = await this.requestJson(`/v/rooms/${encodeURIComponent(roomId)}/inbound?since_seq=${encodeURIComponent(String(sinceSeq))}&wait=0`, { session: true, roomId, signal, timeoutMs: 10_000, retry: false });
          const currentRoom = this.roomRuntime(roomId);
          if ((currentRoom.cursor || 0) !== sinceSeq) continue;
          refreshHeldBacklogCount(currentRoom, response);
          const rows = Array.isArray(response.messages) ? response.messages : [];
          this.setUnread(rows.filter((row: any) => typeof row?.seq === "number" && row.seq > sinceSeq).length, roomId);
        } catch {
          // Observation failures are isolated from session state by design,
          // and one room's failure never stops the others.
        }
      }
    } finally {
      this.unreadInFlight = false;
    }
  }

  // Publish policy: republish on change, and on every nonzero observation so
  // the display freshness gate keeps a standing count visible. A steady zero
  // writes nothing (zero displays nothing, so it needs no freshness heartbeat).
  private setUnread(count: number, roomId: string): void {
    const room = this.roomRuntime(roomId);
    const changed = room.unreadCount !== count;
    room.unreadCount = count;
    room.unreadAsOf = this.now().toISOString();
    this.publishRoomRuntimes();
    if (changed || count > 0) this.publishRuntimeState();
  }

  discardRuntimeFile(): void {
    if (!this.publishRuntime) return;
    try {
      removeRuntimeFile(this.cwd, process.pid);
    } catch {
      // Best-effort; expiry self-invalidates the file for readers.
    }
  }

  async endSession(signal?: AbortSignal): Promise<void> {
    // Stop future scheduling immediately, then join the one lifecycle queue.
    // Any preparation already inside the exclusion finishes or fails before
    // this fence retires the authoritative current incarnation.
    this.stopUnreadPolling();
    this.stopRolloverTimer();
    return this.withLifecycleExclusion(async () => {
      this.stopUnreadPolling();
      this.stopRolloverTimer();
      this.ended = true;
      this.lifecycleEpoch += 1;
      const { agentSessionId, sessionHandle } = this.runtime;
      const unusedWake = this.prefetchedWake;
      this.prefetchedWake = undefined;
      await this.cancelCandidateWake(unusedWake);
      try {
        if (agentSessionId && sessionHandle) {
          await this.requestJson(`/v/agent/sessions/${encodeURIComponent(agentSessionId)}/end`, { method: "POST", sessionCredential: sessionHandle, signal, timeoutMs: 2000, retry: false });
        }
      } finally {
        this.runtime = {
          bootstrapped: false,
          bootstrapState: "unstarted",
          sessionHandle: "",
          sessionAddress: null,
          sessionGeneration: 0,
          sessionRevision: this.runtime.sessionRevision,
          createdAt: "",
          agentSessionId: "",
          expiresAt: "",
          rooms: [],
        };
        this.discardRuntimeFile();
      }
    });
  }

  // Deliberately factual until the core session lifecycle and delivery baseline
  // contract exists: reports client cursor position and server-reported held
  // backlog only; makes no responsive-delivery baseline or ack-init claims.
  connectionSummary(reusedExistingSession = false): ConnectionSummary {
    return {
      connected: this.runtime.bootstrapped,
      reusedExistingSession,
      sessionAddress: this.runtime.sessionAddress,
      agentSessionId: this.runtime.agentSessionId,
      expiresAt: this.runtime.expiresAt,
      rooms: this.runtime.rooms.map((room) => ({ ...room })),
      note: "each room carries its own cursor: this process's read position in that room, initialized at the held-safe baseline the server returned when this session entered the room.",
      next: CONNECT_NEXT_GUIDANCE,
    };
  }

  async connect(signal?: AbortSignal): Promise<ConnectionSummary> {
    const reused = this.runtime.bootstrapped && Boolean(this.runtime.sessionHandle) && !this.sessionExpired();
    if (!reused) await this.bootstrap(signal);
    else this.clearRolloverStormProtection(true);
    return this.connectionSummary(reused);
  }

  private sessionEstablishedBlock(): SessionEstablishedBlock {
    return {
      established: "this_call",
      sessionAddress: this.runtime.sessionAddress,
      agentSessionId: this.runtime.agentSessionId,
      expiresAt: this.runtime.expiresAt,
      next: SESSION_ESTABLISHED_NEXT_GUIDANCE,
    };
  }

  async withRebootstrap<T>(fn: () => Promise<T>, signal?: AbortSignal, terminalOwner: "automatic" | "request" = "automatic"): Promise<T> {
    this.resetRebootstrapEpisodeIfHealthy();
    await this.ensureBootstrapped(signal);
    try {
      const result = await fn();
      this.clearRolloverStormProtection(true);
      return result;
    } catch (error: any) {
      if (!(error instanceof ParleApiError) || error.action !== "rebootstrap") {
        if (terminalOwner === "automatic") this.recordTerminalCause(error);
        throw error;
      }
      const failedSessionHandle = this.runtime.sessionHandle || "<missing-session>";
      await this.withLifecycleExclusion(async () => {
        this.assertLifecycleActive();
        // Another serialized lifecycle operation may already have replaced the
        // failed credential while this caller waited for exclusion.
        if (this.runtime.bootstrapped && this.runtime.sessionHandle && this.runtime.sessionHandle !== failedSessionHandle) return;
        const existing = this.rebootstrapEpisode;
        if (existing?.failedSessionHandle === failedSessionHandle && (existing.attempted || existing.terminal)) throw error;
        this.rebootstrapEpisode = { failedSessionHandle, attempted: true };
        this.runtime.bootstrapState = "starting";
        this.publishRuntimeState();
        try {
          await this.doBootstrapLocked(signal, true, true, "rebootstrap");
          this.rebootstrapEpisode = { failedSessionHandle, attempted: true, healthySinceMs: this.now().getTime() };
        } catch (bootstrapError: any) {
          if (bootstrapError instanceof ParleApiError && ["fix_client", "reauthorize", "stop"].includes(bootstrapError.action || "")) {
            this.rebootstrapEpisode = { failedSessionHandle, attempted: true, terminal: true };
            this.runtime.lastBootstrapError = terminalStatusFor(bootstrapError);
            this.publishRuntimeState();
          }
          throw bootstrapError;
        }
      });
      const result = await fn();
      this.clearRolloverStormProtection(true);
      return result;
    }
  }

  async openWakeStream(signal?: AbortSignal): Promise<Response> {
    // Wake streams are watcher machinery, never an explicit user-paced tool
    // call. Keep them behind the same binding-scoped automatic latch.
    if (this.automaticTerminalBinding === this.bindingKey()) {
      const cause = this.runtime.terminalCause;
      throw new ParleApiError(cause?.message || "Parle automatic wake is stopped until credentials or binding change", {
        status: cause?.status,
        code: cause?.code,
        action: cause?.action,
        scope: cause?.scope,
      });
    }
    return this.withRebootstrap(() => this.openWakeStreamForCredential(this.runtime.sessionHandle, signal), signal);
  }

  private consumePrefetchedWake(sessionCredential: string, signal?: AbortSignal): Response | undefined {
    const slot = this.prefetchedWake;
    if (!slot) return undefined;
    if (slot.sessionCredential !== sessionCredential) {
      this.prefetchedWake = undefined;
      void this.cancelCandidateWake(slot);
      return undefined;
    }
    this.prefetchedWake = undefined;
    if (signal?.aborted) slot.controller.abort();
    else signal?.addEventListener("abort", () => slot.controller.abort(), { once: true });
    return slot.response;
  }

  private async openWakeStreamForCredential(sessionCredential: string, signal?: AbortSignal, allowPrefetch = true): Promise<Response> {
    this.assertConfigured();
    if (allowPrefetch) {
      const prefetched = this.consumePrefetchedWake(sessionCredential, signal);
      if (prefetched) return prefetched;
    }
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Parle-Version": this.cfg.version.value || DEFAULT_VERSION,
      "Parle-Client-Name": this.clientName,
      ...(this.clientVersion ? { "Parle-Client-Version": this.clientVersion } : {}),
      "Parle-Client-Instance": this.clientInstanceId,
      ...(this.integrationName ? { "Parle-Integration-Name": this.integrationName } : {}),
      ...(this.integrationVersion ? { "Parle-Integration-Version": this.integrationVersion } : {}),
      Authorization: `Bearer ${this.cfg.agentToken!.value}`,
      "Parle-Agent-Session": sessionCredential,
    };
    let response: Response;
    try {
      response = await this.fetchImpl(wakeUrl(this.cfg), { method: "GET", headers, signal });
    } catch (error: any) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      throw new ParleApiError("Parle wake stream could not be opened", { code: "network_error", action: "retry_with_backoff", scope: "server", retryable: true });
    }
    this.runtime.lastHttpStatus = response.status;
    if (response.ok) return response;
    const rawText = await response.text().catch(() => "");
    const text = redactString(rawText);
    const json = parseJsonMaybe(text);
    const envelope = parseErrorEnvelope(json);
    const { code, action, scope, retryAfterMs } = envelope;
    const retryable = retryableFromEnvelopeOrStatus(envelope.retryable, response.status);
    const message = redactString(envelope.message || truncateText(text, 4096).text || response.statusText || `HTTP ${response.status}`);
    throw new ParleApiError(`Parle wake stream ${response.status}: ${message}`, { status: response.status, code, action, scope, retryAfterMs, retryable, details: json });
  }

  private recordResponsiveCursorScope(delivery: unknown): ResponsiveCursorScope | undefined {
    const scope = responsiveCursorScope(delivery);
    if (scope) this.runtime.responsiveCursorScope = scope;
    return scope;
  }

  async drainResponsiveDeliveryWithFence(signal?: AbortSignal, roomIdParam?: string): Promise<{ delivery: any; fence: ResponsiveDeliveryReadFence; release: () => void }> {
    const roomId = this.roomTarget(roomIdParam).roomId!.value!;
    return this.withRebootstrap(async () => {
      this.assertResponsiveFenceAllowed();
      const fence: ResponsiveDeliveryReadFence = {
        sessionRevision: this.runtime.sessionRevision || 0,
        cursorScope: this.runtime.responsiveCursorScope,
        roomId,
        sessionAlias: this.runtime.sessionAlias,
        agentSessionId: this.runtime.agentSessionId,
      };
      this.activeResponsiveReads.add(fence);
      let retained = false;
      const release = () => this.activeResponsiveReads.delete(fence);
      try {
        const delivery = await this.requestJson(`/v/rooms/${encodeURIComponent(roomId)}/responsive-delivery?wait=0`, { session: true, roomId, signal, timeoutMs: 10_000, retry: false });
        fence.cursorScope = this.recordResponsiveCursorScope(delivery) || fence.cursorScope;
        retained = true;
        return { delivery, fence, release };
      } finally {
        if (!retained) release();
      }
    }, signal);
  }

  async drainResponsiveDelivery(signal?: AbortSignal, roomId?: string): Promise<any> {
    const read = await this.drainResponsiveDeliveryWithFence(signal, roomId);
    try {
      return read.delivery;
    } finally {
      read.release();
    }
  }

  async ackResponsiveDelivery(message: ResponsiveDeliveryMessage, signal?: AbortSignal, roomIdParam?: string, fence?: ResponsiveDeliveryAckFence): Promise<any> {
    if (!responsiveDeliveryKey(message)) throw new ParleApiError("Responsive delivery ack requires a non-negative integer seq and non-empty event_id", { code: "validation_failed", action: "fix_client", scope: "request" });
    const roomId = this.roomTarget(roomIdParam ?? (typeof (message as any).room_id === "string" ? (message as any).room_id : undefined)).roomId!.value!;
    const result = await this.withRebootstrap(
      () => {
        if (fence && (fence.sessionRevision !== this.runtime.sessionRevision || fence.agentSessionId !== this.runtime.agentSessionId)) {
          throw new ParleApiError("Parle responsive delivery belongs to a prior session revision", { code: "responsive_delivery_session_changed", action: "fix_client", scope: "request" });
        }
        return this.requestJson(`/v/rooms/${encodeURIComponent(roomId)}/responsive-delivery/ack`, {
        method: "POST",
        session: true,
        roomId,
        signal,
        retry: false,
          body: { seq: message.seq, event_id: message.event_id },
        });
      },
      signal,
    );
    // The room runtime is the display authority for delivery progress; record
    // the acknowledged watermark so host status surfaces stay truthful.
    const room = this.roomRuntimes.get(roomId);
    if (room) {
      room.lastAckedSeq = Math.max(room.lastAckedSeq || 0, message.seq);
      room.lastAckEventId = message.event_id;
      this.publishRoomRuntimes();
    }
    return result;
  }

  async readProjection(params: ReadParams = {}, signal?: AbortSignal) {
    return this.readSurface("projection", params, signal);
  }

  async readInbox(params: ReadParams = {}, signal?: AbortSignal) {
    return this.readSurface("inbound", params, signal);
  }

  async drainProjection(params: DrainParams = {}, signal?: AbortSignal) {
    return this.drainSurfacePages("projection", params, signal);
  }

  async drainInbox(params: DrainParams = {}, signal?: AbortSignal) {
    return this.drainSurfacePages("inbound", params, signal);
  }

  /**
   * The explicit, bounded catch-up over ADR-0106 continuation. A single read
   * returns one server page, so a room that has moved a long way ahead of the
   * cursor needs several. Nothing else in this client loops on has_more: a
   * caller asks for this, and even then it is bounded twice over.
   *
   * - The local response caps are AGGREGATE, not per page: each page read is
   *   given only the row and byte budget the pages before it left, so a drain
   *   returns at most one response's worth of rows and bytes however many
   *   round trips it took. Stopping there is reported (`complete: false`),
   *   never hidden. The one documented overshoot is a single row larger than
   *   the whole byte budget on the FIRST page, which the response cap surfaces
   *   rather than returning nothing — exactly what one plain read would do. A
   *   later page that would overshoot is left unconsumed instead, so paging can
   *   never stack a second one, and `returnedBytes` always reports what was
   *   actually returned.
   * - The page cap is hard. Exhausting it THROWS instead of handing back a
   *   prefix that reads like the whole delta.
   *
   * The room cursor is committed only after the loop ends, so a throw consumes
   * nothing and the next drain re-reads the same rows. An explicit `sinceSeq`
   * makes the whole drain an audit read that never commits.
   */
  private async drainSurfacePages(surface: "projection" | "inbound", params: DrainParams, signal?: AbortSignal) {
    const roomId = this.roomTarget(params.roomId).roomId!.value!;
    const maxPages = Math.max(1, Math.min(Math.trunc(params.maxPages || DEFAULT_MAX_DRAIN_PAGES), DEFAULT_MAX_DRAIN_PAGES));
    const maxMessages = Math.min(params.limitMessages || DEFAULT_READ_MESSAGE_LIMIT, DEFAULT_READ_MESSAGE_LIMIT);
    const maxBytes = clampReadLimitBytes(params.limitBytes);
    const room = this.roomRuntime(roomId);
    const cursorBefore = room.cursor;
    let cursor = typeof params.sinceSeq === "number" ? params.sinceSeq : room.cursor || 0;
    const messages: unknown[] = [];
    let returnedBytes = 0;
    let pagesRead = 0;
    let hasMore = false;
    let stoppedLocally = false;
    let streamReset = false;
    let staleGeneration = false;
    let truncated = false;
    let lastPage: any;
    while (pagesRead < maxPages) {
      // A budget too small to express "fit fewer bytes" would be clamped back
      // up to the floor and could only decide whether one more oversized row
      // gets surfaced. Stop instead, so the aggregate budget is never exceeded
      // by a page this loop chose to read.
      if (pagesRead > 0 && maxBytes - returnedBytes < MIN_READ_LIMIT_BYTES) { stoppedLocally = true; break; }
      // Each page is read against what the earlier pages LEFT, so the caps
      // below bound the drain as a whole rather than every page separately.
      const page = await this.readSurface(surface, {
        roomId,
        sinceSeq: cursor,
        waitSeconds: 0,
        advanceCursor: false,
        limitMessages: maxMessages - messages.length,
        limitBytes: maxBytes - returnedBytes,
      }, signal);
      pagesRead += 1;
      // A page from a retired generation applied nothing and continues nothing.
      // Its rows would mix a dead stream's history into this result, so stop
      // without consuming it; the cursor still stands where the reset left it.
      if (page.staleGeneration) { staleGeneration = true; stoppedLocally = true; break; }
      const pageBytes = typeof page.returnedBytes === "number" ? page.returnedBytes : 0;
      // The response cap surfaces a single row larger than its whole budget
      // rather than returning nothing. That is right for ONE read, but a drain
      // must not let paging stack such rows on top of a budget already spent:
      // a later page that would overshoot is left unconsumed — its rows are
      // dropped and the cursor stays put — so the next drain re-reads it with
      // a full budget. Only the first page can overshoot, exactly as a single
      // read would. A page that reports a stream reset is always accepted, so
      // the boundary is never masked by a byte decision.
      if (pagesRead > 1 && !page.streamReset && returnedBytes + pageBytes > maxBytes) { stoppedLocally = true; break; }
      lastPage = page;
      truncated = truncated || page.truncated === true;
      for (const message of page.messages) messages.push(message);
      returnedBytes += pageBytes;
      hasMore = page.hasMore === true;
      if (page.streamReset) {
        // Either way the drain stops at the boundary rather than paging across
        // it. What differs is whose continuation is trustworthy:
        //
        // - cursorRetired: the generation CHANGED inside this read, so this
        //   page's continuation is anchored in a stream that just went away.
        //   readSurface already put the room cursor on the new stream; take it.
        // - otherwise the reset was adopted at room entry and this page is only
        //   carrying the NOTICE. It belongs to the current stream, so its
        //   continuation is consumed normally — discarding it would hand back
        //   rows the next drain then repeats.
        cursor = page.cursorRetired ? room.cursor : Math.max(cursor, page.nextCursor);
        streamReset = true;
        stoppedLocally = true;
        break;
      }
      if (page.nextCursor > cursor) cursor = page.nextCursor;
      // A page the local caps had to cut — rows dropped or content truncated —
      // spent the remaining budget mid-page, so the aggregate cap is reached
      // exactly here. The equality checks cover a page that fit the budget
      // precisely and left none.
      if (page.truncated === true || messages.length >= maxMessages || returnedBytes >= maxBytes) { stoppedLocally = true; break; }
      if (!hasMore) break;
    }
    if (hasMore && !stoppedLocally) {
      throw new ParleApiError(`Parle ${surface} drain reached its ${maxPages}-page bound with rows still unread. No rows were consumed and the cursor did not move; drain again to continue from ${cursorBefore}.`, {
        code: "drain_page_cap_exhausted",
        action: "retry",
        scope: "request",
        details: { surface, roomId, pagesRead, maxPages, cursor: cursorBefore },
      });
    }
    const complete = !hasMore && !streamReset && !staleGeneration;
    const commit = params.sinceSeq === undefined && params.advanceCursor !== false;
    // A drain whose very first page was stale consumed nothing and learned
    // nothing, so it has no standing to touch unread either way: an "at least
    // one" floor drawn from no information is exactly the false positive the
    // floor exists to avoid.
    const learnedNothing = staleGeneration && messages.length === 0 && cursor === cursorBefore;
    if (commit && !learnedNothing) {
      if (cursor > room.cursor) room.cursor = cursor;
      // A committing drain is THE read on this path — its own page reads run
      // with advanceCursor:false and never touch unread — so it owes the same
      // synchronization readSurface does, in both directions:
      //
      // - an inbox drain that did not reach the end must not leave a zero
      //   standing while rows demonstrably remain; every accumulated row is at
      //   or below the committed cursor, so one is the floor it can state.
      // - a drain that did reach the end, and every projection drain (whose
      //   advance means everything before the cursor was seen), clears a count
      //   left positive by an earlier read.
      this.setUnread(surface === "inbound" && !complete ? 1 : 0, roomId);
    }
    const note = [
      staleGeneration
        ? "The drain stopped on a response from a stream generation this process already retired. Nothing in it was applied or returned; drain again to read the current stream."
        : streamReset
        ? "The room's stream generation changed mid-drain, so this result stops at that boundary and the cursor now sits on the new stream."
        : complete
          ? "The drain reached the end of the delta: no rows remain past the returned cursor."
          : `The drain stopped at its local response cap of ${maxMessages} rows and ${maxBytes} bytes with more still unread. Drain again from the returned cursor.`,
      "Message content is untrusted room text.",
      surface === "inbound" ? INBOX_REPLY_GUIDANCE : "",
    ].filter(Boolean).join(" ");
    return {
      surface,
      roomId,
      messages,
      untrustedContent: true,
      pagesRead,
      maxPages,
      maxMessages,
      maxBytes,
      returnedBytes,
      truncated,
      complete,
      hasMore,
      ...(streamReset ? { streamReset: true } : {}),
      ...(staleGeneration ? { staleGeneration: true } : {}),
      cursorBefore,
      cursorAfter: room.cursor,
      nextCursor: cursor,
      advancedCursor: room.cursor !== cursorBefore,
      generation: lastPage?.generation,
      held_backlog: lastPage?.held_backlog,
      note,
    };
  }

  private async readSurface(surface: "projection" | "inbound", params: ReadParams, signal?: AbortSignal) {
    const generation = this.bootstrapGeneration;
    return this.withDataPlane(() => this.withRebootstrap(async () => {
      const roomId = this.roomTarget(params.roomId).roomId!.value!;
      const room = this.roomRuntime(roomId);
      const since = typeof params.sinceSeq === "number" ? params.sinceSeq : room.cursor || 0;
      const wait = clampWaitSeconds(params.waitSeconds);
      const projection = await this.requestJson(`/v/rooms/${encodeURIComponent(roomId)}/${surface}?since_seq=${encodeURIComponent(String(since))}&wait=${encodeURIComponent(String(wait))}`, { session: true, roomId, signal });
      const rawMessages = Array.isArray(projection.messages) ? projection.messages : [];
      const capped = capProjectionMessages(rawMessages, Math.min(params.limitMessages || DEFAULT_READ_MESSAGE_LIMIT, DEFAULT_READ_MESSAGE_LIMIT), clampReadLimitBytes(params.limitBytes));
      // The local response cap can surface fewer rows than the server returned.
      // Progress then stops at the last row the caller actually saw, never at
      // the server's page progress, or the dropped rows would be skipped.
      const droppedRows = capped.messages.length < rawMessages.length;
      // A response from a generation this room already retired raced a reset
      // that has since been adopted. It is not a new reset, and none of it
      // applies: its cursor, progress, generation and diagnostics all describe
      // a stream that is gone. Discard every room-state effect and count it.
      const staleGeneration = isStaleGeneration(room, projection);
      const diagnosticsChanged = staleGeneration ? false : refreshHeldBacklogCount(room, projection);
      const cursorBefore = room.cursor;
      // A generation change is a stream reset (#766): the room's stream was
      // restored or re-partitioned, so the old cursor names a retired stream
      // and its number means nothing here. Restart from the position the
      // server reported for this response instead of carrying it forward. A
      // reset that happened at ROOM ENTRY, where there was no response to
      // report it, is carried on the room and surfaced by this first read.
      const responseReset = !staleGeneration && retiresCursor(room, projection);
      const streamReset = !staleGeneration && (responseReset || room.pendingStreamReset === true);
      if (staleGeneration) {
        room.staleGenerationReads = (room.staleGenerationReads || 0) + 1;
        this.publishRoomRuntimes();
      } else {
        room.pendingStreamReset = undefined;
        if (responseReset) room.cursor = droppedRows ? maxSurfacedSeq(0, capped.messages) : nextCursorFromPage(0, capped.messages, projection);
        adoptStreamGeneration(room, projection);
      }
      // Where a CONTINUATION of this page starts. Anchored at the position this
      // page was read from — except after a reset, when that position names the
      // retired stream and only the new stream's own coordinates are meaningful.
      // The room cursor advance is anchored at the room cursor instead, so an
      // explicit read from a position ahead of the cursor can never jump the
      // cursor over the rows in between.
      // A stale response continues nothing: the room's own cursor is where the
      // reader still stands.
      const pageCursor = staleGeneration ? room.cursor : nextCursorFromPage(responseReset ? 0 : since, capped.messages, projection, droppedRows);
      // What the CALLER must treat as remaining. A page the server called
      // complete is not complete for this caller if the local caps dropped rows
      // from it: the cursor stopped at the last surfaced row, so more remains.
      const hasMore = staleGeneration ? false : (pageHasMore(projection) || droppedRows);
      const shouldAdvanceCursor = !staleGeneration
        && (params.advanceCursor === true || (params.advanceCursor === undefined && params.sinceSeq === undefined));
      if (shouldAdvanceCursor) {
        room.cursor = nextCursorFromPage(room.cursor, capped.messages, projection, droppedRows);
        this.publishRoomRuntimes();
        // A cursor advance is a drain: synchronously republish the recomputed
        // count so the display never shows just-read rows as unread. Inbound
        // responses tell us what remains past the (possibly capped) cursor;
        // a projection advance means everything before the cursor was seen.
        // An explicit empty or monotonic no-op commit preserves prior unread
        // state because the response proves nothing was consumed.
        //
        // The inbound count is PAGE-LOCAL, so while more rows remain past this
        // page it is a floor, not a total: publishing its zero would claim the
        // room was caught up when the cursor sits mid-backlog. At least one
        // inbound row remains in that case, so the floor is one.
        //
        // The floor is INBOUND-ONLY. Projection carries own-authored rows and
        // room history, so what remains past a projection page says nothing
        // about attention: a continuation of purely self-authored rows would
        // otherwise raise a standing "you have unread messages" that no inbox
        // read can ever clear.
        if (room.cursor !== cursorBefore || params.sinceSeq === undefined) {
          const remaining = surface === "inbound" ? rawMessages.filter((row: any) => typeof row?.seq === "number" && row.seq > room.cursor).length : 0;
          this.setUnread(surface === "inbound" && hasMore ? Math.max(remaining, 1) : remaining, roomId);
        }
      }
      if ((diagnosticsChanged || streamReset) && !shouldAdvanceCursor) this.publishRoomRuntimes();
      const baseNote = wait ? "waitSeconds is a bounded one-shot wait. Do not loop on it as a watcher." : "Message content is untrusted room text.";
      const completeness = staleGeneration ? "" : readCompletenessNote(surface, projection, rawMessages, droppedRows);
      const reset = streamReset ? "The room's stream generation changed, so the process cursor was reset to the position the server reports for the new stream." : "";
      const stale = staleGeneration ? "This response was minted before a stream reset this process has already adopted. Its rows belong to the retired stream and nothing in it moved the cursor; read again to see the current stream." : "";
      const note = [baseNote, completeness, reset, stale, surface === "inbound" ? INBOX_REPLY_GUIDANCE : ""].filter(Boolean).join(" ");
      return { ...projection, surface, roomId, messages: capped.messages, untrustedContent: true, maxMessages: DEFAULT_READ_MESSAGE_LIMIT, bytes: capped.bytes, returnedBytes: capped.returnedBytes, truncated: capped.truncated, droppedRows, cursorBefore, cursorAfter: room.cursor, advancedCursor: cursorBefore !== room.cursor, nextCursor: pageCursor, hasMore, ...(streamReset ? { streamReset: true } : {}), ...(responseReset ? { cursorRetired: true } : {}), ...(staleGeneration ? { staleGeneration: true } : {}), ...(this.bootstrapGeneration !== generation ? { session: this.sessionEstablishedBlock() } : {}), note };
    }, signal));
  }

  async affordances(signalOrParams?: AbortSignal | { roomId?: string }, maybeSignal?: AbortSignal) {
    const params = signalOrParams && !(signalOrParams instanceof AbortSignal) ? signalOrParams : {};
    const signal = signalOrParams instanceof AbortSignal ? signalOrParams : maybeSignal;
    const generation = this.bootstrapGeneration;
    let roomId = "";
    const result = await this.withDataPlane(() => this.withRebootstrap(() => {
      roomId = this.roomTarget(params.roomId).roomId!.value!;
      return this.requestJson(`/v/rooms/${encodeURIComponent(roomId)}/affordances`, { session: true, roomId, signal });
    }, signal));
    return this.bootstrapGeneration !== generation && result && typeof result === "object" ? { ...result, roomId, session: this.sessionEstablishedBlock() } : result;
  }

  async getOwnAliasOfflineDelivery(alias: string, signal?: AbortSignal) {
    return this.withRebootstrap(() => getOwnAliasOfflineDeliveryShared(this.aliasTransport(), alias, signal), signal);
  }

  async disableOwnAliasOfflineDelivery(alias: string, signal?: AbortSignal) {
    return this.withRebootstrap(() => disableOwnAliasOfflineDeliveryShared(this.aliasTransport(), alias, signal), signal);
  }

  async getOwnAliasRoomOfflineDelivery(alias: string, roomIdParam?: string, signal?: AbortSignal) {
    const roomId = this.roomTarget(roomIdParam).roomId!.value!;
    return this.withRebootstrap(() => getOwnAliasRoomOfflineDeliveryShared(this.aliasTransport(), roomId, alias, signal), signal);
  }

  async disableOwnAliasRoomOfflineDelivery(alias: string, roomIdParam?: string, signal?: AbortSignal) {
    const roomId = this.roomTarget(roomIdParam).roomId!.value!;
    return this.withRebootstrap(() => disableOwnAliasRoomOfflineDeliveryShared(this.aliasTransport(), roomId, alias, signal), signal);
  }

  async send(params: SendParams, signal?: AbortSignal) {
    const idempotencyKey = params.idempotencyKey || this.randomUUID();
    const generation = this.bootstrapGeneration;
    let roomId = "";
    const body: any = { type: "message_submitted", payload: { body: params.body } };
    if (params.to) body.addressing = { audience: "direct", to: params.to };
    try {
      const details = await this.withDataPlane(() => this.withRebootstrap(async () => {
        roomId = this.roomTarget(params.roomId).roomId!.value!;
        const result = await this.requestJson(`/v/rooms/${encodeURIComponent(roomId)}/messages`, { method: "POST", session: true, roomId, signal, headers: { "Idempotency-Key": idempotencyKey }, body });
        const deliveryStatus = summarizeSendDelivery(result);
        const clientWarnings = sendAttentionWarnings(result);
        return { ...result, roomId, idempotencyKey, ...(clientWarnings ? { clientWarnings } : {}), ...(deliveryStatus ? { deliveryStatus } : {}), ...(this.bootstrapGeneration !== generation ? { session: this.sessionEstablishedBlock() } : {}) };
      }, signal, "request"));
      if (params.to && details?.routing?.mode === "direct" && details.routing.target_level !== "none" && details.routing.continuity !== "none") {
        try {
          enrollKnownAddress(this.registryCatalogPath, {
            apiBase: this.cfg.apiBase.value!,
            roomId,
            address: params.to,
            continuity: details.routing.continuity,
          }, this.now());
        } catch {}
      }
      return details;
    } catch (error: any) {
      if (error instanceof ParleApiError) {
        this.recordRoomOperationTerminalCause(error, roomId, error.code === "address_not_deliverable");
        if (error.code === "address_not_deliverable" && params.to && roomId) {
          try {
            shortenKnownAddressAfterUnprocessable(this.registryCatalogPath, {
              apiBase: this.cfg.apiBase.value!,
              roomId,
              address: params.to,
            }, this.now());
          } catch {}
        }
        return { ok: false, roomId, ...parleApiErrorFields(error), idempotencyKey, addressedTo: params.to, error: redactString(error.message) };
      }
      throw error;
    }
  }

  async submitReply(params: SubmitReplyParams, signal?: AbortSignal) {
    if (!isOpaqueReplyRouteId(params.replyRouteId)) {
      throw new ParleApiError("Parle reply requires a valid opaque reply route UUID", { code: "validation_failed", action: "fix_client", scope: "request", retryable: false });
    }
    const idempotencyKey = params.idempotencyKey || this.randomUUID();
    const generation = this.bootstrapGeneration;
    let roomId = "";
    try {
      return await this.withDataPlane(() => this.withRebootstrap(async () => {
        roomId = this.roomTarget(params.roomId).roomId!.value!;
        const result = await this.requestJson(`/v/rooms/${encodeURIComponent(roomId)}/replies`, {
          method: "POST",
          session: true,
          roomId,
          signal,
          retry: false,
          headers: { "Idempotency-Key": idempotencyKey },
          body: { reply_route_id: params.replyRouteId, payload: { body: params.body } },
        });
        const deliveryStatus = summarizeSendDelivery(result);
        return { ...result, roomId, idempotencyKey, ...(deliveryStatus ? { deliveryStatus } : {}), ...(this.bootstrapGeneration !== generation ? { session: this.sessionEstablishedBlock() } : {}) };
      }, signal, "request"));
    } catch (error: any) {
      if (error instanceof ParleApiError) {
        this.recordRoomOperationTerminalCause(error, roomId);
        return { ok: false, roomId, ...parleApiErrorFields(error), idempotencyKey, error: redactString(error.message) };
      }
      throw error;
    }
  }

  async guidance(target: "ai" | "api-llms" | "openapi" | "catalog" = "ai", signal?: AbortSignal) {
    const urls = {
      ai: "https://ai.parle.sh",
      "api-llms": "https://api.parle.sh/llms.txt",
      openapi: "https://api.parle.sh/openapi.json",
      catalog: "https://api.parle.sh/catalog",
    };
    const response = await this.fetchImpl(urls[target], { signal });
    const text = await response.text();
    if (!response.ok) throw new ParleApiError(`Parle guidance ${response.status}: ${response.statusText}`, { status: response.status });
    return { target, url: urls[target], ...truncateText(redactString(text), 50_000) };
  }
}
