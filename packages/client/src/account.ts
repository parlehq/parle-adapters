import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { DEFAULT_VERSION, isValidAddressHandle, isValidSessionAlias } from "./protocol.js";
import { CredentialProfile, PROFILE_LABEL_RE, loadProfile, parseProfiles, profileCatalogHasProfile, profileSectionRange, resolveProfileCatalogPath } from "./profiles.js";
import { ParleHardeningClient, type HardenAccountParams } from "./hardening.js";
import { atomicReplaceOwnerOnlyFile, readOwnerOnlyTextFile, withOwnerOnlyFileLock } from "./safe-file.js";
import { assertSafeBase, truncateText } from "./helpers.js";
import { RoomInventoryResponseError, parseAccountRoomPage, readConfiguredRoomSection, roomInventoryResult, type AccountRoomInventoryRow, type ActiveRoomInventoryRow, type ParleRoomsInventory, type RoomInventorySection } from "./room-inventory.js";

const DEFAULT_API_BASE = "https://api.parle.sh";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_HANDOFF_BYTES = 32 * 1024;
const MAX_PROFILE_CATALOG_BYTES = 1024 * 1024;
const MAX_ACCOUNT_ROOM_ROWS = 2_000;
const MAX_ACCOUNT_ROOM_PAGES = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE_SECRET_RE = /^parle_inv_\S{16,256}$/;
const INVITE_CODE_RE = /^[A-Z0-9]{6,32}$/;
const SESSION_COOKIE_RE = /^__Host-parle_session=[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
const LOGIN_CHALLENGE_COOKIE_RE = /^__Host-parle_login=[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
const MINT_DENIAL_NEXT_ACTION = {
  unhardened: "set a password, then enroll a second factor",
  cooldown: "wait for the post-recovery cooldown to lapse",
  account_restricted: "this account cannot expand its reach right now",
} as const;

export type AccountFetch = typeof fetch;

export class ParleAccountResponseContractError extends Error {
  readonly adapterCode = "parle_account_response_contract_mismatch";
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ParleAccountResponseContractError";
    this.status = status;
  }
}

export type AccountClientOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetch?: AccountFetch;
  now?: () => Date;
};

export type MintPrincipalInviteParams = {
  roomId: string;
  target: string;
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

export type LoginParams = {
  action?: "start" | "complete" | "complete-factor" | "mint-from-session";
  email?: string;
  factor?: "totp";
  code?: string;
  roomId?: string;
  roomHandle?: string;
  agentId?: string;
  agentHandle?: string;
  writeCredentials?: boolean;
  profile?: string;
  force?: boolean;
  confirmMutation?: boolean;
  reason?: string;
};

export type CreateRoomParams = {
  roomHandle?: string;
  kind: "private" | "shared";
  confirmMutation?: boolean;
  reason?: string;
};

export type CreateOwnAgentParams = {
  agentHandle: string;
  displayName?: string;
  confirmMutation?: boolean;
  reason?: string;
};

export type DeleteOwnAgentParams = {
  agentId: string;
  confirmMutation?: boolean;
  reason?: string;
};

export type RoomParticipantsParams = {
  roomId: string;
};

export type EndOwnSessionParams = {
  agentSessionId: string;
  confirmMutation?: boolean;
  reason?: string;
};

export type AddOwnAgentSeatParams = {
  roomId: string;
  agentId: string;
  confirmMutation?: boolean;
  reason?: string;
};

export type OwnedAliasDeliveryParams = {
  action: "get_global" | "set_global" | "get_room" | "set_room" | "restore_everywhere";
  agentId: string;
  alias: string;
  roomId?: string;
  offlineDelivery?: boolean;
  confirmMutation?: boolean;
  reason?: string;
};

export type OwnedAliasReleaseParams = {
  action: "preview" | "complete";
  agentId: string;
  alias: string;
  expectedAliasGeneration?: number;
  idempotencyKey?: string;
  confirmMutation?: boolean;
  reason?: string;
};

type AccountBaseConfig = {
  apiBase: string;
  version: string;
  sessionCookie?: string;
  stateDir: string;
  catalogPath: string;
  roomId?: string;
  roomHandle?: string;
  agentId?: string;
  agentHandle?: string;
  wakeBase?: string;
};

type AccountConfig = AccountBaseConfig & {
  sessionCookie: string;
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

function validateSessionCookie(raw: string): string {
  const value = raw.trim();
  if (!SESSION_COOKIE_RE.test(value)) throw new Error("Parle human session cookie must be one canonical __Host-parle_session cookie without separators or control characters.");
  return value;
}

function resolveAccountBaseConfig(cwd: string, env: Record<string, string | undefined>, options: { allowMissingProfile?: boolean } = {}): AccountBaseConfig {
  const dotEnvPath = join(cwd, ".env");
  const dotEnv = existsSync(dotEnvPath) ? parseDotEnv(readBounded(dotEnvPath, MAX_HANDOFF_BYTES, "Parle project environment")) : {};
  const profilesOverride = firstValue("PARLE_PROFILES_PATH", env, dotEnv);
  const catalogPath = resolveProfileCatalogPath(profilesOverride, cwd, env);
  const sessionPath = join(dirname(catalogPath), "session");
  let sessionCookie = firstValue("PARLE_SESSION_COOKIE", env, dotEnv);
  if (!sessionCookie && existsSync(sessionPath)) {
    assertNoSymlinkPathComponents(sessionPath);
    safeFile(sessionPath, "Parle human session file", false);
    sessionCookie = readBounded(sessionPath, 8192, "Parle human session file");
  }
  if (sessionCookie) sessionCookie = validateSessionCookie(sessionCookie);
  let configuredApiBase = firstValue("PARLE_API_BASE", env, dotEnv);
  let selectedProfile: CredentialProfile | undefined;
  if (existsSync(catalogPath)) {
    const profileName = firstValue("PARLE_PROFILE", env, dotEnv) || (profileCatalogHasProfile("default", catalogPath) ? "default" : undefined);
    if (profileName && (!options.allowMissingProfile || profileCatalogHasProfile(profileName, catalogPath))) selectedProfile = loadProfile(profileName, catalogPath);
  }
  if (selectedProfile) {
    const selectedApiBase = selectedProfile.apiBase || DEFAULT_API_BASE;
    if (configuredApiBase && new URL(configuredApiBase).origin !== new URL(selectedApiBase).origin) {
      throw new Error("Parle profile API origin conflicts with direct PARLE_API_BASE configuration.");
    }
    configuredApiBase = selectedApiBase;
  }
  const rawApiBase = configuredApiBase || DEFAULT_API_BASE;
  assertSafeBase(rawApiBase, env);
  const apiBase = new URL(rawApiBase).origin;
  const version = env.PARLE_VERSION || DEFAULT_VERSION;
  return {
    apiBase,
    version,
    sessionCookie,
    stateDir: dirname(catalogPath),
    catalogPath,
    roomId: selectedProfile?.roomId || firstValue("PARLE_ROOM_ID", env, dotEnv),
    roomHandle: firstValue("PARLE_ROOM_HANDLE", env, dotEnv),
    agentId: firstValue("PARLE_AGENT_ID", env, dotEnv),
    agentHandle: firstValue("PARLE_AGENT_HANDLE", env, dotEnv),
    wakeBase: selectedProfile?.wakeBase || firstValue("PARLE_WAKE_BASE", env, dotEnv),
  };
}

function resolveInventoryLocalConfig(cwd: string, env: Record<string, string | undefined>): { catalogPath: string; directRoomId?: string } {
  const dotEnvPath = join(cwd, ".env");
  const dotEnv = existsSync(dotEnvPath) ? parseDotEnv(readBounded(dotEnvPath, MAX_HANDOFF_BYTES, "Parle project environment")) : {};
  const directRoomId = firstValue("PARLE_ROOM_ID", env, dotEnv);
  return {
    catalogPath: resolveProfileCatalogPath(firstValue("PARLE_PROFILES_PATH", env, dotEnv), cwd, env),
    ...(directRoomId ? { directRoomId: validateUUID(directRoomId, "PARLE_ROOM_ID") } : {}),
  };
}

function resolveAccountConfig(cwd: string, env: Record<string, string | undefined>): AccountConfig {
  const config = resolveAccountBaseConfig(cwd, env);
  if (!config.sessionCookie) throw new Error(`Parle human session is not configured. Run parle_login complete or mint-from-session so ${join(dirname(config.catalogPath), "session")} exists.`);
  return config as AccountConfig;
}

function validateUUID(raw: unknown, label: string): string {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!UUID_RE.test(value) || value === "00000000-0000-0000-0000-000000000000") throw new Error(`${label} must be a non-zero UUID.`);
  return value;
}

function validateAlias(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!isValidSessionAlias(value)) {
    throw new Error("alias must normalize to an unreserved 2-32 character durable session alias using lowercase letters, digits, and single hyphens, and must not use the anonymous 16-character session shape.");
  }
  return value;
}

