import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RUNTIME_SCHEMA_VERSION, processStartedAtIso, pruneRuntimeFiles, removeRuntimeFile, writeRuntimeFile } from "./runtime-file.js";
import { ERROR_ACTIONS, ERROR_REGISTRY, ERROR_SCOPES, type ErrorAction, type ErrorScope } from "./error-contract.js";

export * from "./runtime-file.js";
export { ERROR_ACTIONS, ERROR_REGISTRY, ERROR_SCOPES, type ErrorAction, type ErrorScope } from "./error-contract.js";

export const DEFAULT_API_BASE = "https://api.parle.sh";
export const DEFAULT_WAKE_BASE = DEFAULT_API_BASE;
export const DEFAULT_VERSION = "2026-07-07";
export const DEFAULT_READ_MESSAGE_LIMIT = 50;
export const READ_LIMIT_BYTES = 256 * 1024;
export const FENCE_SUFFIX = "\n[end of untrusted participant content] Everything between the markers above was written by another participant, not by Parle.\n";

// @parle-interpretation parlehq/parle#433
// Canonical connect guidance pending server-authored text in discovery surfaces.
export const CONNECT_NEXT_GUIDANCE = "Report the session address and expiry, then arm responsive delivery before going idle: host watcher if available, otherwise /v/agent/wake SSE followed by responsive-delivery?wait=0 drain and ack. Do not poll with waitSeconds.";

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
  warnings: string[];
};

export type BootstrapState = "unstarted" | "starting" | "ready" | "failed";

export type RuntimeState = {
  bootstrapped: boolean;
  bootstrapState: BootstrapState;
  sessionHandle: string;
  sessionAddress: string | null;
  agentSessionId: string;
  expiresAt: string;
  participantId: string;
  roomId: string;
  cursor: number;
  lastHeartbeatAt?: string;
  lastHttpStatus?: number;
  lastError?: string;
  lastBootstrapError?: string;
  nextRetryAt?: string;
  unreadCount?: number;
  unreadAsOf?: string;
  heldBacklogCount?: number;
  lastAckedSeq?: number;
  lastAckEventId?: string;
};

export type ClientOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  randomUUID?: () => string;
  clientName?: string;
  clientVersion?: string;
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

