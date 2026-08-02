import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_VERSION } from "./protocol.js";
import { loadProfile, profileCatalogHasProfile, resolveProfileCatalogPath } from "./profiles.js";

const DEFAULT_API_BASE = "https://api.parle.sh";
const MAX_SECRET_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RECOVERY_CODES = 64;
const STATE_FILE = "state.json";
const ACK_FILE = "recovery-stored.ack";
const CEREMONY_DIR = "current";
const SECRET_FILES = ["password.input", "current-password.input", "bootstrap-proof.input", "totp-code.input", "provisioning-uri.txt", "recovery-codes.txt"] as const;

type SecretFile = typeof SECRET_FILES[number];
type CeremonyPhase = "needs_password" | "sudo_ready" | "provisioning_captured" | "awaiting_confirmation" | "hardened_recovery_captured" | "finalized" | "password_outcome_unknown" | "enroll_outcome_unknown" | "confirm_outcome_unknown" | "hardened_recovery_missing" | "recovery_regeneration_outcome_unknown";

export type HardenAccountParams = {
  action: "status" | "prepare" | "refresh_sudo" | "enroll_totp" | "confirm_totp" | "recover_confirm" | "finalize";
  confirmMutation?: boolean;
  reason?: string;
};

export type HardeningClientOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
};

type HardeningConfig = {
  apiBase: string;
  version: string;
  sessionCookie: string;
  stateDir: string;
};

type CeremonyState = {
  schemaVersion: 1;
  generation: number;
  phase: CeremonyPhase;
  sessionFingerprint: string;
  passwordMode?: "set" | "change";
  passwordSet?: boolean;
  sudoNeedsRefresh?: boolean;
  recoveryCaptured?: boolean;
  assuranceVerified?: boolean;
  createdAt: string;
  updatedAt: string;
};

class HardeningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HardeningError";
  }
}

class HardeningHttpError extends HardeningError {
  readonly status: number;
  readonly ambiguous: boolean;
  constructor(status: number) {
    super(status >= 500 ? "Parle hardening request outcome is unknown. Do not retry automatically." : `Parle hardening request was rejected with HTTP ${status}.`);
    this.status = status;
    this.ambiguous = status >= 500;
  }
}

class HardeningTransportError extends HardeningError {
  readonly ambiguous = true;
  constructor() {
    super("Parle hardening request outcome is unknown. Do not retry automatically.");
  }
}

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

function firstValue(key: string, env: Record<string, string | undefined>, dotEnv: Record<string, string>): string | undefined {
  return env[key] || dotEnv[key] || undefined;
}

function assertSafeApiBase(base: string, env: Record<string, string | undefined>): string {
  const url = new URL(base);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (local && env.PARLE_ALLOW_INSECURE_LOCAL === "1") return url.origin;
  if (url.protocol !== "https:" || url.username || url.password) throw new HardeningError("Parle hardening requires an approved HTTPS API base.");
  return url.origin;
}

function ownerAndMode(stat: { uid: number; mode: number }, mode: number, label: string): void {
  if (process.platform === "win32") return;
  if (stat.uid !== process.getuid?.()) throw new HardeningError(`${label} must be owned by the current user.`);
  if ((stat.mode & 0o777) !== mode) throw new HardeningError(`${label} must have mode ${mode.toString(8)}.`);
}

function assertSecureDirectory(path: string, label: string): void {
  let entry: ReturnType<typeof lstatSync>;
  try { entry = lstatSync(path); } catch { throw new HardeningError(`${label} is missing.`); }
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new HardeningError(`${label} must be a real directory.`);
  ownerAndMode(entry, 0o700, label);
}

function assertSecureFile(path: string, label: string, maxBytes = MAX_SECRET_BYTES): ReturnType<typeof statSync> {
  let entry: ReturnType<typeof lstatSync>;
  try { entry = lstatSync(path); } catch { throw new HardeningError(`${label} is missing.`); }
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) throw new HardeningError(`${label} must be an unlinked regular file.`);
  ownerAndMode(entry, 0o600, label);
  if (entry.size > maxBytes) throw new HardeningError(`${label} exceeds its bounded size.`);
  return entry;
}