function validateHandle(raw: string, label = "principalHandle"): string {
  const value = raw.trim().toLowerCase();
  if (!isValidAddressHandle(value)) {
    throw new Error(`${label} must normalize to an unreserved 2-20 character handle using lowercase letters, digits, and hyphens with no leading, trailing, or consecutive hyphens.`);
  }
  return value;
}

function normalizePersonInviteTarget(raw: unknown): { target: string; kind: "handle" | "email"; handle?: string } {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.startsWith("@")) {
    if (value.indexOf("@", 1) !== -1) throw new Error("target must be one leading-at principal handle or one email address.");
    const handle = validateHandle(value.slice(1), "target handle");
    return { target: `@${handle}`, kind: "handle", handle };
  }
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) throw new Error("target must be one leading-at principal handle or one email address.");
  const local = value.slice(0, at);
  let domain = value.slice(at + 1);
  domain = domain.endsWith(".") ? domain.slice(0, -1) : domain;
  if (!domain || domain.endsWith(".") || /[^\x00-\x7f]/.test(domain)) throw new Error("target email domain must be non-empty ASCII with at most one trailing root dot.");
  return { target: `${local}@${domain.toLowerCase()}`, kind: "email" };
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

function parseRoomParticipants(raw: any, expectedRoomId: string) {
  if (!Array.isArray(raw?.participants)) throw new ParleAccountResponseContractError("Parle room participant response is invalid.", 200);
  try {
    return {
      participants: raw.participants.map((participant: any) => {
        if (!participant || typeof participant !== "object"
          || typeof participant.session_handle !== "string" || !participant.session_handle
          || !Number.isFinite(Date.parse(participant.last_seen_at))
          || !Number.isFinite(Date.parse(participant.expires_at))) throw new Error();
        const roomId = validateUUID(String(participant.room_id || ""), "participant room_id");
        if (roomId !== expectedRoomId) throw new Error();
        return {
          participant_id: validateUUID(String(participant.participant_id || ""), "participant_id"),
          room_id: roomId,
          principal_id: validateUUID(String(participant.principal_id || ""), "participant principal_id"),
          agent_session_id: validateUUID(String(participant.agent_session_id || ""), "participant agent_session_id"),
          agent_id: validateUUID(String(participant.agent_id || ""), "participant agent_id"),
          session_handle: participant.session_handle,
          last_seen_at: participant.last_seen_at,
          expires_at: participant.expires_at,
        };
      }),
    };
  } catch {
    throw new ParleAccountResponseContractError("Parle room participant response is invalid.", 200);
  }
}

function parseInvitationReference(raw: string): string {
  const value = raw.trim();
  if (UUID_RE.test(value)) return validateUUID(value, "invitation");
  let locator: URL;
  try { locator = new URL(value); } catch { throw new Error("invitation must be an invite UUID or canonical Parle invitation URL."); }
  const loopback = locator.hostname === "localhost" || locator.hostname === "127.0.0.1" || locator.hostname === "[::1]";
  if ((locator.protocol !== "https:" && !(locator.protocol === "http:" && loopback)) || locator.username || locator.password || locator.search || locator.hash) {
    throw new Error("Invitation URL must use HTTPS or loopback HTTP and contain no credentials, query, or fragment.");
  }
  const match = locator.pathname.match(/^\/room-invitations\/([0-9a-f-]+)$/i);
  if (!match) throw new Error("Invitation URL path is not the canonical Parle room-invitation locator.");
  return validateUUID(match[1], "invitation locator");
}

function validateProfileLabel(raw: string): string {
  const value = raw.trim();
  if (!PROFILE_LABEL_RE.test(value)) throw new Error("profileLabel must be 1 to 64 characters using letters, numbers, dot, underscore, or hyphen.");
  return value;
}

function sessionCookieFilePath(catalogPath: string): string {
  return join(dirname(catalogPath), "session");
}

function pendingLoginCookieFilePath(catalogPath: string): string {
  return join(dirname(catalogPath), "login");
}

function assertNoSymlinkPathComponents(path: string): string {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (existsSync(current)) {
      const componentStat = lstatSync(current);
      if (componentStat.isSymbolicLink() && (process.platform === "win32" || componentStat.uid === process.getuid?.())) {
        throw new Error(`Refusing to write Parle credentials through a user-owned symlinked path component: ${current}`);
      }
    }
  }
  return absolute;
}

function ensureProfileDirectory(path: string): string {
  const directory = assertNoSymlinkPathComponents(dirname(path));
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkPathComponents(directory);
  const link = lstatSync(directory);
  if (link.isSymbolicLink()) throw new Error(`Refusing to write Parle profiles through a symlinked directory: ${directory}`);
  if (!link.isDirectory()) throw new Error(`Refusing to write Parle profiles because ${directory} is not a regular directory.`);
  const writeDirectory = directory;
  const target = statSync(writeDirectory);
  if (!target.isDirectory()) throw new Error(`Refusing to write Parle profiles because ${directory} does not resolve to a regular directory.`);
  if (process.platform !== "win32" && target.uid !== process.getuid?.()) throw new Error(`Refusing to write Parle profiles because ${directory} does not resolve to a directory owned by the current user.`);
  if (process.platform !== "win32") chmodSync(writeDirectory, 0o700);
  return writeDirectory;
}

function safeProfileWritePath(path: string): string {
  if (!existsSync(path)) return path;
  const link = lstatSync(path);
  if (process.platform !== "win32" && link.uid !== process.getuid?.()) throw new Error(`Refusing to write Parle profiles because ${path} is not owned by the current user.`);
  if (link.isSymbolicLink()) throw new Error(`Refusing to write Parle profiles through a symlinked catalog: ${path}`);
  if (!link.isFile()) throw new Error(`Refusing to write Parle profiles because ${path} is not a regular file.`);
  const writePath = path;
  const target = statSync(writePath);
  if (!target.isFile()) throw new Error(`Refusing to write Parle profiles because ${path} does not resolve to a regular file.`);
  if (process.platform !== "win32" && target.uid !== process.getuid?.()) throw new Error(`Refusing to write Parle profiles because ${path} does not resolve to a file owned by the current user.`);
  return writePath;
}

