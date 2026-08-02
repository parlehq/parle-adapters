import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RUNTIME_SCHEMA_VERSION, processStartedAtIso, pruneRuntimeFiles, removeRuntimeFile, writeRuntimeFile } from "./runtime-file.js";
import { assertClientInstanceId, assertClientName, assertClientVersion, processClientInstanceId } from "./process-instance.js";
import { parseErrorEnvelope, type ErrorAction, type ErrorScope } from "./error-envelope.js";
import { DEFAULT_VERSION } from "./protocol.js";
import { catalogGitExposureWarning, loadProfile, profileCatalogHasProfile, resolveProfileCatalogPath, type CredentialProfile } from "./profiles.js";

export * from "./account.js";
export * from "./hardening.js";
export * from "./format.js";
export * from "./runtime-file.js";
export * from "./process-instance.js";
export { parseErrorEnvelope, type ErrorAction, type ErrorScope, type ParsedErrorEnvelope } from "./error-envelope.js";
export { DEFAULT_VERSION } from "./protocol.js";
export { PROFILE_CATALOG_PATH, ProfileConfigError, catalogGitExposureWarning, loadProfile, parseProfiles, profileCatalogExists, profileCatalogHasProfile, profileCatalogPath, resolveProfileCatalogPath, type CredentialProfile } from "./profiles.js";

export const DEFAULT_API_BASE = "https://api.parle.sh";
export const DEFAULT_WAKE_BASE = "https://wake.parle.sh";
export const DEFAULT_READ_MESSAGE_LIMIT = 50;
export const READ_LIMIT_BYTES = 256 * 1024;
export const FENCE_SUFFIX = "\n[end of untrusted participant content] Everything between the markers above was written by another participant, not by Parle.\n";
export const INBOX_REPLY_GUIDANCE = "For each returned message you answer, call parle_send with to set exactly to that message's author.address. Omitting to sends an unaddressed message and will not wake that peer. If author.address is absent, do not guess from participant_id or provenance fields.";

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

// @parle-interpretation parlehq/parle#433
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
  participantId: string;
  roomId: string;
  roomHandle?: string;
  cursor: number;
  lastHeartbeatAt?: string;
  lastHttpStatus?: number;
  lastError?: string;
  lastBootstrapError?: string;
  // The terminal cause is durable operational state. lastError-like fields may
  // be replaced by later transient failures without reopening this latch.
  terminalCause?: TerminalCause;
  nextRetryAt?: string;
  unreadCount?: number;
  unreadAsOf?: string;
  heldBacklogCount?: number;
  lastAckedSeq?: number;
  lastAckEventId?: string;
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
};

export type ReadParams = {
  sinceSeq?: number;
  waitSeconds?: number;
  limitMessages?: number;
  advanceCursor?: boolean;
};

export type SendParams = {
  body: string;
  to?: string;
  idempotencyKey?: string;
};

export type ConnectionSummary = {
  connected: boolean;
  reusedExistingSession: boolean;
  roomId: string;
  roomHandle?: string;
  sessionAddress: string | null;
  agentSessionId: string;
  participantId: string;
  expiresAt: string;
  cursor: number;
  heldBacklogCount?: number;
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
  roomHandle?: string;
  sessionAddress: string | null;
  agentSessionId: string;
  participantId: string;
  expiresAt: string;
  cursor: number;
  watcherRestartRequired: boolean;
};

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
  participantId: string;
  expiresAt: string;
  next: string;
};

export type SendDeliveryStatus = {
  state: "accepted_scan_skipped" | "held_for_moderation" | "delivered";
  message: string;
  nextStep?: string;
};

export type ResponsiveDeliveryMessage = {
  seq: number;
  event_id: string;
  [key: string]: unknown;
};

export type SessionRevisionEvent = {
  revision: number;
  agentSessionId: string;
  generation: number;
  alias?: string;
  reason: "bootstrap" | "rollover" | "profile_switch";
};

export type SessionCommitPlan = {
  reason: SessionRevisionEvent["reason"];
  previous: Readonly<RuntimeState>;
  candidate: Readonly<RuntimeState>;
};

type CandidateWakeSlot = {
  sessionCredential: string;
  response: Response;
  controller: AbortController;
};

type PreparedCandidate = {
  state: RuntimeState;
  wake?: CandidateWakeSlot;
};

const ROLLOVER_LEAD_MS = 5 * 60_000;
const ROLLOVER_JITTER_RANGE_MS = 60_000;
const ROLLOVER_MAX_FAILURES = 3;
const ROLLOVER_RETRY_MS = 5_000;
const ROLLOVER_COOLDOWN_MS = 60_000;
const CLAIM_RECOVERY_ATTEMPTS = 3;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const SESSION_INVENTORY_MAX_PAGES = 100;

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

