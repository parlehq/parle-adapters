import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { CONFORMANCE_PARLE_VERSION } from "./conformance-data.js";
import { loadProfile, profileCatalogHasProfile, resolveProfileCatalogPath } from "./profiles.js";

const DEFAULT_API_BASE = "https://api.parle.sh";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_HANDOFF_BYTES = 32 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE_SECRET_RE = /^parle_inv_\S{16,256}$/;
const INVITE_CODE_RE = /^[A-Z0-9]{6,32}$/;
const RESERVED_HANDLES = new Set(["admin", "agent", "agents", "api", "me", "null", "parle", "room", "rooms", "root", "support", "system", "www"]);

export type AccountFetch = typeof fetch;

export type AccountClientOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetch?: AccountFetch;
  now?: () => Date;
};

export type MintPrincipalInviteParams = {
  roomId: string;
  principalId: string;
  principalHandle: string;
  confirmMutation?: boolean;
  reason?: string;
};

export type ClaimPrincipalInviteParams = {
  action: "preview" | "complete";
  handoffPath: string;
  confirmMutation?: boolean;
  reason?: string;
  deleteHandoffOnSuccess?: boolean;
};

type AccountConfig = {
  apiBase: string;
  version: string;
  sessionCookie: string;
  stateDir: string;
};

type PrincipalInviteHandoff = {
  schemaVersion: 1;
  kind: "parle-principal-invite";
  apiVersion: string;
  inviteId: string;
  roomId: string;
  secret: string;
  code: string;
  seatType: "principal";
  targetPrincipalId: string;
  targetHandle: string;
  offeredRights: string[];
  createdAt: string;
  expiresAt: string;
};

function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function safeFile(path: string, label: string, allowSymlink: boolean): string {
  const link = lstatSync(path);
  if (!allowSymlink && link.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  const stat = link.isSymbolicLink() ? statSync(path) : link;
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
  if (process.platform !== "win32") {
    if (stat.uid !== process.getuid?.()) throw new Error(`${label} must be owned by the current user: ${path}`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must be mode 0600: ${path}`);
  }
  return path;
}

function assertGitSafeDirectory(path: string): void {
  try {
    const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
    if (!inside) return;
    execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: path, stdio: "ignore" });
  } catch (error: any) {
    if (error?.status === 1) throw new Error(`Parle invite directory is inside a git work tree and is not ignored: ${path}`);
    // Not a work tree, or git unavailable. The owner and mode checks remain
    // authoritative; do not make git an installation dependency.
  }
}

function safeDirectory(path: string, label: string): string {
  const link = lstatSync(path);
  if (link.isSymbolicLink() || !link.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
  if (process.platform !== "win32") {
    if (link.uid !== process.getuid?.()) throw new Error(`${label} must be owned by the current user: ${path}`);
    if ((link.mode & 0o077) !== 0) throw new Error(`${label} must be mode 0700: ${path}`);
  }
  return realpathSync(path);
}

function inviteDirectory(config: AccountConfig, create: boolean): string {
  const directory = join(config.stateDir, "invites");
  if (create) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(directory, 0o700);
  } else if (!existsSync(directory)) {
    throw new Error(`Private Parle invite directory does not exist: ${directory}`);
  }
  safeDirectory(directory, "Parle invite directory");
  assertGitSafeDirectory(directory);
  return realpathSync(directory);
}

function readBounded(path: string, maxBytes: number, label: string): string {
  const stat = statSync(path);
  if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes: ${path}`);
  return readFileSync(path, "utf8");
}

function firstValue(key: string, env: Record<string, string | undefined>, dotEnv: Record<string, string>): string | undefined {
  return env[key] || dotEnv[key] || undefined;
}

function assertSafeBase(base: string, env: Record<string, string | undefined>): string {
  const url = new URL(base);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (local && env.PARLE_ALLOW_INSECURE_LOCAL === "1") return url.origin;
  if (url.protocol !== "https:") throw new Error(`Parle API base must use https: ${url.origin}`);
  if (url.username || url.password) throw new Error("Parle API base must not contain credentials.");
  return url.origin;
}

function resolveAccountConfig(cwd: string, env: Record<string, string | undefined>): AccountConfig {
  const dotEnvPath = join(cwd, ".env");
  const dotEnv = existsSync(dotEnvPath) ? parseDotEnv(readBounded(dotEnvPath, MAX_HANDOFF_BYTES, "Parle project environment")) : {};
  const profilesOverride = firstValue("PARLE_PROFILES_PATH", env, dotEnv);
  const catalogPath = resolveProfileCatalogPath(profilesOverride, cwd, env);
  const sessionPath = join(dirname(catalogPath), "session");
  let sessionCookie = firstValue("PARLE_SESSION_COOKIE", env, dotEnv);
  if (!sessionCookie && existsSync(sessionPath)) {
    safeFile(sessionPath, "Parle human session file", true);
    sessionCookie = readBounded(sessionPath, 8192, "Parle human session file").trim();
  }
  if (!sessionCookie) throw new Error(`Parle human session is not configured. Run parle_login complete or mint-from-session so ${sessionPath} exists.`);
  if (/\r|\n/.test(sessionCookie)) throw new Error("Parle human session cookie contains invalid control characters.");
  let configuredApiBase = firstValue("PARLE_API_BASE", env, dotEnv);
  if (!configuredApiBase && existsSync(catalogPath)) {
    const selectedProfile = firstValue("PARLE_PROFILE", env, dotEnv) || (profileCatalogHasProfile("default", catalogPath) ? "default" : undefined);
    if (selectedProfile) configuredApiBase = loadProfile(selectedProfile, catalogPath).apiBase;
  }
  const apiBase = assertSafeBase(configuredApiBase || DEFAULT_API_BASE, env);
  const version = env.PARLE_VERSION || CONFORMANCE_PARLE_VERSION;
  return { apiBase, version, sessionCookie, stateDir: dirname(catalogPath) };
}

function validateUUID(raw: string, label: string): string {
  const value = raw.trim().toLowerCase();
  if (!UUID_RE.test(value) || value === "00000000-0000-0000-0000-000000000000") throw new Error(`${label} must be a non-zero UUID.`);
  return value;
}

function validateHandle(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,18}[a-z0-9]$/.test(value) || /-{2}/.test(value) || RESERVED_HANDLES.has(value)) {
    throw new Error("principalHandle must normalize to an unreserved 2-20 character handle using lowercase letters, digits, and hyphens with no leading, trailing, or consecutive hyphens.");
  }
  return value;
}

