import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export type SafeFileDurability = "required" | "best-effort" | "none";

export type SafeFileReadOptions = {
  label: string;
  maxBytes: number;
  mode?: number;
  modePolicy?: "require" | "ignore";
  requireSingleLink?: boolean;
};

export type SafeFileWriteOptions = {
  label: string;
  maxBytes?: number;
  mode?: number;
  durability: SafeFileDurability;
  existingMode?: "require" | "replace";
};

export type SafeFileLockOptions = {
  label: string;
  lockPath?: string;
  malformedStaleAfterMs?: number;
  durability?: SafeFileDurability;
  now?: () => Date;
  pidIsAlive?: (pid: number) => boolean;
};

type LockRecord = {
  version: 1;
  token: string;
  pid: number;
  createdAt: string;
};

type LockObservation = {
  stat: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">;
  record?: LockRecord;
  stale: boolean;
};

const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_DIRECTORY_MODE = 0o700;
const MAX_LOCK_BYTES = 4096;
const DEFAULT_MALFORMED_LOCK_STALE_MS = 5 * 60_000;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export class SafeFileError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SafeFileError";
    this.code = code;
  }
}

function systemCode(error: unknown): string | undefined {
  return typeof (error as any)?.code === "string" ? (error as any).code : undefined;
}

function ownerAndMode(stat: Stats, expectedMode: number, label: string, kind: "file" | "directory"): void {
  if (kind === "file") {
    if (!stat.isFile()) throw new SafeFileError("unsafe_type", `${label} must be a regular file.`);
  } else if (!stat.isDirectory()) {
    throw new SafeFileError("unsafe_type", `${label} must be a real directory.`);
  }
  if (process.platform === "win32") return;
  if (stat.uid !== process.getuid?.()) throw new SafeFileError("unsafe_owner", `${label} must be owned by the current user.`);
  if ((stat.mode & 0o777) !== expectedMode) throw new SafeFileError("unsafe_mode", `${label} must have mode ${expectedMode.toString(8)}.`);
}

function assertSingleLink(stat: Stats, label: string): void {
  if (stat.nlink !== 1) throw new SafeFileError("unsafe_links", `${label} must have exactly one filesystem link.`);
}

function inspectRealDirectory(path: string, label: string, mode = DEFAULT_DIRECTORY_MODE): Stats {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new SafeFileError("directory_unavailable", `${label} cannot be inspected: ${path}.`, { cause: error });
  }
  if (stat.isSymbolicLink()) throw new SafeFileError("symlink_refused", `${label} must not be a symbolic link: ${path}.`);
  ownerAndMode(stat, mode, label, "directory");
  return stat;
}

export function ensureOwnerOnlyDirectory(path: string, options: { label: string; create?: boolean; mode?: number; repairMode?: boolean } = { label: "Owner-only directory" }): string {
  const mode = options.mode ?? DEFAULT_DIRECTORY_MODE;
  if (!existsSync(path)) {
    if (options.create === false) throw new SafeFileError("directory_missing", `${options.label} is missing: ${path}.`);
    try {
      mkdirSync(path, { recursive: true, mode });
    } catch (error) {
      throw new SafeFileError("directory_create_failed", `${options.label} could not be created: ${path}.`, { cause: error });
    }
  }
  let stat: Stats;
  try { stat = lstatSync(path); } catch (error) {
    throw new SafeFileError("directory_unavailable", `${options.label} cannot be inspected: ${path}.`, { cause: error });
  }
  if (stat.isSymbolicLink()) throw new SafeFileError("symlink_refused", `${options.label} must not be a symbolic link: ${path}.`);
  if (!stat.isDirectory()) throw new SafeFileError("unsafe_type", `${options.label} must be a real directory.`);
  if (process.platform !== "win32" && stat.uid !== process.getuid?.()) throw new SafeFileError("unsafe_owner", `${options.label} must be owned by the current user.`);
  if (options.repairMode && process.platform !== "win32" && (stat.mode & 0o777) !== mode) chmodSync(path, mode);
  inspectRealDirectory(path, options.label, mode);
  return path;
}

