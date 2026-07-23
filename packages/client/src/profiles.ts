import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const PROFILE_CATALOG_PATH = join(homedir(), ".parle", "profiles");

export function profileCatalogPath(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(home, ".parle", "profiles");
}

// Exactly one catalog per process. PARLE_PROFILES_PATH (a non-secret setting,
// resolved like PARLE_PROFILE: process env then project .env) REPLACES the
// default path entirely; there is no layering or merging of catalogs. A
// relative override resolves against the project cwd.
export function resolveProfileCatalogPath(override: string | undefined, cwd = process.cwd(), env: Record<string, string | undefined> = process.env): string {
  if (override) return isAbsolute(override) ? override : join(cwd, override);
  return profileCatalogPath(env);
}

// Warn-only guard for the original .parle/credentials hazard: an operator may
// point PARLE_PROFILES_PATH inside a repo deliberately, but the catalog must
// never enter version control. git check-ignore is authoritative and cheap;
// any git failure (not a work tree, git absent) means no warning.
export function catalogGitExposureWarning(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: dirname(path), stdio: "ignore" });
    return undefined;
  } catch (error: any) {
    if (error?.status === 1) {
      return `Parle profile catalog ${path} is inside a git work tree and not git-ignored. Add it to .gitignore so agent tokens can never enter version control.`;
    }
    return undefined;
  }
}

export type CredentialProfile = {
  name: string;
  roomId: string;
  agentToken: string;
  agentTokenId?: string;
  apiBase?: string;
  wakeBase?: string;
};

export class ProfileConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileConfigError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_KEYS = new Set(["room_id", "agent_token", "agent_token_id", "api_base", "wake_base"]);

function catalogAccessError(path: string, operation: string, error: unknown): ProfileConfigError {
  const code = typeof (error as any)?.code === "string" ? ` (${(error as any).code})` : "";
  return new ProfileConfigError(`Parle profile catalog cannot be ${operation}: ${path}${code}. Check that the catalog and its parent directories are accessible to the current user.`);
}

function inspectCatalog(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
    throw catalogAccessError(path, "inspected", error);
  }
}

function assertSafeCatalog(path: string, link: Stats): void {
  let stat: Stats;
  try {
    stat = link.isSymbolicLink() ? statSync(path) : link;
  } catch (error) {
    throw catalogAccessError(path, "inspected", error);
  }
  if (!stat.isFile()) throw new ProfileConfigError(`Parle profile catalog must be a regular file: ${path}`);
  if (process.platform !== "win32" && stat.uid !== process.getuid?.()) throw new ProfileConfigError(`Parle profile catalog must be owned by the current user: ${path}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) console.warn(`Parle warning: profile catalog should be mode 0600: ${path}`);
}

function readCatalog(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw catalogAccessError(path, "read", error);
  }
}

export function parseProfiles(text: string, path = PROFILE_CATALOG_PATH): Map<string, CredentialProfile> {
  const sections = new Map<string, Record<string, string>>();
  let current: string | undefined;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[([^\]\r\n]+)\]$/);
    if (section) {
      current = section[1];
      if (sections.has(current)) throw new ProfileConfigError(`${path}:${index + 1}: duplicate profile ${current}`);
      sections.set(current, {});
      continue;
    }
    const equals = line.indexOf("=");
    if (!current || equals <= 0) throw new ProfileConfigError(`${path}:${index + 1}: expected a profile section or key=value`);
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (!ALLOWED_KEYS.has(key)) throw new ProfileConfigError(`${path}:${index + 1}: unknown profile key ${key}`);
    if (!value) throw new ProfileConfigError(`${path}:${index + 1}: ${key} must not be empty`);
    const fields = sections.get(current)!;
    if (fields[key] !== undefined) throw new ProfileConfigError(`${path}:${index + 1}: duplicate ${key} in profile ${current}`);
    fields[key] = value;
  }
  const profiles = new Map<string, CredentialProfile>();
  for (const [name, fields] of sections) {
    if (!fields.room_id) throw new ProfileConfigError(`${path}: profile ${name} is missing room_id`);
    if (!UUID_RE.test(fields.room_id)) throw new ProfileConfigError(`${path}: profile ${name} has an invalid room_id`);
    if (!fields.agent_token) throw new ProfileConfigError(`${path}: profile ${name} is missing agent_token`);
    if (!/^parle_agt_\S+$/.test(fields.agent_token)) throw new ProfileConfigError(`${path}: profile ${name} has an invalid agent_token`);
    if (fields.agent_token_id && !UUID_RE.test(fields.agent_token_id)) throw new ProfileConfigError(`${path}: profile ${name} has an invalid agent_token_id`);
    profiles.set(name, { name, roomId: fields.room_id, agentToken: fields.agent_token, agentTokenId: fields.agent_token_id, apiBase: fields.api_base, wakeBase: fields.wake_base });
  }
  return profiles;
}

export function profileCatalogExists(path: string = PROFILE_CATALOG_PATH): boolean {
  return inspectCatalog(path) !== undefined;
}

export function profileCatalogHasProfile(name: string, path: string = PROFILE_CATALOG_PATH): boolean {
  const link = inspectCatalog(path);
  if (!link) return false;
  assertSafeCatalog(path, link);
  return parseProfiles(readCatalog(path), path).has(name);
}

export function loadProfile(name: string, path: string = PROFILE_CATALOG_PATH): CredentialProfile {
  const link = inspectCatalog(path);
  if (!link) {
    throw new ProfileConfigError(`Parle profile catalog is missing: ${path}. Create one with [${name}], room_id, and agent_token.`);
  }
  assertSafeCatalog(path, link);
  const profiles = parseProfiles(readCatalog(path), path);
  const profile = profiles.get(name);
  if (profile) return profile;
  const available = [...profiles.keys()].join(", ") || "none";
  throw new ProfileConfigError(`Parle profile ${name} was not found in ${path}. Available profiles: ${available}`);
}