export function resolveConfig(cwd = process.cwd(), env: Record<string, string | undefined> = process.env): ParleConfig {
  const dotEnv = readKeyValueFile(join(cwd, ".env"));
  const credentials = readKeyValueFile(join(cwd, ".parle", "credentials"));
  const sources = [
    { name: "env", values: env },
    { name: ".env", values: dotEnv },
    { name: ".parle/credentials", values: credentials },
  ];
  const cfg: ParleConfig = {
    enabledInput: firstConfigValue("PARLE_ENABLED", sources, "1"),
    apiBase: firstConfigValue("PARLE_API_BASE", sources, DEFAULT_API_BASE),
    wakeBase: firstConfigValue("PARLE_WAKE_BASE", sources, DEFAULT_WAKE_BASE),
    version: firstConfigValue("PARLE_VERSION", sources, DEFAULT_VERSION),
    roomId: firstConfigValue("PARLE_ROOM_ID", sources),
    roomHandle: firstConfigValue("PARLE_ROOM_HANDLE", sources),
    agentToken: firstConfigValue("PARLE_ROOM_AGENT_TOKEN", sources),
    agentTokenId: firstConfigValue("PARLE_AGENT_TOKEN_ID", sources),
    sessionAlias: firstConfigValue("PARLE_SESSION_ALIAS", sources),
    watchEnabled: firstConfigValue("PARLE_WATCH_ENABLED", sources, "1"),
    unreadPollIntervalSeconds: firstConfigValue("PARLE_UNREAD_POLL_INTERVAL_SECONDS", sources, "60"),
    warnings: [],
  };
  for (const value of [cfg.apiBase, cfg.wakeBase, cfg.version, cfg.roomId, cfg.roomHandle, cfg.agentToken, cfg.agentTokenId, cfg.sessionAlias, cfg.watchEnabled]) {
    if (value?.warning) cfg.warnings.push(value.warning);
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

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.trunc(seconds * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function parseEnvelopeRetryAfterMs(errorObj: any, response: Response): number | undefined {
  if (typeof errorObj?.retry_after_ms === "number" && Number.isFinite(errorObj.retry_after_ms) && errorObj.retry_after_ms >= 0) return Math.trunc(errorObj.retry_after_ms);
  if (typeof errorObj?.retry_after_seconds === "number" && Number.isFinite(errorObj.retry_after_seconds) && errorObj.retry_after_seconds >= 0) return Math.trunc(errorObj.retry_after_seconds * 1000);
  return parseRetryAfterMs(response.headers.get("retry-after"));
}

function asErrorAction(value: unknown): ErrorAction | undefined {
  return typeof value === "string" && (ERROR_ACTIONS as readonly string[]).includes(value) ? value as ErrorAction : undefined;
}

function asErrorScope(value: unknown): ErrorScope | undefined {
  return typeof value === "string" && (ERROR_SCOPES as readonly string[]).includes(value) ? value as ErrorScope : undefined;
}

function defaultActionForStatus(status: number): ErrorAction {
  if (status === 401) return "reauthorize";
  if (status === 429) return "backoff";
  if (status >= 500) return "retry_with_backoff";
  return "stop";
}

function defaultScopeForStatus(status: number): ErrorScope {
  if (status === 401) return "agent_token";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "request";
}

function actionRetryable(action: ErrorAction): boolean {
  return action === "retry" || action === "retry_with_backoff" || action === "backoff";
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
      return "Parle stopped: agent session is dead; reconnect with parle_connect and re-arm.";
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

export function redactString(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9_./+=:-]+/g, "Bearer <redacted>")
    .replace(/(__Host-parle_session=)[^;\s]+/g, "$1<redacted>")
    .replace(/(parle_(?:agt|inv|ses)_[A-Za-z0-9_./+=:-]+)/g, "<redacted-token>")
    .replace(/\bprt_[A-Za-z0-9_./+=:-]+/g, "prt_<redacted>")
    .replace(/(Idempotency-Key\s*[:=]\s*)[A-Za-z0-9._:-]+/gi, "$1<redacted>")
    .replace(/(Parle-Agent-Session\s*[:=]\s*)[A-Za-z0-9._:-]+/gi, "$1<redacted>");
}

export function redactedValue(value?: ConfigValue): { source: string; configured: boolean; value?: string } {
  if (!value?.value) return { source: value?.source || "missing", configured: false };
  const sensitiveShape = /parle_agt_|parle_ses_|prt_|__Host-parle_session/.test(value.value);
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

// @parle-interpretation parlehq/parle-agent-adapters#13
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
  readonly cfg: ParleConfig;
  readonly cwd: string;
  readonly fetchImpl: FetchLike;
  readonly env: Record<string, string | undefined>;
  readonly now: () => Date;
  readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly randomUUID: () => string;
  readonly clientName: string;
  readonly clientVersion?: string;
  readonly publishRuntime?: { adapterName: string; adapterVersion?: string };
  runtime: RuntimeState = {
    bootstrapped: false,
    bootstrapState: "unstarted",
    sessionHandle: "",
    sessionAddress: null,
    agentSessionId: "",
    expiresAt: "",
    participantId: "",
    roomId: "",
    cursor: 0,
  };
  private bootstrapGeneration = 0;
  private bootstrapInFlight: Promise<RuntimeState> | null = null;
  private rebootstrapEpisode: { failedSessionHandle: string; attempted: boolean; healthySinceMs?: number; terminal?: boolean } | null = null;
  private consecutiveBootstrapFailures = 0;
  private unreadInFlight = false;
  private unreadPollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ClientOptions = {}) {
    this.env = options.env || process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.cfg = resolveConfig(this.cwd, this.env);
    this.fetchImpl = options.fetch || fetch;
    this.now = options.now || (() => new Date());
    this.sleepImpl = options.sleep || defaultSleep;
    this.randomUUID = options.randomUUID || randomUUID;
    this.publishRuntime = options.publishRuntime;
    this.clientName = options.clientName || options.publishRuntime?.adapterName || "@parlehq/agent-client";
    this.clientVersion = options.clientVersion || options.publishRuntime?.adapterVersion;
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
      ? "Set missing configuration in env, .env, or .parle/credentials (checked in that order; values load once at process start)."
      : this.runtime.bootstrapped
        ? "Parle configuration is present and this process holds a session."
        : "Parle configuration is present. Not yet connected in this process; a connect, read, or send call establishes the session.";
    const staleToken = this.staleTokenHint();
    return { ok: missing.length === 0 && !staleToken, missing, connected: this.runtime.bootstrapped, apiBase: this.cfg.apiBase.value, note, ...(staleToken ? { warning: staleToken } : {}) };
  }

  // Config is resolved once at construction; a token rotated on disk afterwards
  // cannot take effect until the host process restarts. Compare against the first
  // disk source that defines the key (mirrors firstConfigValue precedence).
  staleTokenHint(): string | undefined {
    const current = this.cfg.agentToken?.value;
    if (!current) return undefined;
    for (const rel of [".env", join(".parle", "credentials")]) {
      try {
        const onDisk = readKeyValueFile(join(this.cwd, rel))["PARLE_ROOM_AGENT_TOKEN"];
        if (onDisk === undefined || onDisk === "") continue;
        if (onDisk === current) return undefined;
        return `PARLE_ROOM_AGENT_TOKEN in ${rel} differs from the value this process loaded at startup (source: ${this.cfg.agentToken?.source}). The token was likely rotated. Restart the host process (agent session or MCP server) to reload configuration.`;
      } catch {
        return undefined;
      }
    }
    return undefined;
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
        if (!(error instanceof ParleApiError) || !retryableRequest || !error.retryable || attempt >= REQUEST_RETRY_ATTEMPTS) throw error;
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
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Parle-Version": this.cfg.version.value || DEFAULT_VERSION,
      "Parle-Client-Name": this.clientName,
      ...(this.clientVersion ? { "Parle-Client-Version": this.clientVersion } : {}),
      ...options.headers,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.authMode === "human_session") throw new ParleApiError("human_session auth is not implemented in @parlehq/agent-client yet", { code: "not_implemented" });
    if (options.authMode !== "none") {
      if (!this.cfg.agentToken?.value) throw new ParleApiError("Parle setup needed: PARLE_ROOM_AGENT_TOKEN is missing", { code: "setup_needed" });
      headers.Authorization = `Bearer ${this.cfg.agentToken.value}`;
    }
    if (options.session && this.runtime.sessionHandle) headers["Parle-Agent-Session"] = this.runtime.sessionHandle;
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
      const errorObj = redactedJson?.error && typeof redactedJson.error === "object" ? redactedJson.error : {};
      const code = typeof errorObj.code === "string" ? errorObj.code : undefined;
      const registry = code ? ERROR_REGISTRY[code] : undefined;
      const action = asErrorAction(errorObj.action) || registry?.action || defaultActionForStatus(response.status);
      const scope = asErrorScope(errorObj.scope) || registry?.scope || defaultScopeForStatus(response.status);
      const retryAfterMs = parseEnvelopeRetryAfterMs(errorObj, response);
      const retryable = typeof errorObj.retryable === "boolean" ? errorObj.retryable : actionRetryable(action);
      const msg = redactString(errorObj.message || truncateText(text, 4096).text || response.statusText || `HTTP ${response.status}`);
      let message = `Parle API ${response.status}: ${msg}`;
      if (response.status === 401 && action === "reauthorize") {
        const hint = this.staleTokenHint();
        if (hint) message += ` ${hint}`;
      }
      throw new ParleApiError(message, { status: response.status, code, action, scope, retryAfterMs, retryable, details: redactedJson });
    }
    return json;
  }

  // Single-flight: concurrent callers (eager startup, racing first tool call,
  // 401 rebootstrap) converge on one in-flight session mint instead of minting
  // duplicates with last-writer-wins runtime state.
  async bootstrap(signal?: AbortSignal, preserveCursor = false): Promise<RuntimeState> {
    if (this.bootstrapInFlight) return this.bootstrapInFlight;
    const run = this.doBootstrap(signal, preserveCursor);
    this.bootstrapInFlight = run;
    try {
      return await run;
    } finally {
      this.bootstrapInFlight = null;
    }
  }

  private async doBootstrap(signal?: AbortSignal, preserveCursor = false): Promise<RuntimeState> {
    this.runtime.bootstrapState = "starting";
    this.publishRuntimeState();
    try {
      this.assertConfigured();
      const previousCursor = this.runtime.cursor;
      const body: Record<string, string> = {};
      if (this.cfg.sessionAlias?.value) body.alias = this.cfg.sessionAlias.value;
      // rawResponse: session_credential is a parle_ses_ secret; the default
      // redacted parse would replace it with <redacted-token> and every
      // subsequent Parle-Agent-Session presentation would 401.
      const session = await this.requestJson("/v/agent/sessions", { method: "POST", body, signal, rawResponse: true });
      this.runtime.sessionHandle = String(session.session_credential || "");
      this.runtime.sessionAddress = typeof session.address === "string" ? session.address : null;
      this.runtime.agentSessionId = String(session.agent_session_id || "");
      this.runtime.expiresAt = String(session.expires_at || "");
      this.runtime.roomId = this.cfg.roomId!.value!;
      const entry = await this.requestJson(`/v/rooms/${encodeURIComponent(this.cfg.roomId!.value!)}/participants`, { method: "POST", session: true, signal });
      this.runtime.participantId = String(entry.participant_id || "");
      this.runtime.bootstrapped = true;
      if (preserveCursor) this.runtime.cursor = previousCursor;
      else {
        const projection = await this.requestJson(`/v/rooms/${encodeURIComponent(this.cfg.roomId!.value!)}/projection?wait=0`, { session: true, signal });
        this.runtime.cursor = typeof projection.watermark === "number" ? projection.watermark : 0;
        if (typeof projection?.held_backlog?.held_count === "number") this.runtime.heldBacklogCount = projection.held_backlog.held_count;
      }
      this.bootstrapGeneration += 1;
      this.runtime.bootstrapState = "ready";
      this.runtime.lastBootstrapError = undefined;
      this.runtime.nextRetryAt = undefined;
      this.consecutiveBootstrapFailures = 0;
      this.publishRuntimeState();
      this.scheduleUnreadPoll();
      return { ...this.runtime };
    } catch (error: any) {
      this.consecutiveBootstrapFailures += 1;
      const backoffMs = Math.min(60_000, 5_000 * 2 ** (this.consecutiveBootstrapFailures - 1));
      this.runtime.bootstrapState = "failed";
      this.runtime.lastBootstrapError = redactString(error instanceof Error ? error.message : String(error));
      this.runtime.nextRetryAt = new Date(this.now().getTime() + backoffMs).toISOString();
      this.publishRuntimeState();
      throw error;
    }
  }

  async ensureBootstrapped(signal?: AbortSignal) {
    if (!this.runtime.bootstrapped || !this.runtime.sessionHandle) await this.bootstrap(signal);
  }

  private sessionExpired(): boolean {
    const expiry = this.runtime.expiresAt ? new Date(this.runtime.expiresAt) : null;
    return expiry !== null && !Number.isNaN(expiry.getTime()) && expiry <= this.now();
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
    if (this.runtime.bootstrapped && this.runtime.sessionHandle && !this.sessionExpired()) return false;
    if (!this.cfg.roomId?.value || !this.cfg.agentToken?.value) return false;
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
        state: this.runtime.bootstrapState === "ready" ? "ready" : this.runtime.bootstrapState === "failed" ? "failed" : "starting",
        sessionAddress: this.runtime.sessionAddress,
        // agent_session_id is room-visible operational metadata, not a credential
        // (parlehq/parle#435); session_credential never leaves process memory.
        agentSessionId: this.runtime.agentSessionId,
        roomId: this.runtime.roomId || this.cfg.roomId?.value || "",
        roomHandle: this.cfg.roomHandle?.value,
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
    this.stopUnreadPolling();
    const { agentSessionId, sessionHandle } = this.runtime;
    try {
      if (agentSessionId && sessionHandle) {
        await this.requestJson(`/v/agent/sessions/${encodeURIComponent(agentSessionId)}/end`, { method: "POST", session: true, signal, timeoutMs: 2000 });
      }
    } finally {
      this.runtime = {
        bootstrapped: false,
        bootstrapState: "unstarted",
        sessionHandle: "",
        sessionAddress: null,
        agentSessionId: "",
        expiresAt: "",
        participantId: "",
        roomId: "",
        cursor: 0,
      };
      this.discardRuntimeFile();
    }
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
      roomHandle: this.cfg.roomHandle?.value,
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
    return this.connectionSummary(reused);
  }

  private sessionEstablishedBlock(): SessionEstablishedBlock {
    return {
      established: "this_call",
      sessionAddress: this.runtime.sessionAddress,
      agentSessionId: this.runtime.agentSessionId,
      participantId: this.runtime.participantId,
      expiresAt: this.runtime.expiresAt,
      next: CONNECT_NEXT_GUIDANCE,
    };
  }

  async withRebootstrap<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.resetRebootstrapEpisodeIfHealthy();
    await this.ensureBootstrapped(signal);
    try {
      return await fn();
    } catch (error: any) {
      if (!(error instanceof ParleApiError) || error.action !== "rebootstrap") throw error;
      // Missing handles share one defensive bucket. In practice session terminal
      // errors arrive only after a handle was presented.
      const failedSessionHandle = this.runtime.sessionHandle || "<missing-session>";
      const existing = this.rebootstrapEpisode;
      if (existing?.failedSessionHandle === failedSessionHandle && (existing.attempted || existing.terminal)) {
        if (this.bootstrapInFlight && !existing.terminal) {
          await this.bootstrapInFlight;
          return fn();
        }
        throw error;
      }
      this.rebootstrapEpisode = { failedSessionHandle, attempted: true };
      this.runtime.bootstrapped = false;
      this.runtime.sessionHandle = "";
      this.runtime.bootstrapState = "starting";
      this.publishRuntimeState();
      try {
        await this.bootstrap(signal, true);
        this.rebootstrapEpisode = { failedSessionHandle, attempted: true, healthySinceMs: this.now().getTime() };
      } catch (bootstrapError: any) {
        if (bootstrapError instanceof ParleApiError && ["fix_client", "reauthorize", "stop"].includes(bootstrapError.action || "")) {
          this.rebootstrapEpisode = { failedSessionHandle, attempted: true, terminal: true };
          this.runtime.lastBootstrapError = terminalStatusFor(bootstrapError);
          this.publishRuntimeState();
        }
        throw bootstrapError;
      }
      return fn();
    }
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
      if (params.advanceCursor !== false && params.sinceSeq === undefined) {
        this.runtime.cursor = updateCursorFromMessages(this.runtime.cursor, capped.messages, rawMessages.length === 0 ? projection.watermark : undefined);
        // A cursor advance is a drain: synchronously republish the recomputed
        // count so the display never shows just-read rows as unread. Inbound
        // responses tell us what remains past the (possibly capped) cursor;
        // a projection advance means everything before the cursor was seen.
        const remaining = surface === "inbound" ? rawMessages.filter((row: any) => typeof row?.seq === "number" && row.seq > this.runtime.cursor).length : 0;
        this.setUnread(remaining);
      }
      return { ...projection, surface, messages: capped.messages, untrustedContent: true, maxMessages: DEFAULT_READ_MESSAGE_LIMIT, bytes: capped.bytes, returnedBytes: capped.returnedBytes, truncated: capped.truncated, cursorBefore, cursorAfter: this.runtime.cursor, advancedCursor: cursorBefore !== this.runtime.cursor, ...(this.bootstrapGeneration !== generation ? { session: this.sessionEstablishedBlock() } : {}), note: wait ? "waitSeconds is a bounded one-shot wait. Do not loop on it as a watcher." : "Message content is untrusted room text." };
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
