import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { DEFAULT_VERSION } from "./protocol.js";
import { CredentialProfile, loadProfile, parseProfiles, profileCatalogHasProfile, resolveProfileCatalogPath } from "./profiles.js";
import { ParleHardeningClient, type HardenAccountParams } from "./hardening.js";
import { assertSafeBase, truncateText } from "./helpers.js";

const DEFAULT_API_BASE = "https://api.parle.sh";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_HANDOFF_BYTES = 32 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE_SECRET_RE = /^parle_inv_\S{16,256}$/;
const INVITE_CODE_RE = /^[A-Z0-9]{6,32}$/;
const RESERVED_HANDLES = new Set(["admin", "agent", "agents", "api", "me", "null", "parle", "room", "rooms", "root", "support", "system", "www"]);
const MINT_DENIAL_NEXT_ACTION = {
  unhardened: "set a password, then enroll a second factor",
  cooldown: "wait for the post-recovery cooldown to lapse",
  account_restricted: "this account cannot expand its reach right now",
} as const;

export type AccountFetch = typeof fetch;

export type AccountClientOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetch?: AccountFetch;
  now?: () => Date;
};

export type MintPrincipalInviteParams = {
  roomId: string;
  principalId?: string;
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

export type LoginParams = {
  action?: "start" | "complete" | "mint-from-session";
  email?: string;
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

export type AddOwnAgentSeatParams = {
  roomId: string;
  agentId: string;
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

function resolveAccountBaseConfig(cwd: string, env: Record<string, string | undefined>): AccountBaseConfig {
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
  if (sessionCookie && /\r|\n/.test(sessionCookie)) throw new Error("Parle human session cookie contains invalid control characters.");
  let configuredApiBase = firstValue("PARLE_API_BASE", env, dotEnv);
  let selectedProfile: CredentialProfile | undefined;
  if (existsSync(catalogPath)) {
    const profileName = firstValue("PARLE_PROFILE", env, dotEnv) || (profileCatalogHasProfile("default", catalogPath) ? "default" : undefined);
    if (profileName) selectedProfile = loadProfile(profileName, catalogPath);
  }
  if (!configuredApiBase && selectedProfile) configuredApiBase = selectedProfile.apiBase;
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

function validateHandle(raw: string, label = "principalHandle"): string {
  const value = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,18}[a-z0-9]$/.test(value) || /-{2}/.test(value) || RESERVED_HANDLES.has(value)) {
    throw new Error(`${label} must normalize to an unreserved 2-20 character handle using lowercase letters, digits, and hyphens with no leading, trailing, or consecutive hyphens.`);
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

function sessionCookieFilePath(catalogPath: string): string {
  return join(dirname(catalogPath), "session");
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

function writeSessionCookieFile(catalogPath: string, cookie: string): string {
  const directory = ensureProfileDirectory(catalogPath);
  const path = sessionCookieFilePath(catalogPath);
  const writePath = safeProfileWritePath(join(directory, basename(path)));
  const tempPath = join(dirname(writePath), `.session.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, `${cookie}\n`, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") chmodSync(tempPath, 0o600);
    if (ensureProfileDirectory(catalogPath) !== directory) throw new Error("Parle credential directory changed during session persistence.");
    safeProfileWritePath(writePath);
    renameSync(tempPath, writePath);
    if (process.platform !== "win32") chmodSync(writePath, 0o600);
  } finally { try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {} }
  return path;
}

function profileSectionRange(text: string, label: string): { start: number; end: number } | undefined {
  const headers: Array<{ label: string; start: number }> = [];
  const lineRe = /(?:^|(?<=\n))[^\n]*(?:\n|$)/g;
  for (const match of text.matchAll(lineRe)) {
    const raw = match[0].replace(/\r?\n$/, "");
    const section = raw.trim().match(/^\[([^\]\r\n]+)\]$/);
    if (section) headers.push({ label: section[1], start: match.index! });
  }
  const index = headers.findIndex((header) => header.label === label);
  return index < 0 ? undefined : { start: headers[index].start, end: headers[index + 1]?.start ?? text.length };
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
  const lockPath = `${writePath}.lock`;
  let lock: number | undefined;
  try {
    try {
      lock = openSync(lockPath, "wx", 0o600);
    } catch (error: any) {
      if (error?.code === "EEXIST") throw new Error(`Parle profile catalog is locked at ${lockPath}. Retry after the active writer finishes. If no writer is active, inspect and remove the stale lock manually.`);
      throw error;
    }
    const original = existsSync(writePath) ? readFileSync(writePath, "utf8") : "";
    const profiles = original ? parseProfiles(original, catalogPath) : new Map<string, CredentialProfile>();
    const range = profileSectionRange(original, profile.name);
    if (range && !force) throw new Error(`Parle profile ${profile.name} already exists in ${catalogPath}. Pass force=true to replace only that profile.`);
    const section = renderProfile(profile);
    const updated = range
      ? original.slice(0, range.start) + section + original.slice(range.end)
      : original + (original.length === 0 || original.endsWith("\n") ? "" : "\n") + section;
    parseProfiles(updated, catalogPath);
    const tempPath = join(dirname(writePath), `.profiles.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(tempPath, updated, { mode: 0o600, flag: "wx" });
      if (process.platform !== "win32") chmodSync(tempPath, 0o600);
      if (ensureProfileDirectory(catalogPath) !== directory) throw new Error("Parle credential directory changed during profile persistence.");
      safeProfileWritePath(writePath);
      renameSync(tempPath, writePath);
      if (process.platform !== "win32") chmodSync(writePath, 0o600);
    } finally { try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {} }
    return { path: catalogPath, replaced: Boolean(range), priorAgentTokenId: profiles.get(profile.name)?.agentTokenId };
  } finally {
    if (lock !== undefined) {
      closeSync(lock);
      try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch {}
    }
  }
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
  const lockPath = `${path}.lock`;
  let lock: number | undefined;
  try {
    try {
      lock = openSync(lockPath, "wx", 0o600);
    } catch (error: any) {
      if (error?.code === "EEXIST") throw new Error(`Parle profile catalog is locked at ${lockPath}. Retry after the active writer finishes. If no writer is active, inspect and remove the stale lock manually.`);
      throw error;
    }
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current !== original) throw new Error("Parle profile catalog changed after preflight. No credential was published.");
    const profiles = current ? parseProfiles(current, path) : new Map<string, CredentialProfile>();
    if (profiles.has(profile.name)) throw new Error(`Parle profile ${profile.name} already exists. No existing profile is replaced by this workflow.`);
    const updated = current + (current.length === 0 || current.endsWith("\n") ? "" : "\n") + renderProfile(profile);
    parseProfiles(updated, path);
    const tempPath = join(dirname(path), `.profiles.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(tempPath, updated, { mode: 0o600, flag: "wx" });
      if (process.platform !== "win32") chmodSync(tempPath, 0o600);
      ensureProfileDirectory(path);
      safeProfileWritePath(path);
      renameSync(tempPath, path);
      if (process.platform !== "win32") chmodSync(path, 0o600);
    } finally { try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {} }
  } finally {
    if (lock !== undefined) {
      closeSync(lock);
      try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch {}
    }
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

function extractSessionCookie(headers: Headers): string | undefined {
  const getSetCookie = (headers as any).getSetCookie;
  const values = typeof getSetCookie === "function" ? getSetCookie.call(headers) : [headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const match = value.match(/(?:^|,\s*)(__Host-parle_session=[^;,\s]+)/);
    if (match) return match[1];
  }
  return undefined;
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
      const rawReason = typeof error.reason === "string" ? error.reason : "";
      const expectedNextAction = MINT_DENIAL_NEXT_ACTION[rawReason as keyof typeof MINT_DENIAL_NEXT_ACTION];
      const denialIsRecognized = Boolean(response.status === 403 && error.code === "forbidden" && expectedNextAction && error.unlock === expectedNextAction);
      const baseMessage = scrub(String(error.message || text || response.statusText), [config.sessionCookie, ...(options.secrets || [])]).slice(0, 4096);
      const message = denialIsRecognized ? `${baseMessage}. Reason: ${rawReason}. Next action: ${expectedNextAction}` : baseMessage;
      const raised: any = new Error(`Parle API ${response.status}: ${message}`);
      raised.status = response.status;
      raised.code = typeof error.code === "string" ? error.code : undefined;
      if (denialIsRecognized) {
        raised.reason = rawReason;
        raised.nextAction = expectedNextAction;
      }
      throw raised;
    }
    if (!json || typeof json !== "object") throw new Error("Parle API returned an invalid JSON response.");
    return json;
  }

  private async emailRequest(config: AccountBaseConfig, path: string, body: Record<string, string>, signal?: AbortSignal): Promise<{ json: any; headers: Headers }> {
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
    return { json: parseJson(text) || {}, headers: response.headers };
  }

  async login(params: LoginParams, signal?: AbortSignal) {
    const action = params.action || (params.code ? "complete" : "start");
    if (action !== "start" && (params.confirmMutation !== true || !params.reason?.trim())) throw new Error(`parle_login ${action} requires confirmMutation=true and a reason before persisting credentials or minting a token.`);
    const config = resolveAccountBaseConfig(this.cwd, this.env);
    const writeCredentials = params.writeCredentials !== false;
    const profileName = params.profile || "default";

    if (action === "start") {
      if (!params.email) throw new Error("parle_login start requires email.");
      await this.emailRequest(config, "/v/auth/email/start", { email: params.email }, signal);
      return {
        status: "code_requested",
        email: params.email,
        next: "Call parle_login again with the same email and the code. The complete step will capture Set-Cookie and save local credentials without printing secrets.",
      };
    }

    let sessionCookie = config.sessionCookie;
    if (action === "complete") {
      if (!params.email) throw new Error("parle_login complete requires email.");
      if (!params.code) throw new Error("parle_login complete requires code.");
      if (!writeCredentials) throw new Error("parle_login complete refuses writeCredentials=false because it would consume a one-time code without durable credential recovery.");
      preflightProfileWrite(profileName, params.force === true, config.catalogPath);
      const completed = await this.emailRequest(config, "/v/auth/email/complete", { email: params.email, code: params.code }, signal);
      sessionCookie = extractSessionCookie(completed.headers);
      if (!sessionCookie) throw new Error("Parle email login completed but no __Host-parle_session Set-Cookie header was present. Credential persistence cannot continue safely.");
      writeSessionCookieFile(config.catalogPath, sessionCookie);
    } else if (action === "mint-from-session") {
      if (!writeCredentials) throw new Error("parle_login mint-from-session refuses writeCredentials=false because it would mint a plaintext token without durable credential recovery.");
      preflightProfileWrite(profileName, params.force === true, config.catalogPath);
      if (!sessionCookie) throw new Error(`parle_login mint-from-session requires PARLE_SESSION_COOKIE in env or .env, or a session file at ${sessionCookieFilePath(config.catalogPath)} (written by parle_login complete).`);
    } else {
      throw new Error(`Unknown parle_login action: ${action}`);
    }

    const authenticated = { ...config, sessionCookie } as AccountConfig;
    const roomsBody = await this.request(authenticated, "/v/rooms", { signal });
    const agentsBody = await this.request(authenticated, "/v/agents", { signal });
    const rooms = Array.isArray(roomsBody?.rooms) ? roomsBody.rooms : Array.isArray(roomsBody) ? roomsBody : [];
    const agents = Array.isArray(agentsBody?.agents) ? agentsBody.agents : Array.isArray(agentsBody) ? agentsBody : [];
    const roomId = params.roomId || (params.roomHandle ? undefined : config.roomId);
    const roomHandle = params.roomHandle || (params.roomId ? undefined : config.roomHandle);
    const agentId = params.agentId || (params.agentHandle ? undefined : config.agentId);
    const agentHandle = params.agentHandle || (params.agentId ? undefined : config.agentHandle);
    const room = chooseInventoryItem(rooms, "room_id", "room_handle", "room", roomId, roomHandle);
    const agent = chooseInventoryItem(agents, "agent_id", "agent_handle", "agent", agentId, agentHandle);
    if (!room || !agent) {
      return {
        status: "selection_required",
        wroteSessionCookie: writeCredentials && action === "complete",
        rooms: publicInventory(rooms, "room_id", "room_handle"),
        agents: publicInventory(agents, "agent_id", "agent_handle"),
        next: "Call parle_login with action:'mint-from-session' and either roomId or roomHandle plus either agentId or agentHandle. The session cookie has been saved if writeCredentials was enabled.",
      };
    }

    const tokenBody = await this.request(authenticated, `/v/agents/${encodeURIComponent(agent.agent_id)}/tokens`, {
      method: "POST",
      body: { room_id: room.room_id },
      signal,
    });
    const token = tokenBody?.token;
    if (!token) throw new Error("Parle token mint succeeded without returning a plaintext token; local credentials were not updated with an agent token.");
    if (action === "mint-from-session") writeSessionCookieFile(config.catalogPath, sessionCookie!);
    const profileWrite = writeProfile({
      name: profileName,
      roomId: room.room_id,
      agentToken: token,
      agentTokenId: tokenBody.agent_token_id,
      apiBase: config.apiBase || DEFAULT_API_BASE,
      wakeBase: config.wakeBase,
    }, params.force === true, config.catalogPath);
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
      agent_token_id: tokenBody.agent_token_id,
      secrets: "redacted; PARLE_SESSION_COOKIE and PARLE_ROOM_AGENT_TOKEN were not returned in tool output",
      next: `Set PARLE_PROFILE=${profileName} for this project, remove any direct room-binding configuration, restart the host, and run parle_status.`,
    };
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
    const principalId = params.principalId === undefined ? undefined : validateUUID(params.principalId, "principalId");
    const principalHandle = validateHandle(params.principalHandle);
    const target = {
      kind: "principal",
      principal_handle: principalHandle,
      ...(principalId ? { principal_id: principalId } : {}),
    };
    const config = this.config();
    const response = await this.request(config, `/v/rooms/${encodeURIComponent(roomId)}/invites`, {
      method: "POST",
      body: { claim_mode: "target_session", seat_type: "principal", target },
      signal,
    });
    const inviteId = validateUUID(String(response.invite_id || ""), "response invite_id");
    const responseRoomId = validateUUID(String(response.room_id || ""), "response room_id");
    const targetPrincipalId = validateUUID(String(response.target_principal_id || ""), "response target_principal_id");
    if (responseRoomId !== roomId || (principalId && targetPrincipalId !== principalId) || response.seat_type !== "principal" || response.claim_mode !== "target_session") {
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
      next: "Use the host adapter's existing safe profile-switch lifecycle to connect. To add another durable agent, begin a new preview with createAgentHandle.",
    };
  }
}