function inspectOwnerFileShape(path: string, label: string, requireSingleLink: boolean): Stats {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new SafeFileError("file_unavailable", `${label} cannot be inspected: ${path}.`, { cause: error });
  }
  if (stat.isSymbolicLink()) throw new SafeFileError("symlink_refused", `${label} must not be a symbolic link: ${path}.`);
  if (!stat.isFile()) throw new SafeFileError("unsafe_type", `${label} must be a regular file.`);
  if (process.platform !== "win32" && stat.uid !== process.getuid?.()) throw new SafeFileError("unsafe_owner", `${label} must be owned by the current user.`);
  if (requireSingleLink) assertSingleLink(stat, label);
  return stat;
}

function inspectOwnerOnlyPath(path: string, label: string, mode: number, requireSingleLink: boolean): Stats {
  const stat = inspectOwnerFileShape(path, label, requireSingleLink);
  ownerAndMode(stat, mode, label, "file");
  return stat;
}

function openOwnerOnlyRead(path: string, options: SafeFileReadOptions): { fd: number; stat: Stats } {
  const mode = options.mode ?? DEFAULT_FILE_MODE;
  const requireSingleLink = options.requireSingleLink ?? true;
  if (options.modePolicy === "ignore") inspectOwnerFileShape(path, options.label, requireSingleLink);
  else inspectOwnerOnlyPath(path, options.label, mode, requireSingleLink);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (systemCode(error) === "ELOOP") throw new SafeFileError("symlink_refused", `${options.label} must not be a symbolic link: ${path}.`, { cause: error });
    throw new SafeFileError("file_open_failed", `${options.label} could not be opened: ${path}.`, { cause: error });
  }
  try {
    const stat = fstatSync(fd);
    if (options.modePolicy === "ignore") {
      if (!stat.isFile()) throw new SafeFileError("unsafe_type", `${options.label} must be a regular file.`);
      if (process.platform !== "win32" && stat.uid !== process.getuid?.()) throw new SafeFileError("unsafe_owner", `${options.label} must be owned by the current user.`);
    } else ownerAndMode(stat, mode, options.label, "file");
    if (requireSingleLink) assertSingleLink(stat, options.label);
    if (stat.size > options.maxBytes) throw new SafeFileError("size_limit", `${options.label} exceeds ${options.maxBytes} bytes.`);
    return { fd, stat };
  } catch (error) {
    try { closeSync(fd); } catch {}
    throw error;
  }
}

export function readOwnerOnlyFile(path: string, options: SafeFileReadOptions): Buffer {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) throw new SafeFileError("invalid_limit", `${options.label} requires a non-negative byte limit.`);
  const { fd } = openOwnerOnlyRead(path, options);
  try {
    const output = Buffer.allocUnsafe(options.maxBytes + 1);
    let offset = 0;
    while (offset < output.length) {
      const count = readSync(fd, output, offset, output.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > options.maxBytes) throw new SafeFileError("size_limit", `${options.label} exceeds ${options.maxBytes} bytes.`);
    return Buffer.from(output.subarray(0, offset));
  } catch (error) {
    if (error instanceof SafeFileError) throw error;
    throw new SafeFileError("file_read_failed", `${options.label} could not be read: ${path}.`, { cause: error });
  } finally {
    try { closeSync(fd); } catch {}
  }
}

export function readOwnerOnlyTextFile(path: string, options: SafeFileReadOptions): string {
  return readOwnerOnlyFile(path, options).toString("utf8");
}

const UNSUPPORTED_SYNC_CODES = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EISDIR"]);

function syncFile(fd: number, label: string, durability: SafeFileDurability): void {
  if (durability === "none") return;
  try { fsyncSync(fd); } catch (error) {
    if (durability === "best-effort" && UNSUPPORTED_SYNC_CODES.has(systemCode(error) || "")) return;
    throw new SafeFileError("file_sync_unsupported", `${label} cannot provide required file durability.`, { cause: error });
  }
}

