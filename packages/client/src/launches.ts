import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROFILE_CATALOG_PATH, resolveProfileCatalogPath } from "./profiles.js";
import { ADDRESS_HANDLE_MIN_LENGTH, ADDRESS_HANDLE_PATTERN, SESSION_ALIAS_MAX_LENGTH } from "./protocol.js";
import { atomicReplaceOwnerOnlyFile, ensureOwnerOnlyDirectory, readOwnerOnlyTextFile, withOwnerOnlyFileLock } from "./safe-file.js";

export const SAVED_START_CATALOG_MAX_BYTES = 256 * 1024;
export const SAVED_START_NEXT_MAX_BYTES = 16 * 1024;
export const SAVED_START_CATALOG_PATH = join(dirname(PROFILE_CATALOG_PATH), "launches");

const LABEL = "Parle saved-start catalog";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ALLOWED_KEYS = new Set(["profile", "alias", "next"]);
const RESERVED_SAVED_START_NAMES = new Set(["list", "show", "save", "delete"]);

export type SavedStart = {
  name: string;
  profile?: string;
  alias?: string;
  next?: string;
};

export type SavedStartStep =
  | { action: "switch_profile"; profile: string }
  | { action: "claim_alias"; alias: string }
  | { action: "host_instruction"; next: string };

export class SavedStartConfigError extends Error {
  readonly code: string;

  constructor(message: string, code = "saved_start_config_error") {
    super(message);
    this.name = "SavedStartConfigError";
    this.code = code;
  }
}

export class SavedStartNotFoundError extends SavedStartConfigError {
  readonly selector: string;
  readonly availableSavedStarts: string[];

  constructor(selector: string, availableSavedStarts: string[], path: string) {
    const guidance = availableSavedStarts.length
      ? `Available saved starts:\n${availableSavedStarts.map((name) => `- ${name}`).join("\n")}`
      : "No saved starts are configured.";
    super(`Parle saved start ${selector} was not found in ${path}.\n${guidance}`, "saved_start_not_found");
    this.name = "SavedStartNotFoundError";
    this.selector = selector;
    this.availableSavedStarts = availableSavedStarts;
  }
}

export function savedStartCatalogPath(profileCatalogPath: string = PROFILE_CATALOG_PATH): string {
  return join(dirname(profileCatalogPath), "launches");
}

export function resolveSavedStartCatalogPath(cwd: string = process.cwd(), env: Record<string, string | undefined> = process.env): string {
  let projectOverride: string | undefined;
  const dotEnvPath = join(cwd, ".env");
  if (existsSync(dotEnvPath)) {
    for (const raw of readFileSync(dotEnvPath, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const equals = line.indexOf("=");
      if (equals < 0 || line.slice(0, equals).trim() !== "PARLE_PROFILES_PATH") continue;
      let value = line.slice(equals + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (value) projectOverride = value;
      break;
    }
  }
  const profileCatalog = resolveProfileCatalogPath(env.PARLE_PROFILES_PATH || projectOverride, cwd, env);
  return savedStartCatalogPath(profileCatalog);
}

function assertName(value: string, label: string): void {
  if (!NAME_RE.test(value)) {
    throw new SavedStartConfigError(`${label} must be 1 to 64 characters and contain only letters, numbers, dot, underscore, or hyphen, starting with a letter or number.`);
  }
}

function assertValue(value: string, label: string): void {
  if (!value) throw new SavedStartConfigError(`${label} must not be empty.`);
  if (/\r|\n/.test(value)) throw new SavedStartConfigError(`${label} must fit on one line.`);
}

function validateSavedStart(start: SavedStart): SavedStart {
  assertName(start.name, "Parle saved-start name");
  if (RESERVED_SAVED_START_NAMES.has(start.name)) {
    throw new SavedStartConfigError(`Parle saved-start name ${start.name} is reserved for saved-start management.`);
  }
  if (start.profile !== undefined) {
    assertValue(start.profile, `Parle saved start ${start.name} profile`);
    assertName(start.profile, `Parle saved start ${start.name} profile`);
  }
  if (start.alias !== undefined) {
    assertValue(start.alias, `Parle saved start ${start.name} alias`);
    if (start.alias.length < ADDRESS_HANDLE_MIN_LENGTH || start.alias.length > SESSION_ALIAS_MAX_LENGTH || !ADDRESS_HANDLE_PATTERN.test(start.alias)) {
      throw new SavedStartConfigError(`Parle saved start ${start.name} alias must be 2 to 32 lowercase letters, digits, and single hyphens.`);
    }
  }
  if (start.next !== undefined) {
    assertValue(start.next, `Parle saved start ${start.name} next`);
    if (Buffer.byteLength(start.next, "utf8") > SAVED_START_NEXT_MAX_BYTES) {
      throw new SavedStartConfigError(`Parle saved start ${start.name} next exceeds ${SAVED_START_NEXT_MAX_BYTES} bytes.`);
    }
  }
  return { name: start.name, ...(start.profile ? { profile: start.profile } : {}), ...(start.alias ? { alias: start.alias } : {}), ...(start.next ? { next: start.next } : {}) };
}

export function savedStartPlan(start: SavedStart): SavedStartStep[] {
  const normalized = validateSavedStart(start);
  return [
    ...(normalized.profile ? [{ action: "switch_profile" as const, profile: normalized.profile }] : []),
    ...(normalized.alias ? [{ action: "claim_alias" as const, alias: normalized.alias }] : []),
    ...(normalized.next ? [{ action: "host_instruction" as const, next: normalized.next }] : []),
  ];
}

export function parseSavedStarts(text: string, path: string = SAVED_START_CATALOG_PATH): Map<string, SavedStart> {
  const sections = new Map<string, Record<string, string>>();
  let current: string | undefined;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[([^\]\r\n]+)\]$/);
    if (section) {
      current = section[1];
      assertName(current, `${path}:${index + 1}: saved-start name`);
      if (sections.has(current)) throw new SavedStartConfigError(`${path}:${index + 1}: duplicate saved start ${current}`);
      sections.set(current, {});
      continue;
    }
    const equals = line.indexOf("=");
    if (!current || equals <= 0) throw new SavedStartConfigError(`${path}:${index + 1}: expected a saved-start section or key=value`);
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (!ALLOWED_KEYS.has(key)) throw new SavedStartConfigError(`${path}:${index + 1}: unknown saved-start key ${key}`);
    if (!value) throw new SavedStartConfigError(`${path}:${index + 1}: ${key} must not be empty`);
    const fields = sections.get(current)!;
    if (fields[key] !== undefined) throw new SavedStartConfigError(`${path}:${index + 1}: duplicate ${key} in saved start ${current}`);
    fields[key] = value;
  }

  const starts = new Map<string, SavedStart>();
  for (const [name, fields] of sections) {
    starts.set(name, validateSavedStart({ name, profile: fields.profile, alias: fields.alias, next: fields.next }));
  }
  return starts;
}