export class ParleApiError extends Error {
  status?: number;
  code?: string;
  action?: ErrorAction;
  scope?: ErrorScope;
  retryAfterMs?: number;
  retryable: boolean;
  details?: unknown;

  constructor(message: string, options: { status?: number; code?: string; action?: ErrorAction; scope?: ErrorScope; retryAfterMs?: number; retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = "ParleApiError";
    this.status = options.status;
    this.code = options.code;
    this.action = options.action;
    this.scope = options.scope;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

class AliasClaimOutcomeUnknownError extends ParleApiError {}

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
      throw new Error(`PARLE_PROFILE from ${profileSelector.source} conflicts with direct configuration (${conflicts.join(", ")}). Remove the direct variables or unset PARLE_PROFILE.`);
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
    sessionAlias: firstConfigValue("PARLE_SESSION_ALIAS", sources),
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
const PARLE_CREDENTIAL_RE = /parle_[a-z]+_[A-Za-z0-9_-]{20,}/g;

function isParleCredential(value: string): boolean {
  PARLE_CREDENTIAL_RE.lastIndex = 0;
  return PARLE_CREDENTIAL_RE.test(value);
}

export function redactString(input: string): string {
  let out = input
    .replace(/Bearer\s+[A-Za-z0-9_./+=:-]+/g, "Bearer <redacted>")
    .replace(/(__Host-parle_session=)[^;\s]+/g, "$1<redacted>")
    .replace(/(Idempotency-Key\s*[:=]\s*)[A-Za-z0-9._:-]+/gi, "$1<redacted>")
    .replace(/(Parle-Agent-Session\s*[:=]\s*)[A-Za-z0-9._:-]+/gi, "$1<redacted>");
  PARLE_CREDENTIAL_RE.lastIndex = 0;
  return out.replace(PARLE_CREDENTIAL_RE, "<redacted-token>");
}

export function redactedValue(value?: ConfigValue): { source: string; configured: boolean; value?: string } {
  if (!value?.value) return { source: value?.source || "missing", configured: false };
  const sensitiveShape = isParleCredential(value.value) || value.value.includes("__Host-parle_session");
  return { source: value.source, configured: true, value: sensitiveShape ? redactString(value.value) : value.value };
}

export function redactedSecretValue(value?: ConfigValue): { source: string; configured: boolean; value?: string } {
  return { source: value?.source || "missing", configured: Boolean(value?.value), value: value?.value ? "<redacted>" : undefined };
}

export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const source = Buffer.from(text, "utf8");
  const bytes = source.byteLength;
  if (bytes <= maxBytes) return { text, truncated: false, bytes };
  const suffix = Buffer.from("\n[truncated]", "utf8");
  const limit = Math.max(0, maxBytes - suffix.byteLength);
  let slice = source.subarray(0, limit);
  while (slice.length > 0 && (slice[slice.length - 1] & 0b1100_0000) === 0b1000_0000) slice = slice.subarray(0, -1);
  return { text: Buffer.concat([slice, suffix]).toString("utf8"), truncated: true, bytes };
}

export function assertSafeBase(base: string, env: Record<string, string | undefined> = process.env): void {
  const url = new URL(base);
  const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (isLocal && env.PARLE_ALLOW_INSECURE_LOCAL === "1") return;
  if (url.protocol !== "https:") throw new Error(`Parle API base must use https: ${base}`);
  if (url.hostname !== "parle.sh" && !url.hostname.endsWith(".parle.sh")) throw new Error(`Parle API base is not allowlisted: ${url.hostname}`);
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

export function updateCursorFromMessages(cursor: number, messages: unknown[], watermark?: unknown): number {
  let next = cursor || 0;
  for (const message of messages) {
    const seq = typeof (message as any)?.seq === "number" ? (message as any).seq : 0;
    if (seq > next) next = seq;
  }
  if (messages.length === 0 && typeof watermark === "number" && watermark > next) next = watermark;
  return next;
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
      if (capped.length === 0) capped.push(copy);
      break;
    }
    capped.push(copy);
    returnedBytes += bytes;
  }
  return { messages: capped, bytes: Buffer.byteLength(JSON.stringify(messages), "utf8"), returnedBytes, truncated };
}

// @parle-interpretation parlehq/parle#428
// Temporary local advisory until the API returns canonical inert-mention warnings.
export function bodyLooksLikeAddressedText(body: string): boolean {
  return /^\s*@[-a-z0-9_.]+\b/i.test(body);
}

// @parle-interpretation parlehq/parle#428
export function addressingWarning(body: string, to?: string): string | undefined {
  if (to || !bodyLooksLikeAddressedText(body)) return undefined;
  return "Body @mentions do not address a Parle message. This message was sent unaddressed and will not wake a peer watcher. Pass to: \"@principal.agent\" or to: \"@principal.agent.session\" for responsive delivery.";
}

// @parle-interpretation parlehq/parle-adapters#13
// Remove or narrow this when the API exposes canonical delivery state semantics.
export function summarizeSendDelivery(details: any): SendDeliveryStatus | undefined {
  const moderation = details?.moderation;
  if (!moderation || typeof moderation !== "object") return undefined;
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

// @parle-interpretation parlehq/parle#430
// Exact validation of server framing until the byte format is a versioned core contract.
export function compactServerWrappedContent(content: string, preamble?: string, fence?: string | null): string {
  if (!preamble || !fence) return content;
  const open = `«FENCE BEGIN ${fence}»`;
  const close = `«FENCE END ${fence}»`;
  const expectedPrefix = preamble + "\n";
  if (!content.startsWith(expectedPrefix) || !content.endsWith(FENCE_SUFFIX)) return content;
  const fencedSpan = content.slice(expectedPrefix.length, content.length - FENCE_SUFFIX.length);
  if (!fencedSpan.startsWith(open + "\n") || !fencedSpan.endsWith("\n" + close)) return content;
  if (fencedSpan.indexOf(open) !== fencedSpan.lastIndexOf(open) || fencedSpan.indexOf(close) !== fencedSpan.lastIndexOf(close)) return content;
  if (content !== expectedPrefix + fencedSpan + FENCE_SUFFIX) return content;
  return fencedSpan;
}

export class ParleAgentClient {
  cfg: ParleConfig;
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
    participantId: "",
    roomId: "",
    cursor: 0,
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
  // This latch is deliberately consulted only by automatic work. Explicit
  // connect/read/send and raw requestJson calls remain recovery paths.
  private automaticTerminalBinding?: string;

  constructor(options: ClientOptions = {}) {
    this.env = options.env || process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.cfg = resolveConfig(this.cwd, this.env);
    this.activeProfile = this.cfg.profile?.value;
    this.fetchImpl = options.fetch || fetch;
    this.now = options.now || (() => new Date());
    this.sleepImpl = options.sleep || defaultSleep;
    this.randomUUID = options.randomUUID || randomUUID;
    this.setTimer = options.setTimer || ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
    this.publishRuntime = options.publishRuntime;
    this.clientName = assertClientName(options.clientName || options.publishRuntime?.adapterName || "@parlehq/agent-client");
    const clientVersion = options.clientVersion || options.publishRuntime?.adapterVersion;
    this.clientVersion = clientVersion ? assertClientVersion(clientVersion) : undefined;
    if (options.integrationVersion && !options.integrationName) throw new Error("Parle integrationVersion requires integrationName.");
    this.integrationName = options.integrationName ? assertClientName(options.integrationName) : undefined;
    this.integrationVersion = options.integrationVersion ? assertClientVersion(options.integrationVersion) : undefined;
    this.clientInstanceId = assertClientInstanceId(options.clientInstanceId || processClientInstanceId());
    if (this.publishRuntime) {
      try {
        pruneRuntimeFiles(this.cwd, this.now());
      } catch {
        // Local state hygiene must never block client construction.
      }
    }
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
      runtime: { ...this.runtime, sessionHandle: this.runtime.sessionHandle ? "<redacted>" : "" },
      warnings: [...this.cfg.warnings, ...(this.staleTokenHint() ? [this.staleTokenHint()!] : []), ...(this.unreadIntervalHint() ? [this.unreadIntervalHint()!] : [])],
    };
  }

  setup() {
    const missing = [];
    if (!this.cfg.roomId?.value) missing.push("PARLE_ROOM_ID");
    if (!this.cfg.agentToken?.value) missing.push("PARLE_ROOM_AGENT_TOKEN");
    // @parle-interpretation parlehq/parle#434
    // Connection-posture wording pending the core session lifecycle contract.
    const note = missing.length
      ? "Set PARLE_PROFILE (a section of the profile catalog, ~/.parle/profiles by default, PARLE_PROFILES_PATH to relocate) or direct configuration in env or .env (checked in that order; disk token rotations can be reloaded once during bootstrap recovery)."
      : this.runtime.bootstrapped
        ? "Parle configuration is present and this process holds a session."
        : "Parle configuration is present. Not yet connected in this process; a connect, read, or send call establishes the session.";
    const staleToken = this.staleTokenHint();
    return { ok: missing.length === 0 && !staleToken, missing, connected: this.runtime.bootstrapped, apiBase: this.cfg.apiBase.value, note, ...(staleToken ? { warning: staleToken } : {}) };
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
  }

  // Disk-backed credentials are the one safe automatic recovery input. A
  // changed binding clears only the automatic gate, never suppressing an
  // explicit caller's retry.
  private refreshConfigIfAgentTokenChanged(): boolean {
    const oldBinding = this.bindingKey();
    const next = resolveConfig(this.cwd, this.selectedEnvironment());
    if (oldBinding === this.bindingKey(next)) return false;
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
      if (!this.cfg.agentToken?.value) throw new ParleApiError("Parle setup needed: PARLE_ROOM_AGENT_TOKEN is missing", { code: "setup_needed" });
      headers.Authorization = `Bearer ${this.cfg.agentToken.value}`;
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
      const { code, action, scope, retryAfterMs, retryable } = envelope;
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

  private async doBootstrapLocked(signal?: AbortSignal, preserveCursor = false, allowConfigReload = true): Promise<RuntimeState> {
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
        this.assertSessionCommitAllowed(previous, prepared.state, "bootstrap");
      } catch (error) {
        await this.cancelCandidateWake(prepared.wake);
        if (!prepared.state.sessionAlias) await this.retireSession(prepared.state).catch(() => undefined);
        throw error;
      }
      const unusedPreviousWake = this.commitCandidate(prepared, epoch);
      await this.completeCandidateHandoff(previous, prepared.state, "bootstrap", signal, unusedPreviousWake, oldWasLive);
      this.clearAutomaticTerminalLatch();
      this.clearRolloverStormProtection();
      this.consecutiveBootstrapFailures = 0;
      return { ...this.runtime };
    } catch (error: any) {
      if (allowConfigReload && error instanceof ParleApiError && error.action === "reauthorize" && this.refreshConfigIfAgentTokenChanged()) {
        return this.doBootstrapLocked(signal, preserveCursor, false);
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

  private async prepareCandidate(alias: string | undefined, signal: AbortSignal | undefined, preserveCursor: boolean, requireWakeReadiness: boolean): Promise<PreparedCandidate> {
    const previousCursor = this.runtime.cursor;
    const session = await this.requestJson("/v/agent/sessions", { method: "POST", body: {}, signal, rawResponse: true, retry: false });
    const candidate: RuntimeState = {
      bootstrapped: false,
      bootstrapState: "starting",
      sessionHandle: String(session.session_credential || ""),
      sessionAddress: typeof session.address === "string" ? session.address : null,
      sessionGeneration: 0,
      sessionRevision: this.runtime.sessionRevision,
      createdAt: String(session.created_at || ""),
      agentSessionId: String(session.agent_session_id || ""),
      expiresAt: String(session.expires_at || ""),
      participantId: "",
      roomId: this.cfg.roomId!.value!,
      cursor: preserveCursor ? previousCursor : 0,
    };
    let candidateWake: CandidateWakeSlot | undefined;
    try {
      const entry = await this.requestJson(`/v/rooms/${encodeURIComponent(candidate.roomId)}/participants`, {
        method: "POST", sessionCredential: candidate.sessionHandle, signal, retry: false,
      });
      candidate.participantId = String(entry.participant_id || "");
      candidate.roomHandle = typeof entry.room_handle === "string" && entry.room_handle ? entry.room_handle : this.cfg.roomHandle?.value;
      // Projection initialization is deliberately pre-claim. Once claim is
      // submitted, no later preparation failure may discard an authoritative
      // candidate whose response was lost.
      if (!preserveCursor) {
        const projection = await this.requestJson(`/v/rooms/${encodeURIComponent(candidate.roomId)}/projection?wait=0`, {
          sessionCredential: candidate.sessionHandle, signal, retry: false,
        });
        candidate.cursor = typeof projection.watermark === "number" ? projection.watermark : 0;
        if (typeof projection?.held_backlog?.held_count === "number") candidate.heldBacklogCount = projection.held_backlog.held_count;
      }
      if (alias || requireWakeReadiness) candidateWake = await this.establishCandidateWakeReadiness(candidate.sessionHandle, signal);
      if (alias) {
        const expectedGeneration = await this.currentAliasGeneration(alias, signal);
        const claimed = await this.claimAliasWithRecovery(candidate, alias, expectedGeneration, signal);
        candidate.sessionAlias = alias;
        candidate.sessionGeneration = Number.isInteger(claimed.generation) ? claimed.generation : expectedGeneration + 1;
        candidate.sessionAddress = typeof claimed.address === "string" ? claimed.address : candidate.sessionAddress;
        candidate.createdAt = String(claimed.created_at || candidate.createdAt);
        candidate.expiresAt = String(claimed.expires_at || candidate.expiresAt);
        candidate.responsiveContinuity = "alias";
      } else if (requireWakeReadiness) {
        candidate.responsiveContinuity = "exact_session_not_transferred";
      }
      candidate.bootstrapped = true;
      candidate.bootstrapState = "ready";
      return { state: candidate, wake: candidateWake };
    } catch (error) {
      await this.cancelCandidateWake(candidateWake);
      if (!(error instanceof AliasClaimOutcomeUnknownError)) await this.retireSession(candidate).catch(() => undefined);
      throw error;
    }
  }

  private async findInventorySession(predicate: (item: any) => boolean, signal?: AbortSignal): Promise<any | undefined> {
    let after: string | undefined;
    for (let pageNumber = 0; pageNumber < SESSION_INVENTORY_MAX_PAGES; pageNumber += 1) {
      const path = after ? `/v/agent/sessions?after=${encodeURIComponent(after)}` : "/v/agent/sessions";
      const page = await this.requestJson(path, { signal, retry: true });
      const sessions = Array.isArray(page.sessions) ? page.sessions : [];
      const match = sessions.find(predicate);
      if (match) return match;
      if (page.next === null || page.next === undefined) return undefined;
      if (typeof page.next !== "string" || page.next.length === 0) throw new ParleApiError("Parle session inventory returned an invalid continuation cursor", { code: "invalid_response", action: "fix_client", scope: "server" });
      after = page.next;
    }
    throw new ParleApiError(`Parle session inventory exceeded ${SESSION_INVENTORY_MAX_PAGES} pages`, { code: "inventory_limit", action: "stop", scope: "agent_session" });
  }

  private async currentAliasGeneration(alias: string, signal?: AbortSignal): Promise<number> {
    const match = await this.findInventorySession((item) => item?.alias === alias && Number.isInteger(item?.generation) && item.generation >= 0, signal);
    // Inventory contains live owners only. Returning zero for a missing durable
    // alias is the documented core-owned recovery limitation, not generation
    // inference. See the implementation report's unresolved blocker.
    return match?.generation ?? 0;
  }

  private async claimAliasWithRecovery(candidate: RuntimeState, alias: string, expectedGeneration: number, signal?: AbortSignal): Promise<any> {
    const path = `/v/agent/sessions/${encodeURIComponent(candidate.agentSessionId)}/claim-alias`;
    const body = { alias, expected_generation: expectedGeneration };
    let lastError: unknown;
    for (let attempt = 1; attempt <= CLAIM_RECOVERY_ATTEMPTS; attempt += 1) {
      try {
        return await this.requestJson(path, {
          method: "POST", body, sessionCredential: candidate.sessionHandle, signal, rawResponse: true, retry: false,
        });
      } catch (error: any) {
        if (error instanceof ParleApiError && error.status === 409) throw error;
        const responseLost = !(error instanceof ParleApiError) || error.status === undefined || error.status >= 500;
        if (!responseLost) throw error;
        lastError = error;
        try {
          const committed = await this.findInventorySession((item) => item?.agent_session_id === candidate.agentSessionId
            && item?.alias === alias
            && item?.generation === expectedGeneration + 1, signal);
          if (committed) return committed;
        } catch {
          // Inventory is confirmation, not a substitute mutation. A failed
          // confirmation may consume only the remaining bounded exact replays.
        }
        if (signal?.aborted) break;
      }
    }
    const detail = lastError instanceof Error ? redactString(lastError.message) : "claim response unavailable";
    throw new AliasClaimOutcomeUnknownError(`Parle alias claim outcome remains unknown after bounded exact replay and inventory confirmation: ${detail}`, {
      code: "alias_claim_outcome_unknown", action: "retry_with_backoff", scope: "agent_session", retryable: true,
    });
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

  private assertSessionCommitAllowed(previous: RuntimeState, candidate: RuntimeState, reason: SessionRevisionEvent["reason"]): void {
    const plan: SessionCommitPlan = { reason, previous: Object.freeze({ ...previous }), candidate: Object.freeze({ ...candidate }) };
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
    this.bootstrapGeneration += 1;
    this.publishRuntimeState();
    this.scheduleUnreadPoll();
    this.scheduleRollover();
    return unusedPreviousWake;
  }

  private async completeCandidateHandoff(previous: RuntimeState, candidate: RuntimeState, reason: SessionRevisionEvent["reason"], signal: AbortSignal | undefined, unusedPreviousWake: CandidateWakeSlot | undefined, drainImmediately: boolean): Promise<void> {
    if (drainImmediately) {
      try {
        const delivery = await this.requestJson(`/v/rooms/${encodeURIComponent(candidate.roomId)}/responsive-delivery?wait=0`, { sessionCredential: candidate.sessionHandle, signal, retry: false });
        this.recordResponsiveCursorScope(delivery);
      } catch (error) {
        this.runtime.lastError = redactString(error instanceof Error ? error.message : String(error));
        this.publishRuntimeState();
      }
    }
    if (candidate.sessionAlias) {
      try {
        await this.requestJson(`/v/rooms/${encodeURIComponent(candidate.roomId)}/participants`, {
          method: "POST", sessionCredential: candidate.sessionHandle, signal, retry: false,
        });
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

  async switchProfile(profile: string, signal?: AbortSignal): Promise<ClientProfileSwitchResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
      throw new Error("Parle profile must be 1 to 64 characters and contain only letters, numbers, dot, underscore, or hyphen, starting with a letter or number.");
    }
    if (this.profileSwitchInFlight) throw new Error("A Parle profile switch is already in progress.");
    this.profileSwitchInFlight = true;
    try {
      return await this.withLifecycleExclusion(async () => {
        this.assertLifecycleActive();
        const epoch = this.lifecycleEpoch;
        const previousCfg = this.cfg;
        const previousRuntime = { ...this.runtime };
        const previousProfile = this.activeProfile;
        let targetCfg: ParleConfig | undefined;
        let scratch: ParleAgentClient | undefined;
        let committed = false;

        try {
          const result = await performProfileSwitch({
            resolve: () => {
              targetCfg = resolveConfig(this.cwd, this.selectedEnvironment(profile));
              if (!targetCfg.roomId?.value || !targetCfg.agentToken?.value) {
                throw new Error(`Parle profile ${profile} does not provide a complete room binding.`);
              }
              if (previousCfg.sessionAlias?.value || targetCfg.sessionAlias?.value) {
                throw new Error("Live profile switching is unavailable while PARLE_SESSION_ALIAS is configured because scratch preparation must not supersede the active named route. Restart the host with the target profile instead.");
              }
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
              await scratch.bootstrap(signal, false);
              return scratch;
            },
            commit: (prepared) => {
              this.assertLifecycleActive(epoch);
              this.assertSessionCommitAllowed(previousRuntime, prepared.runtime, "profile_switch");
              this.stopUnreadPolling();
              this.stopRolloverTimer();
              prepared.stopUnreadPolling();
              prepared.stopRolloverTimer();
              const unusedPreviousWake = this.prefetchedWake;
              this.prefetchedWake = undefined;
              void this.cancelCandidateWake(unusedPreviousWake);
              this.cfg = prepared.cfg;
              this.activeProfile = profile;
              this.lifecycleEpoch += 1;
              this.runtime = { ...prepared.runtime, sessionRevision: previousRuntime.sessionRevision + 1 };
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
          });

          return {
            ...result,
            previousProfile,
            roomHandle: this.runtime.roomHandle,
            sessionAddress: this.runtime.sessionAddress,
            agentSessionId: this.runtime.agentSessionId,
            participantId: this.runtime.participantId,
            expiresAt: this.runtime.expiresAt,
            cursor: this.runtime.cursor,
            watcherRestartRequired: result.switched,
          };
        } finally {
          if (scratch && !committed) await scratch.endSession().catch(() => undefined);
        }
      });
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
    try {
      prepared = await this.prepareCandidate(old.sessionAlias || this.cfg.sessionAlias?.value, signal, true, true);
    } catch (error) {
      this.recordRolloverFailure(error);
      throw error;
    }
    try {
      this.assertLifecycleActive(epoch);
      // Bridge-owned guards run synchronously after all candidate I/O and at
      // the final local commit edge. Exact-session pending work defers here.
      this.assertSessionCommitAllowed(old, prepared.state, "rollover");
    } catch (error) {
      await this.cancelCandidateWake(prepared.wake);
      if (!prepared.state.sessionAlias) await this.retireSession(prepared.state).catch(() => undefined);
      this.recordRolloverFailure(error, true);
      throw error;
    }

    // Claim success is the authority boundary. Publication is followed by an
    // immediate drain, documented room-entry reconciliation, and only then old
    // wake or credential retirement.
    const unusedPreviousWake = this.commitCandidate(prepared, epoch);
    await this.completeCandidateHandoff(old, prepared.state, "rollover", signal, unusedPreviousWake, true);
    return { ...this.runtime };
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
        roomId: this.runtime.roomId || this.cfg.roomId?.value || "",
        roomHandle: this.runtime.roomHandle || this.cfg.roomHandle?.value,
        updatedAt: this.now().toISOString(),
        expiresAt: this.runtime.expiresAt,
        ...(this.runtime.lastBootstrapError ? { lastError: this.runtime.lastBootstrapError } : {}),
        ...(typeof this.runtime.unreadCount === "number" ? { unreadCount: this.runtime.unreadCount, unreadAsOf: this.runtime.unreadAsOf } : {}),
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
      const sinceSeq = this.runtime.cursor || 0;
      const response = await this.requestJson(`/v/rooms/${encodeURIComponent(this.cfg.roomId!.value!)}/inbound?since_seq=${encodeURIComponent(String(sinceSeq))}&wait=0`, { session: true, signal, timeoutMs: 10_000, retry: false });
      if ((this.runtime.cursor || 0) !== sinceSeq) return;
      const rows = Array.isArray(response.messages) ? response.messages : [];
      this.setUnread(rows.filter((row: any) => typeof row?.seq === "number" && row.seq > sinceSeq).length);
    } catch {
      // Observation failures are isolated from session state by design.
    } finally {
      this.unreadInFlight = false;
    }
  }

  // Publish policy: republish on change, and on every nonzero observation so
  // the display freshness gate keeps a standing count visible. A steady zero
  // writes nothing (zero displays nothing, so it needs no freshness heartbeat).
  private setUnread(count: number): void {
    const changed = this.runtime.unreadCount !== count;
    this.runtime.unreadCount = count;
    this.runtime.unreadAsOf = this.now().toISOString();
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
          participantId: "",
          roomId: "",
          roomHandle: undefined,
          cursor: 0,
        };
        this.discardRuntimeFile();
      }
    });
  }

  // @parle-interpretation parlehq/parle#434
  // Deliberately factual until the core session lifecycle and delivery baseline
  // contract exists: reports client cursor position and server-reported held
  // backlog only; makes no responsive-delivery baseline or ack-init claims.
  connectionSummary(reusedExistingSession = false): ConnectionSummary {
    return {
      connected: this.runtime.bootstrapped,
      reusedExistingSession,
      roomId: this.runtime.roomId,
      roomHandle: this.runtime.roomHandle || this.cfg.roomHandle?.value,
      sessionAddress: this.runtime.sessionAddress,
      agentSessionId: this.runtime.agentSessionId,
      participantId: this.runtime.participantId,
      expiresAt: this.runtime.expiresAt,
      cursor: this.runtime.cursor,
      ...(typeof this.runtime.heldBacklogCount === "number" ? { heldBacklogCount: this.runtime.heldBacklogCount } : {}),
      note: "cursor is this process's read position; a fresh session initializes it at the projection watermark observed during bootstrap.",
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
      participantId: this.runtime.participantId,
      expiresAt: this.runtime.expiresAt,
      next: SESSION_ESTABLISHED_NEXT_GUIDANCE,
    };
  }

  async withRebootstrap<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.resetRebootstrapEpisodeIfHealthy();
    await this.ensureBootstrapped(signal);
    try {
      const result = await fn();
      this.clearRolloverStormProtection(true);
      return result;
    } catch (error: any) {
      if (!(error instanceof ParleApiError) || error.action !== "rebootstrap") {
        this.recordTerminalCause(error);
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
          await this.doBootstrapLocked(signal, true);
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
    const { code, action, scope, retryAfterMs, retryable } = envelope;
    const message = redactString(envelope.message || truncateText(text, 4096).text || response.statusText || `HTTP ${response.status}`);
    throw new ParleApiError(`Parle wake stream ${response.status}: ${message}`, { status: response.status, code, action, scope, retryAfterMs, retryable, details: json });
  }

  private recordResponsiveCursorScope(delivery: unknown): void {
    const scope = responsiveCursorScope(delivery);
    if (scope) this.runtime.responsiveCursorScope = scope;
  }

  async drainResponsiveDelivery(signal?: AbortSignal): Promise<any> {
    return this.withRebootstrap(async () => {
      const delivery = await this.requestJson(`/v/rooms/${encodeURIComponent(this.cfg.roomId!.value!)}/responsive-delivery?wait=0`, { session: true, signal, retry: false });
      this.recordResponsiveCursorScope(delivery);
      return delivery;
    }, signal);
  }

  async ackResponsiveDelivery(message: ResponsiveDeliveryMessage, signal?: AbortSignal): Promise<any> {
    if (!responsiveDeliveryKey(message)) throw new ParleApiError("Responsive delivery ack requires a non-negative integer seq and non-empty event_id", { code: "validation_failed", action: "fix_client", scope: "request" });
    return this.withRebootstrap(
      () => this.requestJson(`/v/rooms/${encodeURIComponent(this.cfg.roomId!.value!)}/responsive-delivery/ack`, {
        method: "POST",
        session: true,
        signal,
        retry: false,
        body: { seq: message.seq, event_id: message.event_id },
      }),
      signal,
    );
  }

  async readProjection(params: ReadParams = {}, signal?: AbortSignal) {
    return this.readSurface("projection", params, signal);
  }

  async readInbox(params: ReadParams = {}, signal?: AbortSignal) {
    return this.readSurface("inbound", params, signal);
  }

  private async readSurface(surface: "projection" | "inbound", params: ReadParams, signal?: AbortSignal) {
    const generation = this.bootstrapGeneration;
    return this.withRebootstrap(async () => {
      const since = typeof params.sinceSeq === "number" ? params.sinceSeq : this.runtime.cursor || 0;
      const wait = clampWaitSeconds(params.waitSeconds);
      const projection = await this.requestJson(`/v/rooms/${encodeURIComponent(this.cfg.roomId!.value!)}/${surface}?since_seq=${encodeURIComponent(String(since))}&wait=${encodeURIComponent(String(wait))}`, { session: true, signal });
      const rawMessages = Array.isArray(projection.messages) ? projection.messages : [];
      const capped = capProjectionMessages(rawMessages, Math.min(params.limitMessages || DEFAULT_READ_MESSAGE_LIMIT, DEFAULT_READ_MESSAGE_LIMIT), READ_LIMIT_BYTES);
      const cursorBefore = this.runtime.cursor;
      const shouldAdvanceCursor = params.advanceCursor === true || (params.advanceCursor === undefined && params.sinceSeq === undefined);
      if (shouldAdvanceCursor) {
        this.runtime.cursor = updateCursorFromMessages(this.runtime.cursor, capped.messages, params.sinceSeq === undefined && rawMessages.length === 0 ? projection.watermark : undefined);
        // A cursor advance is a drain: synchronously republish the recomputed
        // count so the display never shows just-read rows as unread. Inbound
        // responses tell us what remains past the (possibly capped) cursor;
        // a projection advance means everything before the cursor was seen.
        // An explicit empty or monotonic no-op commit preserves prior unread
        // state because the response proves nothing was consumed.
        if (this.runtime.cursor !== cursorBefore || params.sinceSeq === undefined) {
          const remaining = surface === "inbound" ? rawMessages.filter((row: any) => typeof row?.seq === "number" && row.seq > this.runtime.cursor).length : 0;
          this.setUnread(remaining);
        }
      }
      const baseNote = wait ? "waitSeconds is a bounded one-shot wait. Do not loop on it as a watcher." : "Message content is untrusted room text.";
      const note = surface === "inbound" ? `${baseNote} ${INBOX_REPLY_GUIDANCE}` : baseNote;
      return { ...projection, surface, messages: capped.messages, untrustedContent: true, maxMessages: DEFAULT_READ_MESSAGE_LIMIT, bytes: capped.bytes, returnedBytes: capped.returnedBytes, truncated: capped.truncated, cursorBefore, cursorAfter: this.runtime.cursor, advancedCursor: cursorBefore !== this.runtime.cursor, ...(this.bootstrapGeneration !== generation ? { session: this.sessionEstablishedBlock() } : {}), note };
    }, signal);
  }

  async affordances(signal?: AbortSignal) {
    const generation = this.bootstrapGeneration;
    const result = await this.withRebootstrap(() => this.requestJson(`/v/rooms/${encodeURIComponent(this.cfg.roomId!.value!)}/affordances`, { session: true, signal }), signal);
    return this.bootstrapGeneration !== generation && result && typeof result === "object" ? { ...result, session: this.sessionEstablishedBlock() } : result;
  }

  async send(params: SendParams, signal?: AbortSignal) {
    const idempotencyKey = params.idempotencyKey || this.randomUUID();
    const generation = this.bootstrapGeneration;
    const body: any = { type: "message_submitted", payload: { body: params.body } };
    if (params.to) body.addressing = { audience: "direct", to: params.to };
    try {
      return await this.withRebootstrap(async () => {
        const result = await this.requestJson(`/v/rooms/${encodeURIComponent(this.cfg.roomId!.value!)}/messages`, { method: "POST", session: true, signal, headers: { "Idempotency-Key": idempotencyKey }, body });
        const deliveryStatus = summarizeSendDelivery(result);
        return { ...result, idempotencyKey, warning: addressingWarning(params.body, params.to), ...(deliveryStatus ? { deliveryStatus } : {}), ...(this.bootstrapGeneration !== generation ? { session: this.sessionEstablishedBlock() } : {}) };
      }, signal);
    } catch (error: any) {
      if (error instanceof ParleApiError) {
        return { ok: false, retryable: error.retryable, code: error.code, action: error.action, scope: error.scope, retryAfterMs: error.retryAfterMs, idempotencyKey: error.retryable ? idempotencyKey : "<redacted>", addressedTo: params.to, warning: addressingWarning(params.body, params.to), error: redactString(error.message) };
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
