import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { SafeFileError, atomicReplaceOwnerOnlyFile, readOwnerOnlyTextFile, withOwnerOnlyFileLock } from "./safe-file.js";

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

export type DeleteProfileParams = {
  profile: string;
  confirmMutation?: boolean;
  reason?: string;
};

export type DeleteProfileOptions = {
  catalogPath: string;
  protectedProfiles?: Iterable<string>;
};

export const PROFILE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PROFILE_CATALOG_BYTES = 1024 * 1024;

export class ProfileDeletionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProfileDeletionError";
    this.code = code;
  }
}

export class ProfileConfigError extends Error {
  readonly code: string;

  constructor(message: string, code = "profile_config_error") {
    super(message);
    this.name = "ProfileConfigError";
    this.code = code;
  }
}

export class ProfileNotFoundError extends ProfileConfigError {
  readonly selector: string;
  readonly availableProfiles: string[];

  constructor(selector: string, availableProfiles: string[], path: string) {
    const available = availableProfiles.join(", ") || "none";
    super(`Parle profile ${selector} was not found in ${path}. Available profiles: ${available}`, "profile_not_found");
    this.name = "ProfileNotFoundError";
    this.selector = selector;
    this.availableProfiles = availableProfiles;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_KEYS = new Set(["room_id", "agent_token", "agent_token_id", "api_base", "wake_base"]);

export function profileSectionRange(text: string, label: string): { start: number; end: number } | undefined {
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

function assertSafeCatalog(path: string, link: Stats, modeWarning: (message: string) => void = console.warn): void {
  let stat: Stats;
  try {
    stat = link.isSymbolicLink() ? statSync(path) : link;
  } catch (error) {
    throw catalogAccessError(path, "inspected", error);
  }
  if (!stat.isFile()) throw new ProfileConfigError(`Parle profile catalog must be a regular file: ${path}`);
  if (process.platform !== "win32" && stat.uid !== process.getuid?.()) throw new ProfileConfigError(`Parle profile catalog must be owned by the current user: ${path}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) modeWarning(`Parle warning: profile catalog should be mode 0600: ${path}`);
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

export function readProfiles(path: string = PROFILE_CATALOG_PATH, options: { modeWarning?: (message: string) => void } = {}): Map<string, CredentialProfile> {
  const link = inspectCatalog(path);
  if (!link) throw new ProfileConfigError(`Parle profile catalog is missing: ${path}.`);
  assertSafeCatalog(path, link, options.modeWarning);
  return parseProfiles(readCatalog(path), path);
}

export function profileCatalogHasProfile(name: string, path: string = PROFILE_CATALOG_PATH): boolean {
  const link = inspectCatalog(path);
  if (!link) return false;
  assertSafeCatalog(path, link);
  return parseProfiles(readCatalog(path), path).has(name);
}

export function deleteProfile(params: DeleteProfileParams, options: DeleteProfileOptions): { profile: string; removed: boolean } {
  const profile = typeof params.profile === "string" ? params.profile.trim() : "";
  if (!PROFILE_LABEL_RE.test(profile)) {
    throw new ProfileDeletionError("profile_delete_invalid", "Parle profile must be 1 to 64 characters and contain only letters, numbers, dot, underscore, or hyphen, starting with a letter or number.");
  }
  if (params.confirmMutation !== true || !params.reason?.trim()) {
    throw new ProfileDeletionError("profile_delete_confirmation_required", "parle_delete_profile requires confirmMutation=true and a reason.");
  }
  const protectedProfiles = new Set(options.protectedProfiles || []);
  try {
    if (!inspectCatalog(options.catalogPath)) return { profile, removed: false };
    return withOwnerOnlyFileLock(options.catalogPath, { label: "Parle profile catalog", durability: "none" }, () => {
      if (!inspectCatalog(options.catalogPath)) return { profile, removed: false };
      const original = readOwnerOnlyTextFile(options.catalogPath, { label: "Parle profile catalog", maxBytes: MAX_PROFILE_CATALOG_BYTES, modePolicy: "ignore" });
      const profiles = parseProfiles(original, "Parle profile catalog");
      const range = profileSectionRange(original, profile);
      if (!profiles.has(profile) || !range) return { profile, removed: false };
      if (protectedProfiles.has(profile)) {
        throw new ProfileDeletionError("profile_delete_active", `Parle profile ${profile} is bound by the calling client and cannot be deleted.`);
      }
      const updated = original.slice(0, range.start) + original.slice(range.end);
      parseProfiles(updated, "Parle profile catalog");
      atomicReplaceOwnerOnlyFile(options.catalogPath, updated, {
        label: "Parle profile catalog",
        maxBytes: MAX_PROFILE_CATALOG_BYTES,
        durability: "best-effort",
        existingMode: "replace",
      });
      return { profile, removed: true };
    });
  } catch (error) {
    if (error instanceof ProfileDeletionError) throw error;
    if (error instanceof SafeFileError && error.code === "lock_contended") {
      throw new ProfileDeletionError("profile_delete_lock_contended", `Parle profile ${profile} could not be deleted because another writer holds the catalog lock. Retry with a fresh confirmed action.`);
    }
    throw new ProfileDeletionError("profile_delete_failed", `Parle profile ${profile} could not be deleted safely.`);
  }
}

export function loadProfile(name: string, path: string = PROFILE_CATALOG_PATH): CredentialProfile {
  let profiles: Map<string, CredentialProfile>;
  try {
    profiles = readProfiles(path);
  } catch (error) {
    if (error instanceof ProfileConfigError && error.message.startsWith("Parle profile catalog is missing:")) {
      throw new ProfileConfigError(`Parle profile catalog is missing: ${path}. Create one with [${name}], room_id, and agent_token.`);
    }
    throw error;
  }
  const profile = profiles.get(name);
  if (profile) return profile;
  throw new ProfileNotFoundError(name, [...profiles.keys()], path);
}