function scrub(value: string, secrets: string[]): string {
  let safe = value;
  for (const secret of secrets) if (secret) safe = safe.split(secret).join("<redacted>");
  safe = safe.replace(/parle_(?:inv|ses|agt)_[A-Za-z0-9._~-]+/g, "<redacted>");
  return safe;
}

function parseJson(text: string): any {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizeTargetDisplay(raw: any): { handle: string } {
  const display = raw && typeof raw === "object" ? raw : {};
  return { handle: typeof display.handle === "string" ? display.handle : "" };
}

function optionalUUID(raw: unknown): string | undefined {
  try {
    return validateUUID(String(raw || ""), "response UUID");
  } catch {
    return undefined;
  }
}

function assertStringArray(raw: any, label: string): string[] {
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) throw new Error(`Parle response ${label} is invalid.`);
  return raw;
}

export class ParleAccountClient {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly fetchImpl: AccountFetch;
  readonly now: () => Date;

  constructor(options: AccountClientOptions = {}) {
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || process.env;
    this.fetchImpl = options.fetch || fetch;
    this.now = options.now || (() => new Date());
  }

  private config(): AccountConfig {
    return resolveAccountConfig(this.cwd, this.env);
  }

  private async request(config: AccountConfig, path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; secrets?: string[] } = {}): Promise<any> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Parle-Version": config.version,
      Cookie: config.sessionCookie,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await this.fetchImpl(new URL(path, config.apiBase), { method: options.method || "GET", headers, body, signal: options.signal });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error(`Parle API response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
    const text = buffer.toString("utf8");
    const json = parseJson(text);
    if (!response.ok) {
      const error = json?.error && typeof json.error === "object" ? json.error : {};
      const message = scrub(String(error.message || text || response.statusText), [config.sessionCookie, ...(options.secrets || [])]).slice(0, 4096);
      const raised: any = new Error(`Parle API ${response.status}: ${message}`);
      raised.status = response.status;
      raised.code = typeof error.code === "string" ? error.code : undefined;
      throw raised;
    }
    if (!json || typeof json !== "object") throw new Error("Parle API returned an invalid JSON response.");
    return json;
  }

  async mintPrincipalInvite(params: MintPrincipalInviteParams, signal?: AbortSignal) {
    if (params.confirmMutation !== true || !params.reason?.trim()) throw new Error("parle_mint_principal_invite requires confirmMutation=true and a reason.");
    const roomId = validateUUID(params.roomId, "roomId");
    const principalId = validateUUID(params.principalId, "principalId");
    const principalHandle = validateHandle(params.principalHandle);
    const config = this.config();
    const directory = inviteDirectory(config, true);
    const probe = join(directory, `.write-test.${process.pid}.${Date.now()}`);
    try {
      writeFileSync(probe, "ok\n", { mode: 0o600, flag: "wx" });
    } finally {
      try { if (existsSync(probe)) unlinkSync(probe); } catch {}
    }
    const response = await this.request(config, `/v/rooms/${encodeURIComponent(roomId)}/invites`, {
      method: "POST",
      body: { seat_type: "principal", target: { kind: "principal", principal_id: principalId } },
      signal,
    });
    const inviteId = validateUUID(String(response.invite_id || ""), "response invite_id");
    const responseRoomId = validateUUID(String(response.room_id || ""), "response room_id");
    const targetPrincipalId = validateUUID(String(response.target_principal_id || ""), "response target_principal_id");
    const secret = String(response.secret || "");
    const code = String(response.code || "");
    if (responseRoomId !== roomId || targetPrincipalId !== principalId || response.seat_type !== "principal") throw new Error("Parle invite response did not match the requested immutable principal admission.");
    if (!INVITE_SECRET_RE.test(secret) || !INVITE_CODE_RE.test(code)) throw new Error("Parle invite response did not contain a valid one-time capability.");
    const offeredRights = assertStringArray(response.offered_rights, "offered_rights");
    if (offeredRights.length !== 0) throw new Error("Parle invite response unexpectedly offered elevated room rights.");
    const ttlSeconds = Number(response.ttl_seconds);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 7 * 24 * 60 * 60) throw new Error("Parle invite response ttl_seconds is invalid.");
    const display = normalizeTargetDisplay(response.target_display);
    const resolvedHandle = validateHandle(display.handle);
    if (resolvedHandle !== principalHandle) throw new Error("Parle invite response target handle did not match the requested confirmation label.");
    const createdAt = this.now();
    const handoff: PrincipalInviteHandoff = {
      schemaVersion: 1,
      kind: "parle-principal-invite",
      apiVersion: config.version,
      inviteId,
      roomId,
      secret,
      code,
      seatType: "principal",
      targetPrincipalId,
      targetHandle: resolvedHandle,
      offeredRights: [],
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlSeconds * 1000).toISOString(),
    };
    const handoffPath = join(directory, `${inviteId}.json`);
    if (existsSync(handoffPath)) throw new Error(`Parle invite handoff already exists: ${handoffPath}`);
    const temporary = join(directory, `.invite.${process.pid}.${Date.now()}.tmp`);
    let published = false;
    try {
      writeFileSync(temporary, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      if (process.platform !== "win32") chmodSync(temporary, 0o600);
      // Same-directory hard-link publication gives atomic no-replace behavior:
      // an attacker-planted or raced final path fails instead of being followed
      // or silently overwritten.
      linkSync(temporary, handoffPath);
      published = true;
    } catch (error) {
      if (!published) {
        try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
      }
      throw error;
    } finally {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    }
    return {
      inviteId,
      roomId,
      seatType: "principal",
      targetPrincipalId,
      targetHandle: handoff.targetHandle,
      offeredRights: [],
      expiresAt: handoff.expiresAt,
      handoffPath,
      sensitive: true,
      next: "Transfer the private 0600 handoff file to the intended principal through a secure out-of-band channel. Do not read or paste its contents into chat, logs, or tool parameters.",
    };
  }

  private readHandoff(path: string, config: AccountConfig): PrincipalInviteHandoff {
    if (!isAbsolute(path)) throw new Error("handoffPath must be an absolute path.");
    const directory = inviteDirectory(config, false);
    if (!existsSync(path)) throw new Error(`Parle invite handoff does not exist in the private invite directory: ${path}`);
    safeFile(path, "Parle invite handoff", false);
    if (realpathSync(dirname(path)) !== directory || dirname(realpathSync(path)) !== directory) throw new Error("handoffPath must resolve directly inside the private Parle invite directory.");
    if (!UUID_RE.test(basename(path, ".json")) || !path.endsWith(".json")) throw new Error("Parle invite handoff filename must be <invite-id>.json.");
    const parsed = parseJson(readBounded(path, MAX_HANDOFF_BYTES, "Parle invite handoff"));
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1 || parsed.kind !== "parle-principal-invite") throw new Error("Parle invite handoff schema is invalid.");
    const handoff: PrincipalInviteHandoff = {
      schemaVersion: 1,
      kind: "parle-principal-invite",
      apiVersion: String(parsed.apiVersion || ""),
      inviteId: validateUUID(String(parsed.inviteId || ""), "handoff inviteId"),
      roomId: validateUUID(String(parsed.roomId || ""), "handoff roomId"),
      secret: String(parsed.secret || ""),
      code: String(parsed.code || ""),
      seatType: parsed.seatType,
      targetPrincipalId: validateUUID(String(parsed.targetPrincipalId || ""), "handoff targetPrincipalId"),
      targetHandle: validateHandle(String(parsed.targetHandle || "")),
      offeredRights: assertStringArray(parsed.offeredRights, "handoff offeredRights"),
      createdAt: String(parsed.createdAt || ""),
      expiresAt: String(parsed.expiresAt || ""),
    };
    if (handoff.apiVersion !== config.version || handoff.seatType !== "principal" || handoff.offeredRights.length !== 0 || !INVITE_SECRET_RE.test(handoff.secret) || !INVITE_CODE_RE.test(handoff.code) || basename(path) !== `${handoff.inviteId}.json`) {
      throw new Error("Parle invite handoff terms are invalid or incompatible with this adapter.");
    }
    if (!Number.isFinite(Date.parse(handoff.createdAt)) || !Number.isFinite(Date.parse(handoff.expiresAt))) throw new Error("Parle invite handoff timestamps are invalid.");
    return handoff;
  }

  async claimPrincipalInvite(params: ClaimPrincipalInviteParams, signal?: AbortSignal) {
    if (params.action !== "preview" && params.action !== "complete") throw new Error('parle_claim_principal_invite action must be "preview" or "complete".');
    if (params.action === "complete" && (params.confirmMutation !== true || !params.reason?.trim())) throw new Error("parle_claim_principal_invite complete requires confirmMutation=true and a reason.");
    const config = this.config();
    const handoff = this.readHandoff(params.handoffPath, config);
    const response = await this.request(config, `/v/claim/${params.action}`, {
      method: "POST",
      body: { secret: handoff.secret, code: handoff.code },
      signal,
      secrets: [handoff.secret, handoff.code],
    });
    if (params.action === "preview") {
      const roomId = validateUUID(String(response.room_id || ""), "preview room_id");
      const offeredRights = assertStringArray(response.offered_rights, "preview offered_rights");
      if (roomId !== handoff.roomId || response.seat_type !== "principal" || offeredRights.length !== 0) throw new Error("Parle claim preview did not match the private handoff terms.");
      return {
        action: "preview",
        inviteId: handoff.inviteId,
        roomId,
        seatType: "principal",
        targetPrincipalId: handoff.targetPrincipalId,
        targetHandle: handoff.targetHandle,
        offeredRights,
        expiresAt: response.expires_at,
        historyVisible: response.history_visible === true,
        assurance: typeof response.assurance === "string" ? response.assurance : undefined,
        facts: Array.isArray(response.facts) ? response.facts : [],
        handoffPath: params.handoffPath,
        next: "Review these server-authored admission terms with the intended principal. Complete the claim only after explicit approval.",
      };
    }
    // A successful HTTP response is the consumption boundary. Do not report
    // failure or retain a now-spent capability merely because a newer or
    // degraded server omitted advisory response fields. Return only validated
    // optional facts and attach redaction-safe warnings for shape drift.
    const warnings: string[] = [];
    const responseRoomId = optionalUUID(response.room_id);
    const seatId = optionalUUID(response.seat_id);
    const participantId = optionalUUID(response.participant_id);
    if (responseRoomId !== handoff.roomId) warnings.push("Parle claim succeeded, but the response room identifier was missing or did not match the handoff.");
    if (!seatId) warnings.push("Parle claim succeeded without a valid seat identifier in the response.");
    if (!participantId) warnings.push("Parle claim succeeded without a valid participant identifier in the response.");
    if (response.state !== "seated") warnings.push("Parle claim succeeded without the expected seated state label in the response.");
    const deleteHandoff = params.deleteHandoffOnSuccess !== false;
    let handoffDeleted = false;
    let cleanupWarning: string | undefined;
    if (deleteHandoff) {
      try {
        unlinkSync(params.handoffPath);
        handoffDeleted = true;
      } catch {
        cleanupWarning = `Claim succeeded, but the private handoff could not be deleted. Remove it manually: ${params.handoffPath}`;
      }
    }
    return {
      action: "complete",
      inviteId: handoff.inviteId,
      roomId: handoff.roomId,
      ...(seatId ? { seatId } : {}),
      ...(participantId ? { participantId } : {}),
      state: response.state === "seated" ? "seated" : "completed",
      targetPrincipalId: handoff.targetPrincipalId,
      targetHandle: handoff.targetHandle,
      handoffDeleted,
      ...(warnings.length ? { warnings } : {}),
      ...(cleanupWarning ? { cleanupWarning } : {}),
      next: "The principal now holds an ordinary direct seat. Agent seating and room-bound agent credentials are separate follow-up actions.",
    };
  }
}