function syncDirectory(path: string, label: string, durability: SafeFileDurability): void {
  if (durability === "none") return;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    if (durability === "best-effort" && UNSUPPORTED_SYNC_CODES.has(systemCode(error) || "")) return;
    throw new SafeFileError("directory_sync_unsupported", `${label} cannot provide required directory durability.`, { cause: error });
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

function writeAll(fd: number, value: Buffer): void {
  let offset = 0;
  while (offset < value.length) offset += writeSync(fd, value, offset, value.length - offset);
}

export function atomicReplaceOwnerOnlyFile(path: string, value: string | Uint8Array, options: SafeFileWriteOptions): void {
  const mode = options.mode ?? DEFAULT_FILE_MODE;
  const durability = options.durability;
  const body = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (options.maxBytes !== undefined && body.byteLength > options.maxBytes) {
    throw new SafeFileError("size_limit", `${options.label} exceeds ${options.maxBytes} bytes.`);
  }
  const directory = dirname(path);
  const directoryStat = inspectRealDirectory(directory, `${options.label} parent directory`);
  const inspectExisting = () => options.existingMode === "replace"
    ? inspectOwnerFileShape(path, options.label, true)
    : inspectOwnerOnlyPath(path, options.label, mode, true);
  if (existsSync(path)) inspectExisting();
  const temp = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, mode);
    if (process.platform !== "win32") fchmodSync(fd, mode);
    const tempStat = fstatSync(fd);
    ownerAndMode(tempStat, mode, `${options.label} temporary file`, "file");
    assertSingleLink(tempStat, `${options.label} temporary file`);
    writeAll(fd, body);
    syncFile(fd, `${options.label} temporary file`, durability);
    closeSync(fd);
    fd = undefined;
    inspectOwnerOnlyPath(temp, `${options.label} temporary file`, mode, true);
    const currentDirectory = inspectRealDirectory(directory, `${options.label} parent directory`);
    if (currentDirectory.dev !== directoryStat.dev || currentDirectory.ino !== directoryStat.ino) throw new SafeFileError("directory_changed", `${options.label} parent directory changed during atomic replacement.`);
    if (existsSync(path)) inspectExisting();
    try {
      renameSync(temp, path);
    } catch (error) {
      const code = systemCode(error);
      if (["EXDEV", "ENOTSUP", "EOPNOTSUPP"].includes(code || "")) {
        throw new SafeFileError("atomic_replace_unsupported", `${options.label} cannot be replaced atomically on this filesystem.`, { cause: error });
      }
      throw error;
    }
    inspectOwnerOnlyPath(path, options.label, mode, true);
    syncDirectory(directory, `${options.label} parent directory`, durability);
  } catch (error) {
    if (error instanceof SafeFileError) throw error;
    throw new SafeFileError("atomic_replace_failed", `${options.label} could not be replaced atomically: ${path}.`, { cause: error });
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { if (existsSync(temp)) unlinkSync(temp); } catch {}
    body.fill(0);
  }
}

function defaultPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return systemCode(error) !== "ESRCH";
  }
}

function parseLockRecord(raw: string): LockRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LockRecord>;
    if (value.version !== 1 || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/i.test(value.token) || !Number.isSafeInteger(value.pid) || value.pid! <= 0 || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return undefined;
    return value as LockRecord;
  } catch {
    return undefined;
  }
}

function readLockObservation(path: string, options: SafeFileLockOptions): LockObservation {
  const stat = inspectOwnerFileShape(path, `${options.label} lock`, true);
  let fd: number | undefined;
  let raw = Buffer.alloc(0);
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new SafeFileError("lock_changed", `${options.label} lock changed during inspection.`);
    raw = Buffer.allocUnsafe(MAX_LOCK_BYTES + 1);
    let offset = 0;
    while (offset < raw.length) {
      const count = readSync(fd, raw, offset, raw.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const record = offset <= MAX_LOCK_BYTES ? parseLockRecord(raw.subarray(0, offset).toString("utf8")) : undefined;
    const stale = record
      ? !(options.pidIsAlive ?? defaultPidIsAlive)(record.pid)
      : (options.now ?? (() => new Date()))().getTime() - stat.mtimeMs >= (options.malformedStaleAfterMs ?? DEFAULT_MALFORMED_LOCK_STALE_MS);
    return { stat: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }, record, stale };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    raw.fill(0);
  }
}

