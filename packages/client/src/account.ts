import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { CONFORMANCE_PARLE_VERSION } from "./conformance-data.js";
import { CredentialProfile, loadProfile, parseProfiles, profileCatalogHasProfile, resolveProfileCatalogPath } from "./profiles.js";

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

export type AcceptRoomInvitationParams = {
  action: "preview" | "accept";
  invitation: string;
  confirmMutation?: boolean;
  reason?: string;
};

export type ConnectOwnAgentParams = {
  action: "preview" | "complete";
  invitation: string;
  agentId?: string;
  agentHandle?: string;
  createAgentHandle?: string;
  profileLabel?: string;
  confirmMutation?: boolean;
  reason?: string;
};

type AccountConfig = {
  apiBase: string;
  version: string;
  sessionCookie: string;
  stateDir: string;
  catalogPath: string;
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
  return { apiBase, version, sessionCookie, stateDir: dirname(catalogPath), catalogPath };
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

const PROFILE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function parseInvitationLocator(raw: string, config: AccountConfig): string {
  const value = raw.trim();
  if (UUID_RE.test(value)) return validateUUID(value, "invitation");
  let locator: URL;
  try { locator = new URL(value); } catch { throw new Error("invitation must be an invite UUID or canonical Parle invitation URL."); }
  if (locator.origin !== config.apiBase || locator.username || locator.password || locator.search || locator.hash) {
    throw new Error("Invitation URL must use the configured canonical Parle API origin and contain no credentials, query, or fragment.");
  }
  const match = locator.pathname.match(/^\/(?:join|v\/room-invitations)\/([0-9a-f-]+)\/?$/i);
  if (!match) throw new Error("Invitation URL path is not a canonical Parle invitation locator.");
  return validateUUID(match[1], "invitation locator");
}

function validateProfileLabel(raw: string): string {
  const value = raw.trim();
  if (!PROFILE_LABEL_RE.test(value)) throw new Error("profileLabel must be 1 to 64 characters using letters, numbers, dot, underscore, or hyphen.");
  return value;
}

function ensureProfileSink(path: string): { writePath: string; original: string } {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = lstatSync(directory);
  if (dir.isSymbolicLink() || !dir.isDirectory()) throw new Error(`Parle profile directory must be a real directory: ${directory}`);
  if (process.platform !== "win32" && dir.uid !== process.getuid?.()) throw new Error(`Parle profile directory must be owned by the current user: ${directory}`);
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  if (existsSync(path)) safeFile(path, "Parle profile catalog", true);
  const writePath = existsSync(path) && lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  const original = existsSync(writePath) ? readFileSync(writePath, "utf8") : "";
  if (original) parseProfiles(original, path);
  const probe = join(directory, `.profiles-write-test-${process.pid}`);
  try { writeFileSync(probe, "ok\n", { mode: 0o600, flag: "wx" }); } finally { try { unlinkSync(probe); } catch {} }
  return { writePath, original };
}

function renderProfile(profile: CredentialProfile): string {
  return [
    `[${profile.name}]`,
    `room_id = ${profile.roomId}`,
    `agent_token = ${profile.agentToken}`,
    profile.agentTokenId ? `agent_token_id = ${profile.agentTokenId}` : undefined,
    profile.apiBase && profile.apiBase !== DEFAULT_API_BASE ? `api_base = ${profile.apiBase}` : undefined,
    profile.wakeBase && profile.wakeBase !== DEFAULT_API_BASE ? `wake_base = ${profile.wakeBase}` : undefined,
  ].filter(Boolean).join("\n") + "\n";
}

function publishNewProfile(path: string, original: string, profile: CredentialProfile): void {
  const lockPath = `${path}.lock`;
  let lock: number | undefined;
  try {
    lock = openSync(lockPath, "wx", 0o600);
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current !== original) throw new Error("Parle profile catalog changed after preflight. No credential was published.");
    const profiles = current ? parseProfiles(current, path) : new Map<string, CredentialProfile>();
    if (profiles.has(profile.name)) throw new Error(`Parle profile ${profile.name} already exists. No existing profile is replaced by this workflow.`);
    const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    const updated = current + separator + renderProfile(profile);
    parseProfiles(updated, path);
    const temp = join(dirname(path), `.profiles.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(temp, updated, { mode: 0o600, flag: "wx" });
      if (process.platform !== "win32") chmodSync(temp, 0o600);
      renameSync(temp, path);
      if (process.platform !== "win32") chmodSync(path, 0o600);
    } finally { try { if (existsSync(temp)) unlinkSync(temp); } catch {} }
  } finally {
    if (lock !== undefined) closeSync(lock);
    try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch {}
  }
}

function publicAgents(raw: any): Array<{ agentId: string; agentHandle: string; displayName?: string }> {
  if (!Array.isArray(raw)) throw new Error("Parle agents response is invalid.");
  return raw.map((item) => ({
    agentId: validateUUID(String(item?.agent_id || ""), "agent_id"),
    agentHandle: validateHandle(String(item?.agent_handle || "")),
    ...(typeof item?.display_name === "string" ? { displayName: item.display_name } : {}),
  }));
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
    const response = await this.request(config, `/v/rooms/${encodeURIComponent(roomId)}/invites`, {
      method: "POST",
      body: { claim_mode: "target_session", seat_type: "principal", target: { kind: "principal", principal_id: principalId } },
      signal,
    });
    const inviteId = validateUUID(String(response.invite_id || ""), "response invite_id");
    const responseRoomId = validateUUID(String(response.room_id || ""), "response room_id");
    const targetPrincipalId = validateUUID(String(response.target_principal_id || ""), "response target_principal_id");
    if (responseRoomId !== roomId || targetPrincipalId !== principalId || response.seat_type !== "principal" || response.claim_mode !== "target_session") {
      throw new Error("Parle invite response did not match the requested immutable target-session principal admission.");
    }
    if (response.secret || response.code) throw new Error("Parle target-session invite response unexpectedly contained capability authority material.");
    const offeredRights = assertStringArray(response.offered_rights, "offered_rights");
    if (offeredRights.length !== 0) throw new Error("Parle invite response unexpectedly offered elevated room rights.");
    const display = normalizeTargetDisplay(response.target_display);
    const resolvedHandle = validateHandle(display.handle);
    if (resolvedHandle !== principalHandle) throw new Error("Parle invite response target handle did not match the requested confirmation label.");
    const claimUrl = String(response.claim_url || "");
    if (parseInvitationLocator(claimUrl, config) !== inviteId) throw new Error("Parle invite response did not contain a canonical locator URL.");
    return {
      inviteId,
      roomId,
      claimMode: "target_session",
      claimUrl,
      seatType: "principal",
      targetPrincipalId,
      targetHandle: resolvedHandle,
      offeredRights: [],
      expiresAt: response.expires_at,
      sensitive: false,
      next: "Share the ordinary locator URL out of band. Possession grants no authority; only the authenticated immutable target principal can preview or accept it.",
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

  private async invitationStatus(config: AccountConfig, invitation: string, signal?: AbortSignal): Promise<any> {
    const inviteId = parseInvitationLocator(invitation, config);
    const response = await this.request(config, `/v/room-invitations/${encodeURIComponent(inviteId)}`, { signal });
    if (validateUUID(String(response.invite_id || ""), "response invite_id") !== inviteId) throw new Error("Parle invitation response did not match the requested locator.");
    const roomId = validateUUID(String(response.room_id || ""), "response room_id");
    const state = String(response.state || "");
    if (!["pending", "accepted", "membership_ended"].includes(state) || response.seat_type !== "principal") throw new Error("Parle invitation response has invalid terms.");
    const offeredRights = assertStringArray(response.offered_rights, "offered_rights");
    if (offeredRights.length !== 0) throw new Error("Parle invitation unexpectedly offers elevated room rights.");
    return {
      inviteId,
      roomId,
      roomHandle: typeof response.room_handle === "string" ? validateHandle(response.room_handle) : undefined,
      state,
      inviterPrincipalId: validateUUID(String(response.inviter_principal_id || ""), "response inviter_principal_id"),
      inviterHandle: typeof response.inviter_handle === "string" ? response.inviter_handle : undefined,
      seatType: "principal",
      offeredRights,
      historyVisible: response.history_visible === true,
      expiresAt: response.expires_at,
      acceptedAt: response.accepted_at || undefined,
      principalSeatActive: response.principal_seat_active === true,
    };
  }

  async acceptRoomInvitation(params: AcceptRoomInvitationParams, signal?: AbortSignal) {
    if (params.action !== "preview" && params.action !== "accept") throw new Error('parle_accept_room_invitation action must be "preview" or "accept".');
    if (params.action === "accept" && (params.confirmMutation !== true || !params.reason?.trim())) throw new Error("parle_accept_room_invitation accept requires confirmMutation=true and a reason.");
    const config = this.config();
    const status = await this.invitationStatus(config, params.invitation, signal);
    if (params.action === "preview") {
      return {
        action: "preview",
        ...status,
        principal: status.state,
        next: status.state === "pending" ? "Review these server-authored terms, then accept with explicit confirmation." : status.state === "accepted" ? "The principal seat is active. Preview agent connection as the separate next action." : "This invitation was accepted previously, but its membership has ended.",
      };
    }
    if (status.state === "membership_ended") throw new Error("This invitation was accepted previously, but its principal membership has ended.");
    const response = await this.request(config, `/v/room-invitations/${encodeURIComponent(status.inviteId)}/accept`, { method: "POST", body: {}, signal });
    const responseRoomId = validateUUID(String(response.room_id || ""), "accept room_id");
    if (responseRoomId !== status.roomId || response.state !== "seated") throw new Error("Parle accepted the invitation but returned inconsistent admission facts.");
    return {
      action: "accept",
      inviteId: status.inviteId,
      roomId: status.roomId,
      roomHandle: status.roomHandle,
      seatId: validateUUID(String(response.seat_id || ""), "accept seat_id"),
      participantId: validateUUID(String(response.participant_id || ""), "accept participant_id"),
      principal: "accepted",
      agent: "needs_selection",
      seat: "missing",
      credential: "missing",
      connection: "profile_ready",
      next: "The direct principal seat is active and usable. Preview parle_connect_own_agent to select exactly one durable agent.",
    };
  }

  async connectOwnAgent(params: ConnectOwnAgentParams, signal?: AbortSignal) {
    if (params.action !== "preview" && params.action !== "complete") throw new Error('parle_connect_own_agent action must be "preview" or "complete".');
    if (params.action === "complete" && (params.confirmMutation !== true || !params.reason?.trim())) throw new Error("parle_connect_own_agent complete requires confirmMutation=true and a reason.");
    if (params.agentId && params.createAgentHandle) throw new Error("agentId and createAgentHandle are mutually exclusive.");
    if (params.agentHandle && params.createAgentHandle) throw new Error("agentHandle and createAgentHandle are mutually exclusive.");
    const config = this.config();
    const invitation = await this.invitationStatus(config, params.invitation, signal);
    if (invitation.state !== "accepted" || !invitation.principalSeatActive) {
      return {
        action: params.action,
        inviteId: invitation.inviteId,
        roomId: invitation.roomId,
        principal: invitation.state,
        agent: "needs_selection",
        seat: "missing",
        credential: "missing",
        connection: "profile_ready",
        next: invitation.state === "pending" ? "Accept the principal invitation first." : "The principal membership has ended and cannot connect an agent.",
      };
    }
    const listed = await this.request(config, "/v/agents", { signal });
    const agents = publicAgents(listed.agents);
    let selected = params.agentId ? agents.find((agent) => agent.agentId === validateUUID(params.agentId!, "agentId")) : undefined;
    if (params.agentId && !selected) throw new Error("agentId is not an active durable agent owned by the authenticated principal.");
    if (!selected && params.agentHandle) {
      const handle = validateHandle(params.agentHandle);
      selected = agents.find((agent) => agent.agentHandle === handle);
      if (!selected) throw new Error("agentHandle is not an active durable agent owned by the authenticated principal.");
    }
    if (!selected && !params.createAgentHandle && agents.length === 1) selected = agents[0];
    const proposedCreateHandle = params.createAgentHandle ? validateHandle(params.createAgentHandle) : undefined;
    if (!selected && !proposedCreateHandle) {
      return {
        action: "preview", inviteId: invitation.inviteId, roomId: invitation.roomId, roomHandle: invitation.roomHandle,
        principal: "accepted", agent: "needs_selection", agents,
        seat: "missing", credential: "missing", connection: "host_restart_required",
        next: agents.length === 0 ? "Choose an explicit createAgentHandle, then preview again." : "Choose one agentId or agentHandle, then preview again.",
      };
    }
    if (params.action === "preview" && !selected) {
      return {
        action: "preview", inviteId: invitation.inviteId, roomId: invitation.roomId, roomHandle: invitation.roomHandle,
        principal: "accepted", agent: "selected", proposedCreateHandle, agents,
        seat: "missing", credential: "missing", connection: "host_restart_required",
        next: "Review the deliberate new-agent handle, then complete with explicit confirmation.",
      };
    }
    if (params.action === "preview" && selected) {
      const room = await this.request(config, `/v/rooms/${encodeURIComponent(invitation.roomId)}`, { signal });
      const agentSeats = Array.isArray(room?.roster?.agent_seats) ? room.roster.agent_seats : [];
      const activeSeat = agentSeats.find((item: any) => item?.agent_id === selected!.agentId);
      const tokensResponse = await this.request(config, `/v/agents/${encodeURIComponent(selected.agentId)}/tokens`, { signal });
      const tokens = Array.isArray(tokensResponse.tokens) ? tokensResponse.tokens : [];
      const profiles = existsSync(config.catalogPath) ? parseProfiles(readFileSync(config.catalogPath, "utf8"), config.catalogPath) : new Map<string, CredentialProfile>();
      const activeTokenIds = new Set(tokens.filter((token: any) => token?.agent_id === selected!.agentId && token?.room_id === invitation.roomId && token?.revoked_at == null && Array.isArray(token?.scopes) && token.scopes.includes("participate")).map((token: any) => token.agent_token_id));
      const compatible = [...profiles.values()].find((profile) => profile.roomId === invitation.roomId && profile.agentTokenId && activeTokenIds.has(profile.agentTokenId));
      return {
        action: "preview", inviteId: invitation.inviteId, roomId: invitation.roomId, roomHandle: invitation.roomHandle,
        principal: "accepted", agent: "selected", selectedAgent: selected, agents,
        seat: activeSeat ? "active" : "missing", ...(activeSeat ? { seatId: validateUUID(String(activeSeat.seat_id || ""), "seat_id") } : {}),
        credential: compatible ? "profile_ready" : "missing", connection: compatible ? "profile_ready" : "host_restart_required",
        ...(compatible ? { profile: compatible.name } : {}),
        next: compatible ? "The exact agent already has a proven compatible profile. Confirm complete to return the ready binding without minting another credential." : "Review the immutable agent selection and missing steps, then complete with explicit confirmation.",
      };
    }
    let agentState: "selected" | "created" = "selected";
    if (!selected) {
      const created = await this.request(config, "/v/agents", { method: "POST", body: { agent_handle: proposedCreateHandle }, signal });
      selected = { agentId: validateUUID(String(created.agent_id || ""), "created agent_id"), agentHandle: validateHandle(String(created.agent_handle || "")), ...(typeof created.display_name === "string" ? { displayName: created.display_name } : {}) };
      if (selected.agentHandle !== proposedCreateHandle) throw new Error("Created agent did not match the confirmed handle.");
      agentState = "created";
    }
    const room = await this.request(config, `/v/rooms/${encodeURIComponent(invitation.roomId)}`, { signal });
    const agentSeats = Array.isArray(room?.roster?.agent_seats) ? room.roster.agent_seats : [];
    let seat = agentSeats.find((item: any) => item?.agent_id === selected!.agentId);
    if (!seat) {
      const admitted = await this.request(config, `/v/rooms/${encodeURIComponent(invitation.roomId)}/seats`, { method: "POST", body: { agent_id: selected.agentId }, signal });
      if (validateUUID(String(admitted.agent_id || ""), "admitted agent_id") !== selected.agentId) throw new Error("Parle admitted an unexpected agent.");
      seat = { seat_id: validateUUID(String(admitted.seat_id || ""), "admitted seat_id"), agent_id: selected.agentId };
    }
    const tokensResponse = await this.request(config, `/v/agents/${encodeURIComponent(selected.agentId)}/tokens`, { signal });
    const tokens = Array.isArray(tokensResponse.tokens) ? tokensResponse.tokens : [];
    const catalogPath = config.catalogPath;
    const profiles = existsSync(catalogPath) ? parseProfiles(readFileSync(catalogPath, "utf8"), catalogPath) : new Map<string, CredentialProfile>();
    const activeTokenIds = new Set(tokens.filter((token: any) => token?.agent_id === selected!.agentId && token?.room_id === invitation.roomId && token?.revoked_at == null && Array.isArray(token?.scopes) && token.scopes.includes("participate")).map((token: any) => token.agent_token_id));
    const compatible = [...profiles.values()].find((profile) => profile.roomId === invitation.roomId && profile.agentTokenId && activeTokenIds.has(profile.agentTokenId));
    if (compatible) {
      return {
        action: "complete", inviteId: invitation.inviteId, roomId: invitation.roomId,
        principal: "accepted", agent: agentState, selectedAgent: selected,
        seat: "active", seatId: validateUUID(String(seat.seat_id || ""), "seat_id"),
        credential: "profile_ready", connection: "profile_ready", profile: compatible.name,
        next: "Use the host adapter's existing safe profile-switch lifecycle to connect.",
      };
    }
    const roomHandle = invitation.roomHandle;
    if (!roomHandle && !params.profileLabel) throw new Error("Parle did not provide a canonical room handle. Supply an explicit profileLabel.");
    let profileName = params.profileLabel ? validateProfileLabel(params.profileLabel) : roomHandle!;
    if (profiles.has(profileName)) {
      if (params.profileLabel) throw new Error(`Parle profile ${profileName} already exists with an unproven binding. Choose a new profileLabel.`);
      const alternate = validateProfileLabel(`${roomHandle}-${selected.agentHandle}`);
      if (profiles.has(alternate)) throw new Error(`Both preferred profile labels are occupied. Supply an explicit unused profileLabel.`);
      profileName = alternate;
    }
    const sink = ensureProfileSink(catalogPath);
    let tokenResponse: any;
    try {
      tokenResponse = await this.request(config, `/v/agents/${encodeURIComponent(selected.agentId)}/tokens`, { method: "POST", body: { room_id: invitation.roomId }, signal });
    } catch (error: any) {
      if (!error?.status || error.status >= 500) {
        return {
          action: "complete", inviteId: invitation.inviteId, roomId: invitation.roomId,
          principal: "accepted", agent: agentState, selectedAgent: selected, recoveryAgentId: selected.agentId,
          seat: "active", credential: "outcome_unknown", connection: "host_restart_required",
          next: "Token mint outcome is unknown. Do not retry. Inspect safe token metadata for recoveryAgentId and follow Parle recovery issue #451.",
        };
      }
      throw error;
    }
    const candidateTokenId = optionalUUID(tokenResponse.agent_token_id);
    const revokeMintedToken = async (): Promise<boolean> => {
      if (!candidateTokenId) return false;
      try {
        const revoked = await this.fetchImpl(new URL(`/v/agents/${encodeURIComponent(selected.agentId)}/tokens/${encodeURIComponent(candidateTokenId)}`, config.apiBase), {
          method: "DELETE", headers: { Accept: "application/json", "Parle-Version": config.version, Cookie: config.sessionCookie },
        });
        return revoked.ok;
      } catch { return false; }
    };
    let agentTokenId: string;
    let agentToken: string;
    try {
      agentTokenId = validateUUID(String(tokenResponse.agent_token_id || ""), "agent_token_id");
      agentToken = String(tokenResponse.token || "");
      if (!/^parle_agt_\S{16,512}$/.test(agentToken) || validateUUID(String(tokenResponse.agent_id || ""), "token agent_id") !== selected.agentId || validateUUID(String(tokenResponse.room_id || ""), "token room_id") !== invitation.roomId) {
        throw new Error("Parle token response did not match the confirmed room and agent.");
      }
      publishNewProfile(sink.writePath, sink.original, { name: profileName, roomId: invitation.roomId, agentToken, agentTokenId, apiBase: config.apiBase });
    } catch (error: any) {
      const cleaned = await revokeMintedToken();
      const safeMessage = scrub(String(error?.message || error), [config.sessionCookie, String(tokenResponse?.token || "")]);
      throw new Error(`${safeMessage} Credential cleanup ${cleaned ? "succeeded" : "could not be confirmed"}; inspect safe token metadata before retrying.`);
    }
    return {
      action: "complete", inviteId: invitation.inviteId, roomId: invitation.roomId,
      principal: "accepted", agent: agentState, selectedAgent: selected,
      seat: "active", seatId: validateUUID(String(seat.seat_id || ""), "seat_id"),
      credential: "profile_ready", connection: "profile_ready", profile: profileName,
      next: "Use the host adapter's existing safe profile-switch lifecycle to connect.",
    };
  }
}