function writeCookieFile(catalogPath: string, filename: "session" | "login", cookie: string): string {
  const directory = ensureProfileDirectory(catalogPath);
  const path = join(dirname(catalogPath), filename);
  const writePath = safeProfileWritePath(join(directory, basename(path)));
  atomicReplaceOwnerOnlyFile(writePath, `${cookie}\n`, {
    label: `Parle ${filename} credential`,
    maxBytes: 8192,
    durability: "best-effort",
    existingMode: "replace",
  });
  return path;
}

function writeSessionCookieFile(catalogPath: string, cookie: string): string {
  return writeCookieFile(catalogPath, "session", cookie);
}

function writePendingLoginCookieFile(catalogPath: string, cookie: string): string {
  return writeCookieFile(catalogPath, "login", cookie);
}

function readPendingLoginCookieFile(catalogPath: string): string {
  const path = safeFile(pendingLoginCookieFilePath(catalogPath), "Parle pending login credential", false);
  const cookie = readOwnerOnlyTextFile(path, { label: "Parle pending login credential", maxBytes: 8192 }).trim();
  if (!LOGIN_CHALLENGE_COOKIE_RE.test(cookie)) throw new Error("Parle pending login credential is malformed. Remove it and restart email login.");
  return cookie;
}

function removePendingLoginCookieFile(catalogPath: string): void {
  const path = pendingLoginCookieFilePath(catalogPath);
  if (!existsSync(path)) return;
  safeFile(path, "Parle pending login credential", false);
  unlinkSync(path);
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

function preflightProfileWrite(profileName: string, force: boolean, catalogPath: string): void {
  if (!PROFILE_LABEL_RE.test(profileName)) throw new Error("Parle profile must be 1 to 64 characters and contain only letters, numbers, dot, underscore, or hyphen, starting with a letter or number.");
  const directory = ensureProfileDirectory(catalogPath);
  const writePath = safeProfileWritePath(join(directory, basename(catalogPath)));
  const original = existsSync(writePath) ? readFileSync(writePath, "utf8") : "";
  if (original) parseProfiles(original, catalogPath);
  if (profileSectionRange(original, profileName) && !force) throw new Error(`Parle profile ${profileName} already exists in ${catalogPath}. Pass force=true to replace only that profile.`);
  const probe = join(dirname(writePath), `.profiles-write-test-${process.pid}`);
  try { writeFileSync(probe, "ok\n", { mode: 0o600, flag: "wx" }); } finally { try { unlinkSync(probe); } catch {} }
}

function writeProfile(profile: CredentialProfile, force: boolean, catalogPath: string): { path: string; replaced: boolean; priorAgentTokenId?: string } {
  if (!PROFILE_LABEL_RE.test(profile.name)) throw new Error("Parle profile must be 1 to 64 characters and contain only letters, numbers, dot, underscore, or hyphen, starting with a letter or number.");
  const directory = ensureProfileDirectory(catalogPath);
  const writePath = safeProfileWritePath(join(directory, basename(catalogPath)));
  return withOwnerOnlyFileLock(writePath, { label: "Parle profile catalog", durability: "none" }, () => {
    const original = existsSync(writePath) ? readOwnerOnlyTextFile(writePath, { label: "Parle profile catalog", maxBytes: MAX_PROFILE_CATALOG_BYTES, modePolicy: "ignore" }) : "";
    const profiles = original ? parseProfiles(original, catalogPath) : new Map<string, CredentialProfile>();
    const range = profileSectionRange(original, profile.name);
    if (range && !force) throw new Error(`Parle profile ${profile.name} already exists in ${catalogPath}. Pass force=true to replace only that profile.`);
    const section = renderProfile(profile);
    const updated = range
      ? original.slice(0, range.start) + section + original.slice(range.end)
      : original + (original.length === 0 || original.endsWith("\n") ? "" : "\n") + section;
    parseProfiles(updated, catalogPath);
    if (ensureProfileDirectory(catalogPath) !== directory) throw new Error("Parle credential directory changed during profile persistence.");
    safeProfileWritePath(writePath);
    atomicReplaceOwnerOnlyFile(writePath, updated, { label: "Parle profile catalog", maxBytes: MAX_PROFILE_CATALOG_BYTES, durability: "best-effort", existingMode: "replace" });
    return { path: catalogPath, replaced: Boolean(range), priorAgentTokenId: profiles.get(profile.name)?.agentTokenId };
  });
}

function preflightNewProfile(path: string, profileName: string): { writePath: string; original: string } {
  const directory = ensureProfileDirectory(path);
  const writePath = safeProfileWritePath(join(directory, basename(path)));
  const original = existsSync(writePath) ? readFileSync(writePath, "utf8") : "";
  const profiles = original ? parseProfiles(original, path) : new Map<string, CredentialProfile>();
  if (profiles.has(profileName)) throw new Error(`Parle profile ${profileName} already exists. No existing profile is replaced by this workflow.`);
  return { writePath, original };
}

function publishNewProfile(path: string, original: string, profile: CredentialProfile): void {
  withOwnerOnlyFileLock(path, { label: "Parle profile catalog", durability: "none" }, () => {
    const current = existsSync(path) ? readOwnerOnlyTextFile(path, { label: "Parle profile catalog", maxBytes: MAX_PROFILE_CATALOG_BYTES, modePolicy: "ignore" }) : "";
    if (current !== original) throw new Error("Parle profile catalog changed after preflight. No credential was published.");
    const profiles = current ? parseProfiles(current, path) : new Map<string, CredentialProfile>();
    if (profiles.has(profile.name)) throw new Error(`Parle profile ${profile.name} already exists. No existing profile is replaced by this workflow.`);
    const updated = current + (current.length === 0 || current.endsWith("\n") ? "" : "\n") + renderProfile(profile);
    parseProfiles(updated, path);
    ensureProfileDirectory(path);
    safeProfileWritePath(path);
    atomicReplaceOwnerOnlyFile(path, updated, { label: "Parle profile catalog", maxBytes: MAX_PROFILE_CATALOG_BYTES, durability: "best-effort", existingMode: "replace" });
  });
}

function publicAgents(raw: any): Array<{ agentId: string; agentHandle: string; displayName?: string }> {
  if (!Array.isArray(raw)) throw new Error("Parle agents response is invalid.");
  return raw.map((item) => ({
    agentId: validateUUID(String(item?.agent_id || ""), "agent_id"),
    agentHandle: validateHandle(String(item?.agent_handle || "")),
    ...(typeof item?.display_name === "string" ? { displayName: item.display_name } : {}),
  }));
}

function publicInventory(items: any[], idKey: string, handleKey: string) {
  return items.map((item) => ({ [idKey]: item?.[idKey], [handleKey]: item?.[handleKey] })).filter((item) => item[idKey] || item[handleKey]);
}

function chooseInventoryItem(items: any[], idKey: string, handleKey: string, label: string, requestedId?: string, requestedHandle?: string): any | undefined {
  if (requestedId && requestedHandle) {
    const match = items.find((item) => item?.[idKey] === requestedId);
    if (!match) throw new Error(`No ${label} matches ${idKey}=${requestedId}.`);
    if (match?.[handleKey] !== requestedHandle) throw new Error(`${label} selection conflict: ${idKey}=${requestedId} has ${handleKey}=${match?.[handleKey] || "<unset>"}, not ${requestedHandle}.`);
    return match;
  }
  if (requestedId) {
    const match = items.find((item) => item?.[idKey] === requestedId);
    if (!match) throw new Error(`No ${label} matches ${idKey}=${requestedId}.`);
    return match;
  }
  if (requestedHandle) {
    const matches = items.filter((item) => item?.[handleKey] === requestedHandle);
    if (matches.length === 0) throw new Error(`No ${label} matches ${handleKey}=${requestedHandle}.`);
    if (matches.length > 1) throw new Error(`Multiple ${label}s match ${handleKey}=${requestedHandle}; pass ${idKey} instead.`);
    return matches[0];
  }
  return items.length === 1 ? items[0] : undefined;
}

function setCookieValues(headers: Headers): string[] {
  const getSetCookie = (headers as any).getSetCookie;
  return typeof getSetCookie === "function" ? getSetCookie.call(headers) : [headers.get("set-cookie")].filter(Boolean) as string[];
}

function extractCookie(headers: Headers, name: "__Host-parle_session" | "__Host-parle_login"): string | undefined {
  for (const value of setCookieValues(headers)) {
    const match = value.match(new RegExp(`(?:^|,\\s*)(${name}=[^;,\\s]+)`));
    if (match) return match[1];
  }
  return undefined;
}

function clearsCookie(headers: Headers, name: "__Host-parle_login"): boolean {
  return setCookieValues(headers).some((value) => value.includes(`${name}=`) && /(?:Max-Age=0|Max-Age=-1|Expires=Thu, 01 Jan 1970)/i.test(value));
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

  private async request(config: AccountConfig, path: string, options: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; secrets?: string[]; expectNoContent?: boolean } = {}): Promise<any> {
    const headers: Record<string, string> = {
      ...(options.headers || {}),
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
    const status = response.status;
    const ok = response.ok;
    const statusText = response.statusText;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(await response.arrayBuffer());
    } catch {
      throw new ParleAccountResponseContractError("Parle API response body could not be read.", status);
    }
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      throw new ParleAccountResponseContractError(`Parle API response exceeded ${MAX_RESPONSE_BYTES} bytes.`, status);
    }
    const text = buffer.toString("utf8");
    const json = parseJson(text);
    if (!ok) {
      const error = json?.error && typeof json.error === "object" ? json.error : {};
      const rawReason = typeof error.reason === "string" ? error.reason : "";
      const expectedNextAction = MINT_DENIAL_NEXT_ACTION[rawReason as keyof typeof MINT_DENIAL_NEXT_ACTION];
      const denialIsRecognized = Boolean(status === 403 && error.code === "forbidden" && expectedNextAction && error.unlock === expectedNextAction);
      const baseMessage = scrub(String(error.message || text || statusText), [config.sessionCookie, ...(options.secrets || [])]).slice(0, 4096);
      const message = denialIsRecognized ? `${baseMessage}. Reason: ${rawReason}. Next action: ${expectedNextAction}` : baseMessage;
      const raised: any = new Error(`Parle API ${status}: ${message}`);
      raised.status = status;
      raised.code = typeof error.code === "string" ? error.code : undefined;
      raised.action = typeof error.action === "string" ? error.action : undefined;
      raised.scope = typeof error.scope === "string" ? error.scope : undefined;
      raised.retryable = typeof error.retryable === "boolean" ? error.retryable : undefined;
      raised.retryAfterMs = typeof error.retry_after_ms === "number" ? error.retry_after_ms : undefined;
      raised.details = error.details && typeof error.details === "object" ? error.details : undefined;
      if (denialIsRecognized) {
        raised.reason = rawReason;
        raised.nextAction = expectedNextAction;
      }
      throw raised;
    }
    if (options.expectNoContent) {
      if (status !== 204 || buffer.byteLength !== 0) {
        throw new ParleAccountResponseContractError("Parle API returned an invalid no-content response.", status);
      }
      return null;
    }
    if (buffer.byteLength === 0 || json === null || typeof json !== "object") {
      throw new ParleAccountResponseContractError("Parle API returned an invalid JSON response.", status);
    }
    return json;
  }

  private async readAccountRooms(config: AccountConfig, signal?: AbortSignal): Promise<
    | { state: "complete"; rows: AccountRoomInventoryRow[] }
    | { state: "truncated"; rows: AccountRoomInventoryRow[]; cause: "row_limit" | "page_limit"; limit: number; pagesFetched: number; rowsReturned: number }
  > {
    const rows: AccountRoomInventoryRow[] = [];
    const roomIds = new Set<string>();
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_ACCOUNT_ROOM_PAGES; pageNumber += 1) {
      const path = after === null ? "/v/rooms" : `/v/rooms?after=${encodeURIComponent(after)}`;
      const page = parseAccountRoomPage(await this.request(config, path, { signal }));
      for (const [rowIndex, row] of page.rooms.entries()) {
        if (roomIds.has(row.roomId)) throw new RoomInventoryResponseError("account room response repeated a room across pages.");
        roomIds.add(row.roomId);
        rows.push(row);
        if (rows.length >= MAX_ACCOUNT_ROOM_ROWS) {
          const finalReturnedRow = page.next === null && rowIndex === page.rooms.length - 1;
          return finalReturnedRow && rows.length === MAX_ACCOUNT_ROOM_ROWS
            ? { state: "complete", rows }
            : {
                state: "truncated",
                rows: rows.slice(0, MAX_ACCOUNT_ROOM_ROWS),
                cause: "row_limit",
                limit: MAX_ACCOUNT_ROOM_ROWS,
                pagesFetched: pageNumber + 1,
                rowsReturned: MAX_ACCOUNT_ROOM_ROWS,
              };
        }
      }
      if (page.next === null) return { state: "complete", rows };
      if (cursors.has(page.next)) throw new RoomInventoryResponseError("account room response repeated a continuation cursor.");
      cursors.add(page.next);
      after = page.next;
    }
    return {
      state: "truncated",
      rows,
      cause: "page_limit",
      limit: MAX_ACCOUNT_ROOM_PAGES,
      pagesFetched: MAX_ACCOUNT_ROOM_PAGES,
      rowsReturned: rows.length,
    };
  }

  async listRooms(active: RoomInventorySection<ActiveRoomInventoryRow>, signal?: AbortSignal): Promise<ParleRoomsInventory> {
    let configured: ReturnType<typeof readConfiguredRoomSection>;
    try {
      const local = resolveInventoryLocalConfig(this.cwd, this.env);
      configured = readConfiguredRoomSection(local.catalogPath, local.directRoomId);
    } catch {
      configured = { state: "error", reason: "profile_catalog_invalid" };
    }

    let account: RoomInventorySection<AccountRoomInventoryRow>;
    if (configured.state === "error") {
      account = { state: "error", reason: "account_request_failed" };
    } else try {
      const base = resolveAccountBaseConfig(this.cwd, this.env);
      if (!base.sessionCookie) {
        account = { state: "unavailable", reason: "human_session_not_configured" };
      } else {
        account = await this.readAccountRooms(base as AccountConfig, signal);
      }
    } catch (error: any) {
      if (error instanceof RoomInventoryResponseError) account = { state: "error", reason: "account_response_invalid" };
      else if (error?.status === 401) account = { state: "unavailable", reason: "human_session_rejected" };
      else account = { state: "error", reason: "account_request_failed" };
    }
    return roomInventoryResult(active, configured, account);
  }

  private async emailRequest(config: AccountBaseConfig, path: string, body: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; json: any; headers: Headers }> {
    const response = await this.fetchImpl(new URL(path, config.apiBase), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "Parle-Version": config.version },
      body: JSON.stringify(body),
      signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error(`Parle API response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
    const text = scrub(buffer.toString("utf8"), Object.values(body));
    if (!response.ok) throw new Error(`Parle email login ${path.endsWith("/start") ? "start" : "complete"} failed ${response.status}: ${truncateText(text, 4096).text}`);
    return { status: response.status, json: parseJson(text) || {}, headers: response.headers };
  }

  private async completeLoginFactor(config: AccountBaseConfig, code: string, signal?: AbortSignal) {
    const pendingCookie = readPendingLoginCookieFile(config.catalogPath);
    const response = await this.fetchImpl(new URL("/v/auth/login/complete", config.apiBase), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Parle-Version": config.version,
        Cookie: pendingCookie,
      },
      body: JSON.stringify({ factor: "totp", code }),
      signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error(`Parle API response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
    const text = scrub(buffer.toString("utf8"), [code, pendingCookie]);
    if (response.status === 401) {
      const terminal = clearsCookie(response.headers, "__Host-parle_login");
      if (terminal) removePendingLoginCookieFile(config.catalogPath);
      return {
        status: "factor_rejected",
        retryable: !terminal,
        pendingLoginPreserved: !terminal,
        secrets: "redacted; login challenge and TOTP were not returned in tool output",
        next: terminal
          ? "The pending login is no longer usable. Start a new email login."
          : "The pending login remains usable. Retry complete-factor with the current authenticator code; do not request another email code.",
      };
    }
    if (!response.ok) throw new Error(`Parle login factor completion failed ${response.status}: ${truncateText(text, 4096).text}`);
    if (response.status !== 204) throw new Error(`Parle login factor completion returned unexpected status ${response.status}.`);
    const sessionCookie = extractCookie(response.headers, "__Host-parle_session");
    if (!sessionCookie || !SESSION_COOKIE_RE.test(sessionCookie)) throw new Error("Parle login factor completion succeeded without a valid human session cookie. Pending state was preserved.");
    const sessionCookiePath = writeSessionCookieFile(config.catalogPath, sessionCookie);
    removePendingLoginCookieFile(config.catalogPath);
    return {
      status: "session_saved",
      wroteSessionCookie: true,
      sessionCookiePath,
      secrets: "redacted; login challenge, TOTP, and PARLE_SESSION_COOKIE were not returned in tool output",
      next: "Call parle_login with action:'mint-from-session', an exact room selector, and an exact agent selector to mint and save one room-bound profile.",
    };
  }

  async login(params: LoginParams, signal?: AbortSignal) {
    const action = params.action || (params.code ? "complete" : "start");
    if (action !== "start" && (params.confirmMutation !== true || !params.reason?.trim())) throw new Error(`parle_login ${action} requires confirmMutation=true and a reason before persisting credentials, spending proof attempts, or minting a token.`);
    const config = resolveAccountBaseConfig(this.cwd, this.env, { allowMissingProfile: true });
    const writeCredentials = params.writeCredentials !== false;
    const profileName = params.profile || "default";

    if (action === "start") {
      if (!params.email) throw new Error("parle_login start requires email.");
      const started = await this.emailRequest(config, "/v/auth/email/start", { email: params.email }, signal);
      const serverStatus = typeof started.json?.status === "string" && started.json.status.trim() ? started.json.status : undefined;
      return {
        status: "start_accepted",
        ...(serverStatus ? { serverStatus } : {}),
        email: params.email,
        next: "An accepted request does not confirm that an account exists or that a code was sent. If a code arrives at this exact email, call parle_login again with the same email and code. Otherwise, do not retry automatically: parle_login is only for a returning account's linked email; first-time onboarding uses the separate onboarding flow.",
      };
    }

    if (!writeCredentials) {
      if (action === "complete") throw new Error("parle_login complete refuses writeCredentials=false because it would consume a one-time code without durable credential recovery.");
      if (action === "complete-factor") throw new Error("parle_login complete-factor refuses writeCredentials=false because it would spend a TOTP attempt without durable pending-state recovery.");
      if (action === "mint-from-session") throw new Error("parle_login mint-from-session refuses writeCredentials=false because it would mint a plaintext token without durable credential recovery.");
    }
    if (action === "complete-factor") {
      if (params.factor !== "totp" || !params.code?.trim()) throw new Error("parle_login complete-factor requires factor='totp' and the current authenticator code.");
      return this.completeLoginFactor(config, params.code.trim(), signal);
    }

    let sessionCookie = config.sessionCookie;
    if (action === "complete") {
      if (!params.email) throw new Error("parle_login complete requires email.");
      if (!params.code) throw new Error("parle_login complete requires code.");
      const completed = await this.emailRequest(config, "/v/auth/email/complete", { email: params.email, code: params.code }, signal);
      sessionCookie = extractCookie(completed.headers, "__Host-parle_session");
      if (completed.status === 201 && sessionCookie && SESSION_COOKIE_RE.test(sessionCookie)) {
        const sessionCookiePath = writeSessionCookieFile(config.catalogPath, sessionCookie);
        removePendingLoginCookieFile(config.catalogPath);
        return {
          status: "session_saved",
          wroteSessionCookie: true,
          sessionCookiePath,
          secrets: "redacted; PARLE_SESSION_COOKIE was not returned in tool output",
          next: "Call parle_login with action:'mint-from-session', an exact room selector, and an exact agent selector to mint and save one room-bound profile.",
        };
      }
      const pendingCookie = extractCookie(completed.headers, "__Host-parle_login");
      const factors = Array.isArray(completed.json?.factors) ? completed.json.factors.filter((factor: unknown): factor is string => typeof factor === "string") : [];
      if (completed.status !== 202 || completed.json?.status !== "factor_required" || !pendingCookie || !LOGIN_CHALLENGE_COOKIE_RE.test(pendingCookie) || !factors.includes("totp") || typeof completed.json?.expires_at !== "string") {
        throw new Error("Parle email login returned an invalid session-or-factor response. No credential was persisted.");
      }
      const pendingLoginCookiePath = writePendingLoginCookieFile(config.catalogPath, pendingCookie);
      return {
        status: "factor_required",
        factors,
        expires_at: completed.json.expires_at,
        wrotePendingLoginCookie: true,
        pendingLoginCookiePath,
        secrets: "redacted; login challenge and email code were not returned in tool output",
        next: "Call parle_login with action:'complete-factor', factor:'totp', and the current authenticator code. Do not request another email code.",
      };
    } else if (action === "mint-from-session") {
      preflightProfileWrite(profileName, params.force === true, config.catalogPath);
      if (!sessionCookie) throw new Error(`parle_login mint-from-session requires PARLE_SESSION_COOKIE in env or .env, or a session file at ${sessionCookieFilePath(config.catalogPath)} (written by parle_login complete).`);
    } else {
      throw new Error(`Unknown parle_login action: ${action}`);
    }

    const authenticated = { ...config, sessionCookie } as AccountConfig;
    const roomInventory = await this.readAccountRooms(authenticated, signal);
    const agentsBody = await this.request(authenticated, "/v/agents", { signal });
    const rooms = roomInventory.rows.map((room) => ({ room_id: room.roomId, room_handle: room.roomHandle }));
    const agents = Array.isArray(agentsBody?.agents) ? agentsBody.agents : Array.isArray(agentsBody) ? agentsBody : [];
    const roomId = params.roomId || (params.roomHandle ? undefined : config.roomId);
    const roomHandle = params.roomHandle || (params.roomId ? undefined : config.roomHandle);
    const agentId = params.agentId || (params.agentHandle ? undefined : config.agentId);
    const agentHandle = params.agentHandle || (params.agentId ? undefined : config.agentHandle);
    if (roomInventory.state === "truncated" && !params.roomId) {
      return {
        status: "selection_required",
        wroteSessionCookie: false,
        rooms: publicInventory(rooms, "room_id", "room_handle"),
        agents: publicInventory(agents, "agent_id", "agent_handle"),
        room_inventory: {
          state: "truncated",
          cause: roomInventory.cause,
          limit: roomInventory.limit,
          pages_fetched: roomInventory.pagesFetched,
          rows_returned: roomInventory.rowsReturned,
        },
        next: "Account room inventory is incomplete. Call parle_login with action:'mint-from-session' and an exact roomId from the returned rows plus either agentId or agentHandle. Room-handle selection and inference are disabled on truncated inventory.",
      };
    }
    const room = chooseInventoryItem(rooms, "room_id", "room_handle", "room", roomId, roomHandle);
    const agent = chooseInventoryItem(agents, "agent_id", "agent_handle", "agent", agentId, agentHandle);
    if (!room || !agent) {
      return {
        status: "selection_required",
        wroteSessionCookie: false,
        rooms: publicInventory(rooms, "room_id", "room_handle"),
        agents: publicInventory(agents, "agent_id", "agent_handle"),
        next: "Call parle_login with action:'mint-from-session' and either roomId or roomHandle plus either agentId or agentHandle. The previously completed human session remains saved.",
      };
    }

    const roomDetails = await this.request(authenticated, `/v/rooms/${encodeURIComponent(room.room_id)}`, { signal });
    const agentSeats = roomDetails?.roster?.agent_seats;
    if (!Array.isArray(agentSeats)) throw new Error("Parle room response is invalid: roster.agent_seats must be an array.");
    const exactSeat = agentSeats.find((item: any) => item?.agent_id === agent.agent_id);
    if (exactSeat) {
      try {
        validateUUID(String(exactSeat.seat_id || ""), "room agent seat_id");
      } catch {
        throw new Error("Parle room response is invalid: the matching roster.agent_seats entry must include a valid seat_id.");
      }
    }
    if (!exactSeat) {
      return {
        status: "seat_required",
        wroteCredentials: false,
        wroteSessionCookie: false,
        profile: profileName,
        room: { room_id: room.room_id, room_handle: room.room_handle },
        agent: { agent_id: agent.agent_id, agent_handle: agent.agent_handle },
        secrets: "redacted; no session cookie or agent token was returned",
        next: `Call parle_add_own_agent_seat with roomId:'${room.room_id}', agentId:'${agent.agent_id}', confirmMutation:true, and a reason. Then rerun parle_login with action:'mint-from-session' and the same room and agent selectors.`,
      };
    }

    if (action === "mint-from-session") writeSessionCookieFile(config.catalogPath, sessionCookie!);
    let tokenBody: any;
    try {
      tokenBody = await this.request(authenticated, `/v/agents/${encodeURIComponent(agent.agent_id)}/tokens`, {
        method: "POST",
        body: { room_id: room.room_id },
        signal,
      });
    } catch (error: any) {
      if (!error?.status || error.status >= 500) {
        return {
          status: "outcome_unknown",
          profile: profileName,
          room: { room_id: room.room_id, room_handle: room.room_handle },
          agent: { agent_id: agent.agent_id, agent_handle: agent.agent_handle },
          secrets: "redacted; no session cookie or agent token was returned",
          next: "Token mint outcome is unknown. Do not retry. Inspect safe token metadata for the selected agent before taking another action.",
        };
      }
      throw error;
    }
    const candidateTokenId = optionalUUID(tokenBody?.agent_token_id);
    let token: string;
    let agentTokenId: string;
    try {
      token = String(tokenBody?.token || "");
      agentTokenId = validateUUID(String(tokenBody?.agent_token_id || ""), "agent_token_id");
      if (!/^parle_agt_\S{16,512}$/.test(token)
        || validateUUID(String(tokenBody?.agent_id || ""), "token agent_id") !== agent.agent_id
        || validateUUID(String(tokenBody?.room_id || ""), "token room_id") !== room.room_id) {
        throw new Error("Parle token response did not match the selected room and agent.");
      }
    } catch {
      return {
        status: "outcome_unknown",
        profile: profileName,
        ...(candidateTokenId ? { agent_token_id: candidateTokenId } : {}),
        credential_cleanup: "not_attempted",
        room: { room_id: room.room_id, room_handle: room.room_handle },
        agent: { agent_id: agent.agent_id, agent_handle: agent.agent_handle },
        secrets: "redacted; no session cookie or agent token was returned",
        next: "Token mint returned an invalid success shape. No automatic cleanup was attempted. Do not retry until safe token metadata is inspected and any revoke uses the explicit confirmed canonical operation.",
      };
    }
    let profileWrite: ReturnType<typeof writeProfile>;
    try {
      profileWrite = writeProfile({
        name: profileName,
        roomId: room.room_id,
        agentToken: token,
        agentTokenId,
        apiBase: config.apiBase || DEFAULT_API_BASE,
        wakeBase: config.wakeBase,
      }, params.force === true, config.catalogPath);
    } catch (error: any) {
      const publicationError = scrub(String(error?.message || error), [authenticated.sessionCookie, token]);
      return {
        status: "credential_publication_failed",
        publication_error: publicationError,
        profile: profileName,
        agent_token_id: agentTokenId,
        credential_cleanup: "not_attempted",
        room: { room_id: room.room_id, room_handle: room.room_handle },
        agent: { agent_id: agent.agent_id, agent_handle: agent.agent_handle },
        secrets: "redacted; no session cookie or agent token was returned",
        next: "Local profile publication failed. No automatic cleanup was attempted. Do not retry until safe token metadata is inspected and any revoke uses the explicit confirmed canonical operation.",
      };
    }
    return {
      status: "credentials_saved",
      wroteCredentials: writeCredentials,
      profile: profileName,
      profileReplaced: profileWrite.replaced,
      prior_agent_token_id: profileWrite.replaced ? profileWrite.priorAgentTokenId : undefined,
      profilePath: profileWrite.path,
      sessionCookiePath: sessionCookieFilePath(config.catalogPath),
      room: { room_id: room.room_id, room_handle: room.room_handle },
      agent: { agent_id: agent.agent_id, agent_handle: agent.agent_handle },
      agent_token_id: agentTokenId,
      secrets: "redacted; PARLE_SESSION_COOKIE and PARLE_ROOM_AGENT_TOKEN were not returned in tool output",
      next: `Set PARLE_PROFILE=${profileName} for this project, remove any direct room-binding configuration, restart the host, and run parle_status.`,
    };
  }

  async ownedAliasDelivery(params: OwnedAliasDeliveryParams, signal?: AbortSignal) {
    const config = this.config();
    const agentId = validateUUID(params.agentId, "agentId");
    const alias = validateAlias(params.alias);
    const globalPath = `/v/agents/${encodeURIComponent(agentId)}/session-aliases/${encodeURIComponent(alias)}/offline-delivery`;
    const roomPath = params.roomId
      ? `/v/rooms/${encodeURIComponent(validateUUID(params.roomId, "roomId"))}/agents/${encodeURIComponent(agentId)}/session-aliases/${encodeURIComponent(alias)}/offline-delivery`
      : undefined;
    switch (params.action) {
      case "get_global":
        return this.request(config, globalPath, { signal });
      case "get_room":
        if (!roomPath) throw new Error("parle_owned_alias_delivery get_room requires roomId.");
        return this.request(config, roomPath, { signal });
      case "set_global":
      case "set_room": {
        if (params.confirmMutation !== true || !params.reason?.trim()) throw new Error(`parle_owned_alias_delivery ${params.action} requires confirmMutation=true and a reason.`);
        if (typeof params.offlineDelivery !== "boolean") throw new Error(`parle_owned_alias_delivery ${params.action} requires offlineDelivery.`);
        const path = params.action === "set_global" ? globalPath : roomPath;
        if (!path) throw new Error("parle_owned_alias_delivery set_room requires roomId.");
        return this.request(config, path, { method: "PUT", body: { offline_delivery: params.offlineDelivery }, signal });
      }
      case "restore_everywhere":
        if (params.confirmMutation !== true || !params.reason?.trim()) throw new Error("parle_owned_alias_delivery restore_everywhere requires confirmMutation=true and a reason.");
        return this.request(config, `${globalPath}/restore-everywhere`, { method: "POST", body: {}, signal });
      default:
        throw new Error("parle_owned_alias_delivery action is invalid.");
    }
  }

  async ownedAliasRelease(params: OwnedAliasReleaseParams, signal?: AbortSignal) {
    const config = this.config();
    const agentId = validateUUID(params.agentId, "agentId");
    const alias = validateAlias(params.alias);
    const base = `/v/agents/${encodeURIComponent(agentId)}/session-aliases/${encodeURIComponent(alias)}/release`;
    if (params.action === "preview") {
      const preview = await this.request(config, `${base}/preview`, { method: "POST", body: {}, signal });
      return { ...preview, idempotencyKey: randomUUID() };
    }
    if (params.action !== "complete") throw new Error('parle_owned_alias_release action must be "preview" or "complete".');
    if (params.confirmMutation !== true || !params.reason?.trim()) throw new Error("parle_owned_alias_release complete requires confirmMutation=true and a reason.");
    if (!Number.isInteger(params.expectedAliasGeneration) || (params.expectedAliasGeneration || 0) < 1) throw new Error("parle_owned_alias_release complete requires a positive expectedAliasGeneration from preview.");
    if (!params.idempotencyKey?.trim()) throw new Error("parle_owned_alias_release complete requires the idempotencyKey returned by preview; reuse it unchanged after an ambiguous outcome.");
    try {
      return await this.request(config, `${base}/complete`, {
        method: "POST",
        headers: { "Idempotency-Key": params.idempotencyKey },
        body: { expected_alias_generation: params.expectedAliasGeneration },
        signal,
      });
    } catch (error: any) {
      const status = typeof error?.status === "number" ? error.status : undefined;
      const ambiguous = status === undefined || status === 408 || status >= 500 || (error?.retryable === true && !(status >= 400 && status < 500));
      if (!ambiguous) throw error;
      return {
        outcome: "unknown",
        idempotencyKey: params.idempotencyKey,
        replay: "Replay parle_owned_alias_release complete with the same agentId, alias, expectedAliasGeneration, and idempotencyKey. This reproduces the byte-identical core request. Do not infer current alias state.",
      };
    }
  }

  async createRoom(params: CreateRoomParams, signal?: AbortSignal) {
    if (params.confirmMutation !== true || !params.reason?.trim()) throw new Error("parle_create_room requires confirmMutation=true and a reason for POST /v/rooms.");
    if (params.kind !== "private" && params.kind !== "shared") throw new Error('parle_create_room kind must be "private" or "shared".');
    const roomHandle = params.roomHandle === undefined ? undefined : validateHandle(params.roomHandle, "parle_create_room roomHandle");
    if (params.kind === "private" && !roomHandle) throw new Error("parle_create_room requires roomHandle for a private room.");
    const base = resolveAccountBaseConfig(this.cwd, this.env);
    if (!base.sessionCookie) throw new Error(`parle_create_room requires PARLE_SESSION_COOKIE in env or .env, or a session file at ${sessionCookieFilePath(base.catalogPath)} (written by parle_login complete).`);
    const response = await this.request(base as AccountConfig, "/v/rooms", {
      method: "POST",
      body: { kind: params.kind, ...(roomHandle ? { room_handle: roomHandle } : {}) },
      signal,
    });
    if (typeof response.room_id !== "string" || response.kind !== params.kind) throw new Error("Parle room creation succeeded without the expected room_id and kind.");
    if (roomHandle && response.room_handle !== roomHandle) throw new Error("Parle room creation returned an unexpected room_handle.");
    if (params.kind === "shared" && typeof response.seat_id !== "string") throw new Error("Parle shared-room creation succeeded without an owner seat_id.");
    return { room_id: response.room_id, room_handle: response.room_handle, kind: response.kind, seat_id: response.seat_id };
  }

  async createOwnAgent(params: CreateOwnAgentParams, signal?: AbortSignal) {
    if (params.confirmMutation !== true || !params.reason?.trim()) throw new Error("parle_create_own_agent requires confirmMutation=true and a reason for POST /v/agents.");
    const agentHandle = validateHandle(params.agentHandle, "parle_create_own_agent agentHandle");
    const displayName = params.displayName?.trim();
    if (params.displayName !== undefined && !displayName) throw new Error("parle_create_own_agent displayName must not be empty when provided.");
    const config = this.config();
    const response = await this.request(config, "/v/agents", {
      method: "POST",
      body: { agent_handle: agentHandle, ...(displayName ? { display_name: displayName } : {}) },
      signal,
    });
    const agentId = validateUUID(String(response.agent_id || ""), "created agent_id");
    if (response.agent_handle !== agentHandle || typeof response.display_name !== "string" || !response.display_name) {
      throw new Error("Parle agent creation succeeded without the expected agent_id, agent_handle, and display_name.");
    }
    return { agent_id: agentId, agent_handle: response.agent_handle, display_name: response.display_name };
  }

  async deleteOwnAgent(params: DeleteOwnAgentParams, signal?: AbortSignal) {
    if (params.confirmMutation !== true || !params.reason?.trim()) throw new Error("parle_delete_own_agent requires confirmMutation=true and a reason for DELETE /v/agents/{agentID}.");
    const agentId = validateUUID(params.agentId, "agentId");
    const config = this.config();
    try {
      await this.request(config, `/v/agents/${encodeURIComponent(agentId)}`, { method: "DELETE", signal, expectNoContent: true });
      return { agent_id: agentId, http_status: 204 };
    } catch (error: any) {
      if (typeof error?.status === "number") throw error;
      return {
        agent_id: agentId,
        outcome: "unknown",
        retry_attempted: false,
        next: "Agent deletion outcome is unknown. Do not retry blindly; inspect the owned-agent inventory before taking another action.",
      };
    }
  }

  async roomParticipants(params: RoomParticipantsParams, signal?: AbortSignal) {
    const roomId = validateUUID(params.roomId, "roomId");
    const config = this.config();
    return parseRoomParticipants(await this.request(config, `/v/rooms/${encodeURIComponent(roomId)}/participants`, { signal }), roomId);
  }

  async endOwnSession(params: EndOwnSessionParams, signal?: AbortSignal) {
    if (params.confirmMutation !== true || !params.reason?.trim()) throw new Error("parle_end_own_session requires confirmMutation=true and a reason for POST /v/agent/sessions/{agentSessionID}/end.");
    const agentSessionId = validateUUID(params.agentSessionId, "agentSessionId");
    const config = this.config();
    try {
      await this.request(config, `/v/agent/sessions/${encodeURIComponent(agentSessionId)}/end`, { method: "POST", signal, expectNoContent: true });
      return { agent_session_id: agentSessionId, http_status: 204 };
    } catch (error: any) {
      if (typeof error?.status === "number" && !(error instanceof ParleAccountResponseContractError && error.status >= 200 && error.status < 300)) throw error;
      return {
        agent_session_id: agentSessionId,
        outcome: "unknown",
        retry_attempted: false,
        next: "Session end outcome is unknown. Do not retry blindly; call parle_room_participants again and inspect the roster before taking another action.",
      };
    }
  }

  async addOwnAgentSeat(params: AddOwnAgentSeatParams, signal?: AbortSignal) {
    if (params.confirmMutation !== true || !params.reason?.trim()) throw new Error("parle_add_own_agent_seat requires confirmMutation=true and a reason for POST /v/rooms/{roomID}/seats.");
    const roomId = validateUUID(params.roomId, "roomId");
    const agentId = validateUUID(params.agentId, "agentId");
    const base = resolveAccountBaseConfig(this.cwd, this.env);
    if (!base.sessionCookie) throw new Error(`parle_add_own_agent_seat requires PARLE_SESSION_COOKIE in env or .env, or a session file at ${sessionCookieFilePath(base.catalogPath)} (written by parle_login complete).`);
    const response = await this.request(base as AccountConfig, `/v/rooms/${encodeURIComponent(roomId)}/seats`, { method: "POST", body: { agent_id: agentId }, signal });
    if (typeof response.seat_id !== "string" || response.agent_id !== agentId || typeof response.admitted_at !== "string") {
      throw new Error("Parle own-agent seat admission succeeded without the expected seat_id, agent_id, and admitted_at.");
    }
    return { room_id: roomId, seat_id: response.seat_id, agent_id: response.agent_id, admitted_at: response.admitted_at };
  }

  async hardenAccount(params: HardenAccountParams) {
    // This is intentionally a direct delegation. The account-plane
    // orchestrator never launches the human-only helper or accepts a secret
    // or filesystem path; secret custody stays in hardening.ts.
    return new ParleHardeningClient({ cwd: this.cwd, env: this.env, fetch: this.fetchImpl, now: this.now }).hardenAccount(params);
  }

  async mintPrincipalInvite(params: MintPrincipalInviteParams, signal?: AbortSignal) {
    if (params.confirmMutation !== true || !params.reason?.trim()) throw new Error("parle_mint_principal_invite requires confirmMutation=true and a reason.");
    const roomId = validateUUID(params.roomId, "roomId");
    const target = normalizePersonInviteTarget(params.target);
    const config = this.config();
    const response = await this.request(config, `/v/rooms/${encodeURIComponent(roomId)}/invites/person`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: { target: target.target, offered_rights: [] },
      signal,
    });
    if (target.kind === "email") {
      if (response.status !== "accepted" || Object.keys(response).some((key) => key !== "status")) throw new Error("Parle email invitation response was not the expected privacy-flat accepted outcome.");
      return {
        status: "accepted",
        targetKind: "email",
        privacyFlat: true,
        expiresInDays: 30,
        sensitive: false,
        next: "The request was accepted without disclosing account existence or an invitation locator. Parle sends any locator out of band through the mailer; do not infer delivery or registration from this result.",
      };
    }
    const inviteId = validateUUID(String(response.invite_id || ""), "response invite_id");
    const targetPrincipalId = validateUUID(String(response.target_principal_id || ""), "response target_principal_id");
    if (response.target_kind !== "principal" || response.target_agent_id !== null || response.agent_admission !== null) {
      throw new Error("Parle person invitation response did not match the requested immutable principal target.");
    }
    if (response.secret || response.code) throw new Error("Parle target-proof invite response unexpectedly contained capability authority material.");
    const offeredRights = assertStringArray(response.offered_rights, "offered_rights");
    if (offeredRights.length !== 0) throw new Error("Parle invite response unexpectedly offered elevated room rights.");
    const display = normalizeTargetDisplay(response.target_display);
    const resolvedHandle = validateHandle(display.handle);
    if (resolvedHandle !== target.handle) throw new Error("Parle invite response target handle did not match the requested confirmation label.");
    const invitationUrl = String(response.invitation_url || "");
    if (parseInvitationReference(invitationUrl) !== inviteId) throw new Error("Parle invite response did not contain a canonical invitation URL.");
    if (typeof response.replayed !== "boolean" || typeof response.expires_at !== "string") throw new Error("Parle invite response omitted replay or expiry state.");
    return {
      inviteId,
      roomId,
      invitationUrl,
      targetKind: "principal",
      targetPrincipalId,
      targetHandle: resolvedHandle,
      offeredRights: [],
      expiresAt: response.expires_at,
      replayed: response.replayed,
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
    // ADR-0100 sole-wire hard cut: bearer capability claims are terminally
    // retired server-side (410 invite_capability_retired). Fail fast with the
    // replacement path instead of surfacing a raw protocol error. The private
    // handoff file, if any, is left untouched for the operator to remove.
    void params;
    void signal;
    throw new Error(
      "parle_claim_principal_invite is retired: ADR-0100 removed bearer capability invitations. " +
        "Use parle_accept_room_invitation with a registered-principal room invitation, " +
        "or parle_connect_own_agent for agent seats.",
    );
  }

  private async invitationStatus(config: AccountConfig, invitation: string, signal?: AbortSignal): Promise<any> {
    const inviteId = parseInvitationReference(invitation);
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
      next: "The direct principal seat is active and usable. Preview parle_connect_own_agent to select one durable agent for this connection, or pass createAgentHandle to create and connect an additional durable agent.",
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
        next: agents.length === 0 ? "Choose an explicit createAgentHandle, then preview again." : "Choose one agentId or agentHandle, or pass createAgentHandle to create and connect an additional durable agent, then preview again.",
      };
    }
    if (params.action === "preview" && !selected) {
      return {
        action: "preview", inviteId: invitation.inviteId, roomId: invitation.roomId, roomHandle: invitation.roomHandle,
        principal: "accepted", agent: "selected", proposedCreateHandle, agents,
        seat: "missing", credential: "missing", connection: "host_restart_required",
        next: "Review the deliberate additional-agent handle, then complete with explicit confirmation.",
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
        next: compatible ? "The exact agent already has a proven compatible profile. Confirm complete to return the ready binding without minting another credential, or preview again with createAgentHandle to create and connect an additional durable agent." : "Review the immutable agent selection and missing steps, then complete with explicit confirmation. To create a new durable agent instead, preview again with createAgentHandle.",
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
        next: "Use the host adapter's existing safe profile-switch lifecycle to connect. To add another durable agent, begin a new preview with createAgentHandle.",
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
    const sink = preflightNewProfile(catalogPath, profileName);
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
      const safeMessage = scrub(String(error?.message || error), [config.sessionCookie, String(tokenResponse?.token || "")]);
      return {
        action: "complete", inviteId: invitation.inviteId, roomId: invitation.roomId,
        principal: "accepted", agent: agentState, selectedAgent: selected,
        seat: "active", seatId: validateUUID(String(seat.seat_id || ""), "seat_id"),
        credential: "publication_failed", connection: "host_restart_required", profile: profileName,
        ...(candidateTokenId ? { agent_token_id: candidateTokenId } : {}),
        credential_cleanup: "not_attempted",
        publication_error: safeMessage,
        next: "Credential publication failed. No automatic cleanup was attempted. Do not retry until safe token metadata is inspected and any revoke uses the explicit confirmed canonical operation.",
      };
    }
    return {
      action: "complete", inviteId: invitation.inviteId, roomId: invitation.roomId,
      principal: "accepted", agent: agentState, selectedAgent: selected,
      seat: "active", seatId: validateUUID(String(seat.seat_id || ""), "seat_id"),
      credential: "profile_ready", connection: "profile_ready", profile: profileName,
      next: "Use the host adapter's existing safe profile-switch lifecycle to connect. To add another durable agent, begin a new preview with createAgentHandle.",
    };
  }
}
