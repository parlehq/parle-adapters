import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROFILE_CATALOG_PATH = join(homedir(), ".parle", "profiles");

export function profileCatalogPath(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(home, ".parle", "profiles");
}

export function profileCatalogPaths(cwd = process.cwd(), env: Record<string, string | undefined> = process.env): string[] {
  const paths = [profileCatalogPath(env), join(cwd, ".parle", "profiles")];
  return [...new Set(paths)];
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

function assertSafeCatalog(path: string): void {
  const link = lstatSync(path);
  const stat = link.isSymbolicLink() ? statSync(path) : link;
  if (!stat.isFile()) throw new ProfileConfigError(`Parle profile catalog must be a regular file: ${path}`);
  if (process.platform !== "win32" && stat.uid !== process.getuid?.()) throw new ProfileConfigError(`Parle profile catalog must be owned by the current user: ${path}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) console.warn(`Parle warning: profile catalog should be mode 0600: ${path}`);
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

export function profileCatalogExists(path: string | string[] = PROFILE_CATALOG_PATH): boolean {
  const paths = Array.isArray(path) ? path : [path];
  return paths.some((candidate) => existsSync(candidate));
}

export function profileCatalogHasProfile(name: string, path: string | string[] = PROFILE_CATALOG_PATH): boolean {
  const paths = Array.isArray(path) ? path : [path];
  for (const candidate of paths) {
    if (!existsSync(candidate)) continue;
    assertSafeCatalog(candidate);
    if (parseProfiles(readFileSync(candidate, "utf8"), candidate).has(name)) return true;
  }
  return false;
}

export function loadProfile(name: string, path: string | string[] = PROFILE_CATALOG_PATH): CredentialProfile {
  const paths = Array.isArray(path) ? path : [path];
  const seenCatalogs: string[] = [];
  const availableProfiles: string[] = [];
  for (const candidate of paths) {
    if (!existsSync(candidate)) continue;
    seenCatalogs.push(candidate);
    assertSafeCatalog(candidate);
    const profiles = parseProfiles(readFileSync(candidate, "utf8"), candidate);
    const profile = profiles.get(name);
    if (profile) return profile;
    availableProfiles.push(...profiles.keys());
  }
  if (seenCatalogs.length === 0) {
    throw new ProfileConfigError(`Parle profile catalog is missing: ${paths.join(", ")}. Create one with [${name}], room_id, and agent_token.`);
  }
  const available = [...new Set(availableProfiles)].join(", ") || "none";
  throw new ProfileConfigError(`Parle profile ${name} was not found in ${seenCatalogs.join(", ")}. Available profiles: ${available}`);
}