function createSecureDirectory(path: string, label: string): void {
  if (!existsSync(path)) {
    try { mkdirSync(path, { mode: 0o700 }); } catch { throw new HardeningError(`Could not create ${label}.`); }
  }
  assertSecureDirectory(path, label);
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error: any) {
    // Windows and a few network filesystems do not implement directory fsync.
    if (!["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) throw new HardeningError("Could not sync protected hardening storage.");
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

function clearBuffer(value: Buffer | undefined): void {
  if (value) value.fill(0);
}

function secureUnlink(path: string, label: string): void {
  if (!existsSync(path)) return;
  assertSecureFile(path, label);
  try { unlinkSync(path); } catch { throw new HardeningError(`Could not remove ${label}.`); }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function validWhoami(value: unknown): { assurance: "unhardened" | "hardened" } {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  if (!body || body.authenticated !== true || (body.assurance !== "unhardened" && body.assurance !== "hardened")) {
    throw new HardeningError("Parle hardening received an invalid whoami response.");
  }
  return { assurance: body.assurance };
}

function validSudo(value: unknown, now: Date): void {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const expiresAt = typeof body?.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
  if (!body || !hasOnlyKeys(body, ["expires_at"]) || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new HardeningError("Parle hardening received an invalid sudo response.");
  }
}

function validProvisioningUri(value: unknown): string {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const uri = typeof body?.provisioning_uri === "string" ? body.provisioning_uri : "";
  if (!body || !hasOnlyKeys(body, ["provisioning_uri"]) || !uri || Buffer.byteLength(uri, "utf8") > MAX_SECRET_BYTES || /[\r\n]/.test(uri)) {
    throw new HardeningError("Parle hardening received an invalid provisioning response.");
  }
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new HardeningError("Parle hardening received an invalid provisioning response."); }
  if (parsed.protocol !== "otpauth:" || parsed.hostname !== "totp" || !parsed.searchParams.get("secret") || parsed.username || parsed.password) {
    throw new HardeningError("Parle hardening received an invalid provisioning response.");
  }
  return uri;
}

function validRecoveryCodes(value: unknown): string[] {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const codes = body?.recovery_codes;
  if (!body || !hasOnlyKeys(body, ["recovery_codes"]) || !Array.isArray(codes) || codes.length === 0 || codes.length > MAX_RECOVERY_CODES || codes.some((code) => typeof code !== "string" || !code || Buffer.byteLength(code, "utf8") > 256 || /[\r\n]/.test(code))) {
    throw new HardeningError("Parle hardening received an invalid recovery-code response.");
  }
  return codes as string[];
}

function isAmbiguous(error: unknown): boolean {
  return error instanceof HardeningTransportError || (error instanceof HardeningHttpError && error.ambiguous);
}

function ceremonyPath(config: HardeningConfig): string {
  return join(config.stateDir, "hardening", CEREMONY_DIR);
}

function rootPath(config: HardeningConfig): string {
  return join(config.stateDir, "hardening");
}

function outputPath(config: HardeningConfig, file: SecretFile): string {
  return join(ceremonyPath(config), file);
}

function resolveHardeningConfig(cwd: string, env: Record<string, string | undefined>): HardeningConfig {
  // The hardening ceremony deliberately ignores PARLE_SESSION_COOKIE. The
  // existing local session file is the only cookie source, keeping helper and
  // orchestration invocation environments free of bearer material.
  const dotEnvPath = join(cwd, ".env");
  const dotEnv = existsSync(dotEnvPath) ? parseDotEnv(readFileSync(dotEnvPath, "utf8")) : {};
  const catalogPath = resolveProfileCatalogPath(firstValue("PARLE_PROFILES_PATH", env, dotEnv), cwd, env);
  const stateDir = dirname(catalogPath);
  const parent = lstatSync(stateDir);
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new HardeningError("Parle state directory must be a real directory.");
  if (process.platform !== "win32" && parent.uid !== process.getuid?.()) throw new HardeningError("Parle state directory must be owned by the current user.");
  const sessionPath = join(stateDir, "session");
  assertSecureFile(sessionPath, "Parle human session file", 8192);
  const sessionCookie = readFileSync(sessionPath, "utf8").trim();
  if (!sessionCookie || /[\r\n]/.test(sessionCookie)) throw new HardeningError("Parle human session file is invalid.");
  let configuredApiBase = firstValue("PARLE_API_BASE", env, dotEnv);
  if (!configuredApiBase && existsSync(catalogPath)) {
    const selected = firstValue("PARLE_PROFILE", env, dotEnv) || (profileCatalogHasProfile("default", catalogPath) ? "default" : undefined);
    if (selected) configuredApiBase = loadProfile(selected, catalogPath).apiBase;
  }
  return {
    apiBase: assertSafeApiBase(configuredApiBase || DEFAULT_API_BASE, env),
    version: env.PARLE_VERSION || DEFAULT_VERSION,
    sessionCookie,
    stateDir,
  };
}

export class ParleHardeningClient {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly fetchImpl: typeof fetch;
  readonly now: () => Date;

  constructor(options: HardeningClientOptions = {}) {
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || process.env;
    this.fetchImpl = options.fetch || fetch;
    this.now = options.now || (() => new Date());
  }

  private config(): HardeningConfig {
    return resolveHardeningConfig(this.cwd, this.env);
  }

  private fingerprint(config: HardeningConfig): string {
    return createHash("sha256").update(config.sessionCookie, "utf8").digest("hex");
  }

  private ensureRoot(config: HardeningConfig): void {
    createSecureDirectory(rootPath(config), "Parle hardening root");
  }

  private readState(config: HardeningConfig, required = true): CeremonyState | undefined {
    const root = rootPath(config);
    if (!existsSync(root)) {
      if (required) throw new HardeningError("No active Parle hardening ceremony exists. Run parle_harden_account status first.");
      return undefined;
    }
    assertSecureDirectory(root, "Parle hardening root");
    const dir = ceremonyPath(config);
    if (!existsSync(dir)) {
      if (required) throw new HardeningError("No active Parle hardening ceremony exists. Run parle_harden_account status first.");
      return undefined;
    }
    assertSecureDirectory(dir, "Parle hardening ceremony directory");
    const path = join(dir, STATE_FILE);
    assertSecureFile(path, "Parle hardening state", MAX_SECRET_BYTES);
    const raw = parseJson(readFileSync(path, "utf8"));
    const state = raw && typeof raw === "object" ? raw as Partial<CeremonyState> : undefined;
    const phases: CeremonyPhase[] = ["needs_password", "sudo_ready", "provisioning_captured", "awaiting_confirmation", "hardened_recovery_captured", "finalized", "password_outcome_unknown", "enroll_outcome_unknown", "confirm_outcome_unknown", "hardened_recovery_missing", "recovery_regeneration_outcome_unknown"];
    if (!state || state.schemaVersion !== 1 || !Number.isInteger(state.generation) || state.generation! < 0 || !phases.includes(state.phase as CeremonyPhase) || typeof state.sessionFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(state.sessionFingerprint) || typeof state.createdAt !== "string" || typeof state.updatedAt !== "string") {
      throw new HardeningError("Parle hardening state is invalid.");
    }
    if (state.passwordMode !== undefined && state.passwordMode !== "set" && state.passwordMode !== "change") throw new HardeningError("Parle hardening state is invalid.");
    return state as CeremonyState;
  }

  private assertBound(config: HardeningConfig, state: CeremonyState): void {
    if (state.sessionFingerprint !== this.fingerprint(config)) throw new HardeningError("The Parle human session changed. This active hardening ceremony is invalidated.");
  }

  private writeState(config: HardeningConfig, next: CeremonyState, expectedGeneration?: number): void {
    const dir = ceremonyPath(config);
    assertSecureDirectory(rootPath(config), "Parle hardening root");
    assertSecureDirectory(dir, "Parle hardening ceremony directory");
    const statePath = join(dir, STATE_FILE);
    if (expectedGeneration !== undefined && existsSync(statePath)) {
      const current = this.readState(config)!;
      if (current.generation !== expectedGeneration) throw new HardeningError("Parle hardening state changed concurrently.");
    }
    const temp = join(dir, `.state-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      const body = Buffer.from(JSON.stringify(next) + "\n", "utf8");
      try {
        writeSync(fd, body);
        fsyncSync(fd);
      } finally { clearBuffer(body); }
      closeSync(fd);
      fd = undefined;
      assertSecureFile(temp, "Parle hardening state", MAX_SECRET_BYTES);
      renameSync(temp, statePath);
      assertSecureFile(statePath, "Parle hardening state", MAX_SECRET_BYTES);
      syncDirectory(dir);
    } catch {
      throw new HardeningError("Could not publish protected hardening state.");
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch {}
      try { if (existsSync(temp)) unlinkSync(temp); } catch {}
    }
  }

  private begin(config: HardeningConfig): CeremonyState {
    this.ensureRoot(config);
    const existing = this.readState(config, false);
    if (existing) return existing;
    const dir = ceremonyPath(config);
    createSecureDirectory(dir, "Parle hardening ceremony directory");
    const now = this.now().toISOString();
    const state: CeremonyState = { schemaVersion: 1, generation: 0, phase: "needs_password", sessionFingerprint: this.fingerprint(config), createdAt: now, updatedAt: now };
    this.writeState(config, state);
    return state;
  }

  private transition(config: HardeningConfig, state: CeremonyState, phases: CeremonyPhase[], patch: Partial<CeremonyState>): CeremonyState {
    if (!phases.includes(state.phase)) throw new HardeningError("Parle hardening action is not valid in the current ceremony state.");
    const next: CeremonyState = {
      ...state,
      ...patch,
      schemaVersion: 1,
      generation: state.generation + 1,
      sessionFingerprint: state.sessionFingerprint,
      createdAt: state.createdAt,
      updatedAt: this.now().toISOString(),
    };
    this.writeState(config, next, state.generation);
    return next;
  }

  private readSecret(config: HardeningConfig, file: SecretFile): Buffer {
    const path = outputPath(config, file);
    assertSecureFile(path, `Parle hardening ${file}`);
    const value = readFileSync(path);
    if (value.length === 0 || value.length > MAX_SECRET_BYTES) {
      clearBuffer(value);
      throw new HardeningError("Protected hardening input is invalid.");
    }
    return value;
  }

  private createSecret(config: HardeningConfig, file: SecretFile, value: Buffer): void {
    if (value.length === 0 || value.length > MAX_SECRET_BYTES) throw new HardeningError("Hardening input is invalid.");
    const dir = ceremonyPath(config);
    assertSecureDirectory(dir, "Parle hardening ceremony directory");
    const path = outputPath(config, file);
    let fd: number | undefined;
    let created = false;
    try {
      fd = openSync(path, "wx", 0o600);
      created = true;
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new HardeningError("Protected hardening input is unsafe.");
      ownerAndMode(stat, 0o600, "Protected hardening input");
      let written = 0;
      while (written < value.length) written += writeSync(fd, value, written, value.length - written);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      assertSecureFile(path, `Parle hardening ${file}`);
      syncDirectory(dir);
    } catch (error) {
      try { if (fd !== undefined) closeSync(fd); } catch {}
      // Exclusive create must never turn a duplicate staging request into a
      // deletion of the already-staged secret.
      try { if (created && existsSync(path)) unlinkSync(path); } catch {}
      if (error instanceof HardeningError) throw error;
      throw new HardeningError("Could not stage protected hardening input.");
    }
  }

  private openSink(config: HardeningConfig, file: "provisioning-uri.txt" | "recovery-codes.txt"): { fd: number; path: string } {
    const dir = ceremonyPath(config);
    assertSecureDirectory(dir, "Parle hardening ceremony directory");
    const path = outputPath(config, file);
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new HardeningError("Protected hardening output is unsafe.");
      ownerAndMode(stat, 0o600, "Protected hardening output");
      return { fd, path };
    } catch (error) {
      try { if (fd !== undefined) closeSync(fd); } catch {}
      if (error instanceof HardeningError) throw error;
      throw new HardeningError("Protected hardening output is already occupied or unsafe.");
    }
  }

  private discardSink(config: HardeningConfig, sink: { fd: number; path: string }): void {
    try { closeSync(sink.fd); } catch {}
    try { if (existsSync(sink.path)) secureUnlink(sink.path, "protected hardening output"); } catch { throw new HardeningError("Could not discard protected hardening output."); }
    syncDirectory(ceremonyPath(config));
  }

  private writeSink(config: HardeningConfig, sink: { fd: number; path: string }, value: Buffer): void {
    let closed = false;
    try {
      let written = 0;
      while (written < value.length) written += writeSync(sink.fd, value, written, value.length - written);
      fsyncSync(sink.fd);
      closeSync(sink.fd);
      closed = true;
      assertSecureFile(sink.path, "protected hardening output");
      syncDirectory(ceremonyPath(config));
    } catch {
      // Never reopen a path after a close: an attacker could replace it in the
      // gap. While the descriptor is held, truncate and unlink only after the
      // fixed path still passes its no-symlink custody checks. A failure after
      // close leaves the protected file in place and moves the ceremony into
      // explicit recovery rather than traversing a replacement path.
      if (!closed) {
        try { ftruncateSync(sink.fd, 0); fsyncSync(sink.fd); } catch {}
        try { closeSync(sink.fd); } catch {}
        try { if (existsSync(sink.path)) secureUnlink(sink.path, "protected hardening output"); } catch {}
      }
      throw new HardeningError("Could not durably capture protected hardening output.");
    } finally {
      clearBuffer(value);
    }
  }

  private async request(config: HardeningConfig, path: string, method: "GET" | "POST", body?: Record<string, string>): Promise<{ status: number; json: unknown }> {
    let encoded: string | undefined;
    try {
      encoded = body === undefined ? undefined : JSON.stringify(body);
      const response = await this.fetchImpl(new URL(path, config.apiBase), {
        method,
        headers: {
          Accept: "application/json",
          "Parle-Version": config.version,
          Cookie: config.sessionCookie,
          ...(encoded ? { "Content-Type": "application/json" } : {}),
        },
        body: encoded,
      });
      let raw: Buffer;
      try { raw = Buffer.from(await response.arrayBuffer()); } catch { throw new HardeningTransportError(); }
      if (raw.byteLength > MAX_RESPONSE_BYTES) {
        clearBuffer(raw);
        throw new HardeningError("Parle hardening response exceeded its bounded size.");
      }
      if (!response.ok) {
        clearBuffer(raw);
        throw new HardeningHttpError(response.status);
      }
      const json = response.status === 204 ? undefined : parseJson(raw.toString("utf8"));
      clearBuffer(raw);
      return { status: response.status, json };
    } catch (error) {
      if (error instanceof HardeningError) throw error;
      throw new HardeningTransportError();
    } finally {
      encoded = undefined;
    }
  }

  private async whoami(config: HardeningConfig): Promise<{ assurance: "unhardened" | "hardened" }> {
    const response = await this.request(config, "/v/auth/whoami", "GET");
    if (response.status !== 200) throw new HardeningError("Parle hardening received an invalid whoami response.");
    return validWhoami(response.json);
  }

  private async openBootstrapSudo(config: HardeningConfig, proof: Buffer): Promise<void> {
    let proofText: string | undefined;
    try {
      proofText = proof.toString("utf8");
      const response = await this.request(config, "/v/auth/sudo", "POST", { factor: "bootstrap_reauth", proof: proofText });
      if (response.status !== 200) throw new HardeningError("Parle hardening received an invalid sudo response.");
      validSudo(response.json, this.now());
    } finally {
      proofText = undefined;
      clearBuffer(proof);
    }
  }

  private async openTotpSudo(config: HardeningConfig, code: Buffer): Promise<void> {
    let codeText: string | undefined;
    try {
      codeText = code.toString("utf8");
      const response = await this.request(config, "/v/auth/sudo", "POST", { factor: "totp", code: codeText });
      if (response.status !== 200) throw new HardeningError("Parle hardening received an invalid sudo response.");
      validSudo(response.json, this.now());
    } finally {
      codeText = undefined;
      clearBuffer(code);
    }
  }

  private requireConfirmedMutation(params: HardenAccountParams): void {
    if (params.confirmMutation !== true || !params.reason?.trim()) throw new HardeningError(`parle_harden_account ${params.action} requires confirmMutation=true and a reason.`);
  }

  async stagePassword(mode: "set" | "change", password: Buffer, currentPassword?: Buffer): Promise<void> {
    const config = this.config();
    const state = this.readState(config);
    this.assertBound(config, state!);
    if (state!.phase !== "needs_password" || state!.passwordMode || state!.passwordSet) throw new HardeningError("A password input is not expected in the current hardening state.");
    if (mode === "change" && !currentPassword) throw new HardeningError("Current password input is required for change mode.");
    if (mode === "set" && currentPassword) throw new HardeningError("Current password input is not valid for set mode.");
    let passwordStaged = false;
    let currentStaged = false;
    try {
      if (currentPassword) {
        this.createSecret(config, "current-password.input", currentPassword);
        currentStaged = true;
      }
      this.createSecret(config, "password.input", password);
      passwordStaged = true;
      this.transition(config, state!, ["needs_password"], { passwordMode: mode });
    } catch (error) {
      try { if (passwordStaged) secureUnlink(outputPath(config, "password.input"), "protected hardening input"); } catch {}
      try { if (currentStaged) secureUnlink(outputPath(config, "current-password.input"), "protected hardening input"); } catch {}
      throw error;
    } finally {
      clearBuffer(password);
      clearBuffer(currentPassword);
    }
  }

  async stageBootstrapProof(proof: Buffer): Promise<void> {
    const config = this.config();
    const state = this.readState(config);
    this.assertBound(config, state!);
    if (!state!.sudoNeedsRefresh || state!.phase === "finalized") throw new HardeningError("A bootstrap proof is not expected in the current hardening state.");
    try { this.createSecret(config, "bootstrap-proof.input", proof); } finally { clearBuffer(proof); }
  }

  async stageTotpCode(code: Buffer): Promise<void> {
    const config = this.config();
    const state = this.readState(config);
    this.assertBound(config, state!);
    if (!["provisioning_captured", "awaiting_confirmation", "confirm_outcome_unknown", "hardened_recovery_missing", "recovery_regeneration_outcome_unknown"].includes(state!.phase)) {
      throw new HardeningError("A TOTP code is not expected in the current hardening state.");
    }
    if (!/^\d{6}$/.test(code.toString("utf8"))) {
      clearBuffer(code);
      throw new HardeningError("TOTP input must be exactly six digits.");
    }
    try { this.createSecret(config, "totp-code.input", code); } finally { clearBuffer(code); }
  }

  provisioningPath(): string {
    const config = this.config();
    const state = this.readState(config);
    this.assertBound(config, state!);
    if (!["provisioning_captured", "awaiting_confirmation"].includes(state!.phase)) throw new HardeningError("No captured provisioning URI is available.");
    assertSecureFile(outputPath(config, "provisioning-uri.txt"), "protected provisioning URI");
    return outputPath(config, "provisioning-uri.txt");
  }

  readProvisioningUriForTty(): Buffer {
    this.provisioningPath();
    return this.readSecret(this.config(), "provisioning-uri.txt");
  }

  async acknowledgeRecoveryStored(): Promise<void> {
    const config = this.config();
    const state = this.readState(config);
    this.assertBound(config, state!);
    if (state!.phase !== "hardened_recovery_captured" || !state!.recoveryCaptured) throw new HardeningError("Recovery storage acknowledgement is not expected yet.");
    assertSecureFile(outputPath(config, "recovery-codes.txt"), "protected recovery codes");
    const path = join(ceremonyPath(config), ACK_FILE);
    const value = Buffer.from(JSON.stringify({ schemaVersion: 1, acknowledgedAt: this.now().toISOString() }) + "\n", "utf8");
    try { this.createSecret(config, ACK_FILE as SecretFile, value); } finally { clearBuffer(value); }
  }

  async hardenAccount(params: HardenAccountParams): Promise<Record<string, unknown>> {
    const config = this.config();
    if (!["status", "prepare", "refresh_sudo", "enroll_totp", "confirm_totp", "recover_confirm", "finalize"].includes(params.action)) throw new HardeningError("parle_harden_account action is invalid.");
    if (params.action === "status") return this.status(config);
    this.requireConfirmedMutation(params);
    switch (params.action) {
      case "prepare": return this.prepare(config);
      case "refresh_sudo": return this.refreshSudo(config);
      case "enroll_totp": return this.enrollTotp(config);
      case "confirm_totp": return this.confirmTotp(config);
      case "recover_confirm": return this.recoverConfirm(config);
      case "finalize": return this.finalize(config);
      default: throw new HardeningError("parle_harden_account action is invalid.");
    }
  }

  private async status(config: HardeningConfig): Promise<Record<string, unknown>> {
    const whoami = await this.whoami(config);
    let state = this.readState(config, false);
    if (!state && whoami.assurance === "unhardened") state = this.begin(config);
    if (!state) {
      return { action: "status", assurance: whoami.assurance, state: "none", next: "No local ceremony is active. Do not regenerate recovery codes without a separately authorized recovery procedure." };
    }
    if (state.sessionFingerprint !== this.fingerprint(config)) {
      return { action: "status", assurance: whoami.assurance, state: "session_changed", next: "The human session changed. Do not use this ceremony; start a new authorized ceremony after resolving the protected local state." };
    }
    if (state.phase === "finalized") {
      if (whoami.assurance !== "hardened") return { action: "status", assurance: whoami.assurance, state: "state_conflict", next: "The finalized local ceremony conflicts with current server assurance. Stop and reconcile manually." };
      return { action: "status", assurance: "hardened", state: "finalized", complete: true, next: "Hardening ceremony complete." };
    }
    if (whoami.assurance === "hardened") {
      if (state.phase === "hardened_recovery_captured" && state.recoveryCaptured && state.assuranceVerified && existsSync(outputPath(config, "recovery-codes.txt"))) {
        try {
          assertSecureFile(outputPath(config, "recovery-codes.txt"), "protected recovery codes");
          return { action: "status", assurance: "hardened", state: state.phase, complete: true, recoveryPath: outputPath(config, "recovery-codes.txt"), next: "Move recovery codes to protected storage, acknowledge that step with parle-hardening-secret ack-recovery-stored, then finalize." };
        } catch {
          // A missing or unsafe local capture must never be reported complete.
        }
      }
      return { action: "status", assurance: "hardened", state: state.phase, next: "Run parle_harden_account recover_confirm with explicit confirmation. It will verify durable recovery capture or require a fresh human-only TOTP code before exactly one recovery-code regeneration." };
    }
    const next = state.phase === "needs_password" || state.phase === "password_outcome_unknown"
      ? state.passwordSet ? "Run parle_harden_account prepare with explicit confirmation to open bootstrap sudo." : state.passwordMode ? "Run parle_harden_account prepare with explicit confirmation." : "Run parle-hardening-secret password-set in a separate terminal, or password-change when replacing an existing password, then run parle_harden_account prepare with explicit confirmation."
      : state.sudoNeedsRefresh ? "Run parle-hardening-secret bootstrap-proof in a separate terminal, then run parle_harden_account refresh_sudo with explicit confirmation."
      : state.phase === "sudo_ready" || state.phase === "enroll_outcome_unknown" ? "Run parle_harden_account enroll_totp with explicit confirmation." : state.phase === "provisioning_captured" || state.phase === "awaiting_confirmation" ? "Scan the protected provisioning QR in a separate terminal, run parle-hardening-secret totp-code, then run parle_harden_account confirm_totp with explicit confirmation." : "Stop and reconcile the hardening ceremony state.";
    return { action: "status", assurance: "unhardened", state: state.phase, next };
  }

  private async prepare(config: HardeningConfig): Promise<Record<string, unknown>> {
    let state = this.readState(config)!;
    this.assertBound(config, state);
    if (!["needs_password", "password_outcome_unknown"].includes(state.phase) || !state.passwordMode) throw new HardeningError("Password preparation is not valid in the current hardening state.");
    let password = this.readSecret(config, "password.input");
    let current: Buffer | undefined;
    try {
      if (state.passwordMode === "change") current = this.readSecret(config, "current-password.input");
      if (state.phase === "password_outcome_unknown") {
        try {
          await this.openBootstrapSudo(config, password);
          state = this.transition(config, state, ["password_outcome_unknown"], { phase: "sudo_ready", passwordSet: true, sudoNeedsRefresh: false });
          secureUnlink(outputPath(config, "password.input"), "protected password input");
          if (current) secureUnlink(outputPath(config, "current-password.input"), "protected current-password input");
          return { action: "prepare", state: state.phase, sudo: "ready", next: "Run parle_harden_account enroll_totp with explicit confirmation." };
        } catch (error) {
          if (isAmbiguous(error)) throw error;
          throw new HardeningError("Password outcome remains unknown. Reconcile with the account owner; do not repeat the password mutation automatically.");
        }
      }
      if (!state.passwordSet) {
        let passwordText: string | undefined;
        let currentText: string | undefined;
        try {
          passwordText = password.toString("utf8");
          currentText = current?.toString("utf8");
          const response = await this.request(config, "/v/auth/password", "POST", { new_password: passwordText, ...(currentText ? { current_password: currentText } : {}) });
          if (response.status !== 204) throw new HardeningError("Parle hardening received an invalid password response.");
          state = this.transition(config, state, ["needs_password"], { passwordSet: true });
        } catch (error) {
          if (isAmbiguous(error)) this.transition(config, state, ["needs_password"], { phase: "password_outcome_unknown" });
          else {
            secureUnlink(outputPath(config, "password.input"), "protected password input");
            if (current) secureUnlink(outputPath(config, "current-password.input"), "protected current-password input");
            this.transition(config, state, ["needs_password"], { passwordMode: undefined });
          }
          throw error;
        } finally { passwordText = undefined; currentText = undefined; }
      }
      // password is re-read because the first sudo attempt needs the new value
      // even after its request JSON has been discarded.
      clearBuffer(password);
      password = this.readSecret(config, "password.input");
      await this.openBootstrapSudo(config, password);
      state = this.transition(config, state, ["needs_password"], { phase: "sudo_ready", sudoNeedsRefresh: false });
      secureUnlink(outputPath(config, "password.input"), "protected password input");
      if (current) secureUnlink(outputPath(config, "current-password.input"), "protected current-password input");
      return { action: "prepare", state: state.phase, sudo: "ready", next: "Run parle_harden_account enroll_totp with explicit confirmation." };
    } finally {
      clearBuffer(password);
      clearBuffer(current);
    }
  }

  private async refreshSudo(config: HardeningConfig): Promise<Record<string, unknown>> {
    let state = this.readState(config)!;
    this.assertBound(config, state);
    if (!state.sudoNeedsRefresh) throw new HardeningError("A sudo refresh is not required in the current hardening state.");
    const whoami = await this.whoami(config);
    if (whoami.assurance !== "unhardened") throw new HardeningError("Bootstrap sudo refresh is unavailable after hardening.");
    const proof = this.readSecret(config, "bootstrap-proof.input");
    try {
      await this.openBootstrapSudo(config, proof);
      state = this.transition(config, state, [state.phase], { sudoNeedsRefresh: false });
      secureUnlink(outputPath(config, "bootstrap-proof.input"), "protected bootstrap proof");
      return { action: "refresh_sudo", state: state.phase, sudo: "ready", next: "Resume only the named hardening transition with explicit confirmation." };
    } catch (error) {
      if (!isAmbiguous(error)) secureUnlink(outputPath(config, "bootstrap-proof.input"), "protected bootstrap proof");
      throw error;
    } finally { clearBuffer(proof); }
  }

  private async enrollTotp(config: HardeningConfig): Promise<Record<string, unknown>> {
    let state = this.readState(config)!;
    this.assertBound(config, state);
    if (!["sudo_ready", "enroll_outcome_unknown"].includes(state.phase) || state.sudoNeedsRefresh) throw new HardeningError("TOTP enrollment is not valid in the current hardening state.");
    const sink = this.openSink(config, "provisioning-uri.txt");
    let uri: string | undefined;
    try {
      const response = await this.request(config, "/v/auth/totp/enroll", "POST", {});
      if (response.status !== 200) throw new HardeningError("Parle hardening received an invalid enrollment response.");
      uri = validProvisioningUri(response.json);
      this.writeSink(config, sink, Buffer.from(uri, "utf8"));
      state = this.transition(config, state, ["sudo_ready", "enroll_outcome_unknown"], { phase: "provisioning_captured", sudoNeedsRefresh: false });
      return { action: "enroll_totp", state: state.phase, provisioningPath: outputPath(config, "provisioning-uri.txt"), next: "In a separate terminal with scrollback and recording disabled, run parle-hardening-secret show-provisioning-qr, scan it into the human authenticator, then stage a current code with parle-hardening-secret totp-code." };
    } catch (error) {
      try { this.discardSink(config, sink); } catch {}
      if (isAmbiguous(error) || error instanceof HardeningError && /invalid enrollment response|invalid provisioning response|durably capture/.test(error.message)) {
        this.transition(config, state, ["sudo_ready", "enroll_outcome_unknown"], { phase: "enroll_outcome_unknown" });
      } else if (error instanceof HardeningHttpError && error.status === 403) {
        this.transition(config, state, ["sudo_ready", "enroll_outcome_unknown"], { sudoNeedsRefresh: true });
      }
      throw error;
    } finally { uri = undefined; }
  }

  private async confirmTotp(config: HardeningConfig): Promise<Record<string, unknown>> {
    let state = this.readState(config)!;
    this.assertBound(config, state);
    if (!["provisioning_captured", "awaiting_confirmation"].includes(state.phase) || state.sudoNeedsRefresh) throw new HardeningError("TOTP confirmation is not valid in the current hardening state.");
    const code = this.readSecret(config, "totp-code.input");
    const sink = this.openSink(config, "recovery-codes.txt");
    let serverConfirmed = false;
    let sinkWritten = false;
    try {
      const response = await this.request(config, "/v/auth/totp/confirm", "POST", { code: code.toString("utf8") });
      clearBuffer(code);
      if (response.status !== 200) throw new HardeningError("Parle hardening received an invalid confirmation response.");
      serverConfirmed = true;
      const recovery = validRecoveryCodes(response.json);
      const payload = Buffer.from(recovery.join("\n") + "\n", "utf8");
      recovery.fill("");
      this.writeSink(config, sink, payload);
      sinkWritten = true;
      state = this.transition(config, state, ["provisioning_captured", "awaiting_confirmation"], { phase: "hardened_recovery_captured", recoveryCaptured: true, assuranceVerified: false });
      const whoami = await this.whoami(config);
      if (whoami.assurance !== "hardened") throw new HardeningError("Parle did not verify hardened assurance after confirmation.");
      state = this.transition(config, state, ["hardened_recovery_captured"], { assuranceVerified: true });
      secureUnlink(outputPath(config, "totp-code.input"), "protected TOTP input");
      return { action: "confirm_totp", state: state.phase, hardened: true, recoveryPath: outputPath(config, "recovery-codes.txt"), next: "Move the recovery-code batch to the human operator's protected destination, then run parle-hardening-secret ack-recovery-stored before finalizing." };
    } catch (error) {
      if (!sinkWritten) try { this.discardSink(config, sink); } catch {}
      if (serverConfirmed && !sinkWritten) {
        this.transition(config, state, ["provisioning_captured", "awaiting_confirmation"], { phase: "hardened_recovery_missing", recoveryCaptured: false, assuranceVerified: false });
        try { secureUnlink(outputPath(config, "totp-code.input"), "protected TOTP input"); } catch {}
      } else if (sinkWritten) {
        // The batch is already durably captured. Preserve it and require an
        // explicit recovery check rather than treating a whoami failure as a
        // reason to regenerate or discard it.
      } else if (isAmbiguous(error)) {
        this.transition(config, state, ["provisioning_captured", "awaiting_confirmation"], { phase: "confirm_outcome_unknown" });
        try { secureUnlink(outputPath(config, "totp-code.input"), "protected TOTP input"); } catch {}
      } else if (error instanceof HardeningHttpError && error.status === 403) {
        this.transition(config, state, ["provisioning_captured", "awaiting_confirmation"], { sudoNeedsRefresh: true });
      } else {
        try { secureUnlink(outputPath(config, "totp-code.input"), "protected TOTP input"); } catch {}
        this.transition(config, state, ["provisioning_captured", "awaiting_confirmation"], { phase: "awaiting_confirmation" });
      }
      throw error;
    } finally { clearBuffer(code); }
  }

  private async recoverConfirm(config: HardeningConfig): Promise<Record<string, unknown>> {
    let state = this.readState(config)!;
    this.assertBound(config, state);
    if (!["confirm_outcome_unknown", "hardened_recovery_missing", "recovery_regeneration_outcome_unknown", "hardened_recovery_captured"].includes(state.phase)) throw new HardeningError("Confirmation recovery is not valid in the current hardening state.");
    const whoami = await this.whoami(config);
    if (whoami.assurance === "unhardened") {
      if (state.phase !== "confirm_outcome_unknown") throw new HardeningError("Parle hardening state conflicts with unhardened assurance. Stop and reconcile manually.");
      state = this.transition(config, state, ["confirm_outcome_unknown"], { phase: "awaiting_confirmation", recoveryCaptured: false, assuranceVerified: false });
      return { action: "recover_confirm", state: state.phase, hardened: false, next: "Keep the captured provisioning URI. Stage a fresh human-only TOTP code with parle-hardening-secret totp-code, then run parle_harden_account confirm_totp with explicit confirmation." };
    }
    const existing = outputPath(config, "recovery-codes.txt");
    if (state.recoveryCaptured && existsSync(existing)) {
      assertSecureFile(existing, "protected recovery codes");
      state = this.transition(config, state, [state.phase], { phase: "hardened_recovery_captured", assuranceVerified: true });
      return { action: "recover_confirm", state: state.phase, hardened: true, recoveryPath: existing, next: "Move recovery codes to protected storage, acknowledge with parle-hardening-secret ack-recovery-stored, then finalize." };
    }
    const code = this.readSecret(config, "totp-code.input");
    const sink = this.openSink(config, "recovery-codes.txt");
    let sudoOpened = false;
    try {
      await this.openTotpSudo(config, code);
      sudoOpened = true;
      secureUnlink(outputPath(config, "totp-code.input"), "protected TOTP input");
      const response = await this.request(config, "/v/auth/recovery-codes/regenerate", "POST", {});
      if (response.status !== 200) throw new HardeningError("Parle hardening received an invalid recovery regeneration response.");
      const recovery = validRecoveryCodes(response.json);
      const payload = Buffer.from(recovery.join("\n") + "\n", "utf8");
      recovery.fill("");
      this.writeSink(config, sink, payload);
      state = this.transition(config, state, ["confirm_outcome_unknown", "hardened_recovery_missing", "recovery_regeneration_outcome_unknown", "hardened_recovery_captured"], { phase: "hardened_recovery_captured", recoveryCaptured: true, assuranceVerified: true });
      return { action: "recover_confirm", state: state.phase, hardened: true, recoveryPath: outputPath(config, "recovery-codes.txt"), next: "Only this newly captured recovery-code batch is valid. Move it to protected storage, acknowledge with parle-hardening-secret ack-recovery-stored, then finalize." };
    } catch (error) {
      try { this.discardSink(config, sink); } catch {}
      if (!isAmbiguous(error)) {
        try { secureUnlink(outputPath(config, "totp-code.input"), "protected TOTP input"); } catch {}
      }
      this.transition(config, state, ["confirm_outcome_unknown", "hardened_recovery_missing", "recovery_regeneration_outcome_unknown", "hardened_recovery_captured"], {
        phase: sudoOpened ? "recovery_regeneration_outcome_unknown" : "hardened_recovery_missing",
        recoveryCaptured: false,
        assuranceVerified: false,
      });
      throw error;
    } finally { clearBuffer(code); }
  }

  private async finalize(config: HardeningConfig): Promise<Record<string, unknown>> {
    let state = this.readState(config)!;
    this.assertBound(config, state);
    if (state.phase !== "hardened_recovery_captured" || !state.recoveryCaptured || !state.assuranceVerified) throw new HardeningError("Hardening cannot finalize until hardened assurance and durable recovery capture are verified.");
    const ack = join(ceremonyPath(config), ACK_FILE);
    assertSecureFile(ack, "recovery storage acknowledgement");
    const parsed = parseJson(readFileSync(ack, "utf8"));
    if (!parsed || typeof parsed !== "object" || (parsed as any).schemaVersion !== 1 || typeof (parsed as any).acknowledgedAt !== "string") throw new HardeningError("Recovery storage acknowledgement is invalid.");
    for (const file of SECRET_FILES) secureUnlink(outputPath(config, file), `protected hardening ${file}`);
    secureUnlink(ack, "recovery storage acknowledgement");
    state = this.transition(config, state, ["hardened_recovery_captured"], { phase: "finalized" });
    return { action: "finalize", state: state.phase, complete: true, next: "Hardening ceremony complete. The local secret copies were removed after the human acknowledgement." };
  }
}

export { HardeningError };
