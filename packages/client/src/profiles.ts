import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROFILE_CATALOG_PATH = join(homedir(), ".parle", "profiles");

export function profileCatalogPath(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(home, ".parle", "profiles");
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
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new ProfileConfigError(`Parle profile catalog must be a regular file: ${path}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new ProfileConfigError(`Parle profile catalog must be mode 0600: ${path}. Run chmod 600 ${path}`);
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

export function profileCatalogExists(path = PROFILE_CATALOG_PATH): boolean {
  return existsSync(path);
}

export function loadProfile(name: string, path = PROFILE_CATALOG_PATH): CredentialProfile {
  if (!existsSync(path)) throw new ProfileConfigError(`Parle profile catalog is missing: ${path}. Create it with [${name}], room_id, and agent_token.`);
  assertSafeCatalog(path);
  const profiles = parseProfiles(readFileSync(path, "utf8"), path);
  const profile = profiles.get(name);
  if (profile) return profile;
  const available = [...profiles.keys()].join(", ") || "none";
  throw new ProfileConfigError(`Parle profile ${name} was not found in ${path}. Available profiles: ${available}`);
}