function removeStaleLock(path: string, observed: LockObservation, options: SafeFileLockOptions): void {
  const quarantine = `${path}.stale.${process.pid}.${randomUUID()}`;
  try {
    renameSync(path, quarantine);
  } catch (error) {
    if (systemCode(error) === "ENOENT") return;
    throw new SafeFileError("stale_lock_recovery_failed", `${options.label} stale lock could not be quarantined.`, { cause: error });
  }
  try {
    const quarantined = readLockObservation(quarantine, options);
    const sameIdentity = quarantined.stat.dev === observed.stat.dev && quarantined.stat.ino === observed.stat.ino;
    const sameRecord = observed.record ? quarantined.record?.token === observed.record.token : quarantined.record === undefined;
    if (!sameIdentity || !sameRecord) {
      if (!existsSync(path)) renameSync(quarantine, path);
      throw new SafeFileError("lock_contended", `${options.label} lock changed during stale recovery.`);
    }
    unlinkSync(quarantine);
    syncDirectory(dirname(path), `${options.label} lock directory`, options.durability ?? "none");
  } catch (error) {
    if (error instanceof SafeFileError) throw error;
    throw new SafeFileError("stale_lock_recovery_failed", `${options.label} stale lock could not be removed safely.`, { cause: error });
  }
}

function acquireLock(path: string, record: LockRecord, options: SafeFileLockOptions): void {
  const body = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, DEFAULT_FILE_MODE);
    if (process.platform !== "win32") fchmodSync(fd, DEFAULT_FILE_MODE);
    const stat = fstatSync(fd);
    ownerAndMode(stat, DEFAULT_FILE_MODE, `${options.label} lock`, "file");
    assertSingleLink(stat, `${options.label} lock`);
    writeAll(fd, body);
    syncFile(fd, `${options.label} lock`, options.durability ?? "none");
    closeSync(fd);
    fd = undefined;
    syncDirectory(dirname(path), `${options.label} lock directory`, options.durability ?? "none");
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    if (systemCode(error) === "EEXIST") throw new SafeFileError("lock_contended", `${options.label} is locked by another writer: ${path}.`, { cause: error });
    if (error instanceof SafeFileError) throw error;
    throw new SafeFileError("lock_failed", `${options.label} lock could not be acquired: ${path}.`, { cause: error });
  } finally {
    body.fill(0);
  }
}

export function withOwnerOnlyFileLock<T>(targetPath: string, options: SafeFileLockOptions, operation: () => T): T {
  const lockPath = options.lockPath ?? `${targetPath}.lock`;
  inspectRealDirectory(dirname(lockPath), `${options.label} lock directory`);
  const record: LockRecord = { version: 1, token: randomUUID(), pid: process.pid, createdAt: (options.now ?? (() => new Date()))().toISOString() };
  try {
    acquireLock(lockPath, record, options);
  } catch (error) {
    if (!(error instanceof SafeFileError) || error.code !== "lock_contended") throw error;
    const observed = readLockObservation(lockPath, options);
    if (!observed.stale) throw error;
    removeStaleLock(lockPath, observed, options);
    acquireLock(lockPath, record, options);
  }
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try { result = operation(); } catch (error) { operationFailed = true; operationError = error; }
  let releaseError: unknown;
  try {
    const current = parseLockRecord(readOwnerOnlyTextFile(lockPath, { label: `${options.label} lock`, maxBytes: MAX_LOCK_BYTES }));
    if (!current || current.token !== record.token) throw new SafeFileError("lock_ownership_lost", `${options.label} lock ownership changed before release.`);
    unlinkSync(lockPath);
    syncDirectory(dirname(lockPath), `${options.label} lock directory`, options.durability ?? "none");
  } catch (error) {
    releaseError = error instanceof SafeFileError ? error : new SafeFileError("lock_release_failed", `${options.label} lock could not be released safely.`, { cause: error });
  }
  if (operationFailed) {
    if (releaseError !== undefined && operationError instanceof Error) Object.defineProperty(operationError, "lockReleaseError", { value: releaseError, enumerable: false });
    throw operationError;
  }
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}