export function serializeSavedStarts(starts: Iterable<SavedStart>): string {
  const normalized = [...starts].map(validateSavedStart).sort((left, right) => left.name.localeCompare(right.name));
  return normalized.map((start) => [
    `[${start.name}]`,
    ...(start.profile ? [`profile = ${start.profile}`] : []),
    ...(start.alias ? [`alias = ${start.alias}`] : []),
    ...(start.next ? [`next = ${start.next}`] : []),
  ].join("\n")).join("\n\n") + (normalized.length ? "\n" : "");
}

function savedStartCatalogExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw new SavedStartConfigError(`Parle saved-start catalog cannot be inspected: ${path}${error?.code ? ` (${error.code})` : ""}.`);
  }
}

export function readSavedStarts(path: string = SAVED_START_CATALOG_PATH): Map<string, SavedStart> {
  if (!savedStartCatalogExists(path)) return new Map();
  const text = readOwnerOnlyTextFile(path, { label: LABEL, maxBytes: SAVED_START_CATALOG_MAX_BYTES });
  return parseSavedStarts(text, path);
}

export function loadSavedStart(name: string, path: string = SAVED_START_CATALOG_PATH): SavedStart {
  assertName(name, "Parle saved-start name");
  const starts = readSavedStarts(path);
  const start = starts.get(name);
  if (start) return start;
  throw new SavedStartNotFoundError(name, [...starts.keys()], path);
}

export function saveSavedStart(start: SavedStart, path: string = SAVED_START_CATALOG_PATH): SavedStart {
  const normalized = validateSavedStart(start);
  ensureOwnerOnlyDirectory(dirname(path), { label: `${LABEL} directory` });
  return withOwnerOnlyFileLock(path, { label: LABEL, durability: "best-effort" }, () => {
    const starts = readSavedStarts(path);
    starts.set(normalized.name, normalized);
    atomicReplaceOwnerOnlyFile(path, serializeSavedStarts(starts.values()), {
      label: LABEL,
      maxBytes: SAVED_START_CATALOG_MAX_BYTES,
      durability: "best-effort",
    });
    return normalized;
  });
}

export function deleteSavedStart(name: string, path: string = SAVED_START_CATALOG_PATH): boolean {
  assertName(name, "Parle saved-start name");
  if (!savedStartCatalogExists(path)) return false;
  ensureOwnerOnlyDirectory(dirname(path), { label: `${LABEL} directory`, create: false });
  return withOwnerOnlyFileLock(path, { label: LABEL, durability: "best-effort" }, () => {
    const starts = readSavedStarts(path);
    if (!starts.delete(name)) return false;
    atomicReplaceOwnerOnlyFile(path, serializeSavedStarts(starts.values()), {
      label: LABEL,
      maxBytes: SAVED_START_CATALOG_MAX_BYTES,
      durability: "best-effort",
    });
    return true;
  });
}
